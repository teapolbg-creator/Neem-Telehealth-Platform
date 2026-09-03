import type { ConsultationOutcome, PrismaClient } from '@prisma/client';
import { getPrisma, type Db } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit.service.ts';
import { transition } from '../consultation/consultation.service.ts';
import {
  readClinicalRecord,
  saveClinicalNotes,
  type ClinicalNotesInput,
} from '../retention/clinical-record.service.ts';
import { endMediaSession } from '../media/media.service.ts';
import { emitToConsultation, emitToPharmacy } from '../realtime/realtime.service.ts';
import { notify } from '../notification/notification.service.ts';

/**
 * The doctor's clinical workspace and consultation completion (spec §14–§17).
 *
 * Two things here are load-bearing.
 *
 * **Only the doctor completes.** No timer, no job, and no patient action ends
 * a consultation (spec §15, §16). `completeConsultation` is the sole path, and
 * it is driven by the treating doctor.
 *
 * **Completion is one transaction.** The outcome, the documents, the media
 * teardown, the sealing of the clinical record and the scheduling of its
 * destruction either all happen or none do. A consultation reported complete
 * with an unsealed record, or with a required document unissued, would be a
 * lie told by the state field.
 */

export type { ClinicalNotesInput };
export { saveClinicalNotes };

/** The workspace as the doctor sees it while the consultation is live. */
export async function readWorkspace(consultationId: string, db: Db = getPrisma()) {
  return readClinicalRecord(consultationId, db);
}

export interface CompletionInput {
  outcome: ConsultationOutcome;
  notes?: ClinicalNotesInput;
}

export interface CompletionResult {
  state: 'COMPLETED';
  consultationPublicId: string;
  durationSeconds: number;
  /** When the sealed record is destroyed (decision D23). */
  destroyAt: string | null;
  hasPrescription: boolean;
  hasReferral: boolean;
  hasSummary: boolean;
}

/**
 * Completes a consultation.
 *
 * The order below is deliberate. Everything that could refuse happens before
 * anything is written, so a completion either goes through cleanly or leaves
 * the consultation exactly as it was.
 */
export async function completeConsultation(
  consultationId: string,
  doctorId: string,
  input: CompletionInput,
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<CompletionResult> {
  const consultation = await db.consultation.findUnique({
    where: { id: consultationId },
    include: {
      prescriptions: { select: { id: true, state: true } },
      referrals: { select: { id: true } },
      summary: { select: { id: true } },
    },
  });
  if (!consultation) throw errors.notFound('Consultation not found.');

  // 404 rather than 403 — another doctor's consultation must not be confirmed
  // to exist (spec §102).
  if (consultation.doctorId !== doctorId) throw errors.notFound('Consultation not found.');

  if (consultation.state !== 'IN_PROGRESS') {
    throw errors.businessRule(
      `Only a consultation in progress can be completed. This one is ${consultation.state}.`,
    );
  }

  /**
   * An advice-only consultation must leave the patient with something
   * (decision D25).
   *
   * It is the outcome where the patient is talked out of the medicine they
   * came in for, and the one where they would otherwise walk out with no
   * evidence a doctor was ever involved — and no consultation reference.
   */
  if (input.outcome === 'ADVICE_ONLY' && !consultation.summary) {
    throw errors.businessRule(
      'Write a consultation summary before completing. An advice-only consultation must leave ' +
        'the patient with a record of what you found and advised.',
    );
  }

  if (input.outcome === 'PRESCRIPTION' && consultation.prescriptions.length === 0) {
    throw errors.businessRule(
      'This outcome says a prescription was issued, but none exists on this consultation.',
    );
  }
  if (
    (input.outcome === 'REFERRAL' || input.outcome === 'EMERGENCY_REFERRAL') &&
    consultation.referrals.length === 0
  ) {
    throw errors.businessRule(
      'This outcome says a referral was issued, but none exists on this consultation.',
    );
  }

  // A prescription still in DRAFT was never signed, so it does not exist as a
  // document. Completing over it would strand it permanently.
  const unsigned = consultation.prescriptions.filter((rx) => rx.state === 'DRAFT');
  if (unsigned.length > 0) {
    throw errors.businessRule(
      'A prescription on this consultation is still a draft. Issue it or discard it before completing.',
    );
  }

  const startedAt = consultation.startedAt ?? consultation.createdAt;
  const completedAt = clock.now();
  const durationSeconds = Math.max(
    0,
    Math.floor((completedAt.getTime() - startedAt.getTime()) / 1000),
  );

  await db.$transaction(async (tx) => {
    if (input.notes) {
      await saveClinicalNotes(consultationId, input.notes, tx, clock);
    }

    await tx.consultation.update({
      where: { id: consultationId },
      data: {
        outcome: input.outcome,
        durationSeconds,
        hasPrescription: consultation.prescriptions.length > 0,
        hasReferral: consultation.referrals.length > 0,
      },
    });

    // COMPLETING then COMPLETED, both inside the transaction, because the
    // state machine models completion as a two-step and the intermediate
    // state must never be observable as a resting place.
    await transition(
      consultationId,
      'COMPLETING',
      { actorType: 'DOCTOR', actorId: doctorId, reason: 'doctor_completed' },
      tx,
      clock,
    );

    /**
     * The terminal transition seals the clinical record and schedules its
     * destruction — see `transition()`. That is why sealing is not called
     * here: putting it at each call site is how a future completion path
     * forgets it.
     */
    await transition(
      consultationId,
      'COMPLETED',
      { actorType: 'DOCTOR', actorId: doctorId, reason: 'doctor_completed' },
      tx,
      clock,
    );
  });

  /**
   * Media teardown sits outside the transaction on purpose.
   *
   * It talks to an external provider, and a provider outage must not roll back
   * a completed consultation. The room expires on its own; the clinical record
   * and its retention schedule are what matter.
   */
  await endMediaSession(consultationId, 'consultation_completed', db, clock).catch(() => undefined);

  const retention = await db.retentionJob.findFirst({
    where: { consultationId, status: 'SCHEDULED' },
    select: { scheduledFor: true },
  });

  await recordAudit(
    {
      action: AUDIT_ACTIONS.CONSULTATION_COMPLETED,
      actorType: 'DOCTOR',
      actorId: doctorId,
      entityType: 'consultation',
      entityId: consultationId,
      // Outcome and counts. Never a word of what was found or advised.
      metadata: {
        outcome: input.outcome,
        durationSeconds,
        prescriptions: consultation.prescriptions.length,
        referrals: consultation.referrals.length,
      },
    },
    db,
  );

  emitToConsultation(consultation.publicId, 'consultation.state_changed', { state: 'COMPLETED' });
  emitToPharmacy(consultation.pharmacyId, 'consultation.completed', {
    consultationPublicId: consultation.publicId,
    outcome: input.outcome,
  });

  /**
   * The consultation reference, by SMS (decision D24).
   *
   * Neem keeps no patient profile, so this reference is the only route back to
   * their own record. The completion screen shows it, but a screen is closed
   * and forgotten — an SMS is still in the phone next month, which is when
   * someone actually needs it.
   *
   * The message says nothing about what happened. An SMS is readable by anyone
   * holding the handset, and this one has to survive that (spec §60).
   *
   * Sent after the transaction and not awaited: the consultation is complete
   * whether or not the gateway answers.
   */
  void notify({
    templateCode: 'patient.consultation.complete',
    recipient: { type: 'PATIENT', consultationId },
    variables: { consultationReference: consultation.publicId },
  });

  return {
    state: 'COMPLETED',
    consultationPublicId: consultation.publicId,
    durationSeconds,
    destroyAt: retention?.scheduledFor.toISOString() ?? null,
    hasPrescription: consultation.prescriptions.length > 0,
    hasReferral: consultation.referrals.length > 0,
    hasSummary: consultation.summary !== null,
  };
}
