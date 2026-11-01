import type { ConsultationState, PrismaClient } from '@prisma/client';
import type { ChpsConsultationRequest, VisitConsultation } from '@neem/contracts';
import { getPrisma, type Db } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { getLogger } from '../../lib/logger.ts';
import { encryptField, generateConsultationReference } from '../../lib/crypto.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
import { canPharmacyCancel, isTerminal } from '../../domain/consultation-state.ts';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit.service.ts';
import { transition } from '../consultation/consultation.service.ts';
import { recordUnservedDeadline } from '../consultation/unserved.service.ts';
import { FEE_WAIVER_REASONS, waiveConsultationFee } from '../payment/fee-waiver.service.ts';
import { offerNextDoctor } from '../queue/allocation.service.ts';
import { isAnyDoctorOnDuty } from '../queue/availability.service.ts';
import { getBooleanSetting, getSetting } from '../settings/settings.service.ts';
import { SETTING_KEYS } from '../settings/settings.defaults.ts';
import type { StaffContext } from './patient.service.ts';

/**
 * A CHPS compound asking for a Neem doctor (CHPS slice 1c, D76).
 *
 * A request becomes an ordinary consultation in the ordinary queue, so a CHPS
 * patient is matched, offered, reassigned and timed out by exactly the rules a
 * counter patient is. What differs is how it starts:
 *
 *  - It is free, and nobody is paid for it through Neem (D74). The fee is
 *    waived inside the creating transaction, as for the pilot (D69).
 *  - The patient is already in the room with the CHO, so it enters the queue
 *    at once rather than waiting for a phone to scan a code.
 *  - Its patient details are copied from the facility's record into the
 *    consultation's patient session, which is what the doctor's workspace
 *    and documents read.
 *
 * And where it may not start: only from a triaged, open visit that is not on
 * the emergency path. A red patient is never queued (D74).
 */

/** States in which a request is still waiting for, or being offered to, a doctor. */
const BEFORE_A_DOCTOR: readonly ConsultationState[] = [
  'WAITING_FOR_DOCTOR',
  'ASSIGNED',
  'REASSIGNING',
];

function ageInYears(dateOfBirth: Date, now: Date): number {
  let years = now.getUTCFullYear() - dateOfBirth.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - dateOfBirth.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < dateOfBirth.getUTCDate())) {
    years -= 1;
  }
  return Math.max(years, 0);
}

/** The visit's consultation that has not ended, if there is one. */
export async function activeConsultationFor(visitId: string, db: Db) {
  const latest = await db.consultation.findFirst({
    where: { visitId },
    orderBy: { createdAt: 'desc' },
  });
  return latest && !isTerminal(latest.state) ? latest : null;
}

export async function requestConsultation(
  ctx: StaffContext,
  visitPublicId: string,
  input: ChpsConsultationRequest,
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<VisitConsultation> {
  const visit = await db.patientVisit.findUnique({
    where: { publicId: visitPublicId },
    include: {
      patient: true,
      facility: { select: { name: true, isDemo: true } },
      triages: { orderBy: { recordedAt: 'desc' }, take: 1 },
    },
  });
  if (!visit || visit.facilityId !== ctx.facilityId) throw errors.notFound('Visit not found.');

  if (visit.status === 'ESCALATED' || visit.triages[0]?.category === 'RED') {
    throw errors.businessRule(
      'This patient is on the emergency path. Follow your emergency protocol; do not wait for a remote doctor.',
    );
  }
  if (visit.status === 'AWAITING_TRIAGE' || !visit.triages[0]) {
    throw errors.businessRule('Triage the patient before requesting a doctor.');
  }
  if (visit.status !== 'TRIAGED') {
    throw errors.businessRule('This visit has ended. Open a new visit for the patient.');
  }

  const language = await db.language.findFirst({
    where: { code: input.languageCode, isActive: true },
  });
  if (!language) throw errors.businessRule('That language is not available.');

  /*
   * Refused before anything is created when nobody could take it (D50), and
   * said in words a CHO can act on: the patient is still theirs to care for.
   */
  if (
    (await getBooleanSetting(SETTING_KEYS.REQUIRE_DOCTOR_ON_DUTY, db)) &&
    !(await isAnyDoctorOnDuty(db, clock))
  ) {
    throw errors.businessRule(
      'No Neem doctor is on duty right now. Care for the patient here through your usual arrangements, or try again later.',
    );
  }

  const currency = String(await getSetting(SETTING_KEYS.CONSULTATION_CURRENCY, db));
  const now = clock.now();
  const note = input.note?.trim();

  const consultation = await db.$transaction(async (tx) => {
    // Serialise requests for one visit, so two clicks cannot make two.
    await tx.$queryRaw`SELECT id FROM patient_visits WHERE id = ${visit.id} FOR UPDATE`;
    if (await activeConsultationFor(visit.id, tx)) {
      throw errors.conflict('A doctor has already been requested for this visit.');
    }

    const created = await tx.consultation.create({
      data: {
        publicId: generateConsultationReference(),
        channel: 'CHPS',
        facilityId: visit.facilityId,
        chpsPatientId: visit.patientId,
        visitId: visit.id,
        languageId: language.id,
        type: input.type,
        state: 'PENDING_PAYMENT',
        // Nothing would have been charged, so nothing is recorded as the
        // price either (D74). Unlike the pilot, this is not a discount.
        priceMinor: 0,
        netMinor: 0,
        currency,
        feeWaivedReason: FEE_WAIVER_REASONS.CHPS_FREE,
        isDemo: visit.patient.isDemo || visit.facility.isDemo,
      },
    });

    await tx.consultationStateEvent.create({
      data: {
        consultationId: created.id,
        fromState: null,
        toState: 'PENDING_PAYMENT',
        actorType: 'FACILITY',
        actorId: ctx.userId,
        accepted: true,
      },
    });

    // The ciphertext of the name is copied as it is: same key, same field.
    await tx.patientSession.create({
      data: {
        consultationId: created.id,
        fullNameEnc: visit.patient.fullNameEnc,
        age: ageInYears(visit.patient.dateOfBirth, now),
        sex: visit.patient.sex,
        addressEnc: encryptField(visit.patient.community),
        reasonEnc: visit.presentingComplaintEnc,
      },
    });

    await waiveConsultationFee(
      {
        id: created.id,
        publicId: created.publicId,
        currency: created.currency,
        pharmacyId: null,
        isDemo: created.isDemo,
      },
      FEE_WAIVER_REASONS.CHPS_FREE,
      tx,
      clock,
    );

    // The patient is with the CHO already: straight through to the queue.
    for (const [state, reason] of [
      ['WAITING_FOR_PATIENT', 'chps_requested'],
      ['PATIENT_JOINED', 'chps_patient_present'],
      ['WAITING_FOR_DOCTOR', 'entered_queue'],
    ] as const) {
      await transition(
        created.id,
        state,
        { actorType: 'FACILITY', actorId: ctx.userId, reason },
        tx,
        clock,
      );
    }

    await tx.consultationQueueEntry.create({
      data: {
        consultationId: created.id,
        languageId: language.id,
        state: 'WAITING',
        enqueuedAt: now,
      },
    });

    return created;
  });

  await recordAudit(
    {
      action: AUDIT_ACTIONS.CONSULTATION_CREATED,
      actorType: 'FACILITY',
      actorId: ctx.userId,
      entityType: 'consultation',
      entityId: consultation.id,
      correlationId: ctx.correlationId,
      metadata: {
        channel: 'CHPS',
        triage: visit.triages[0]!.category,
        type: input.type,
        hasNote: Boolean(note),
      },
    },
    db,
  );

  // Bounded like any other consultation, so a request nobody takes ends
  // rather than waiting for ever (D61).
  await recordUnservedDeadline(consultation.id, db, clock).catch((error: unknown) =>
    getLogger().error({ err: error, consultationId: consultation.id }, 'no unserved deadline'),
  );

  // Offer it now rather than at the next sweep; the sweep still retries.
  await offerNextDoctor(consultation.id, db, clock).catch((error: unknown) =>
    getLogger().error({ err: error, consultationId: consultation.id }, 'first offer failed'),
  );

  const view = await consultationView(visit.id, db);
  return view!;
}

/**
 * Withdraws a request that no doctor has accepted yet. Once a doctor is with
 * the patient, only the doctor ends the consultation (D57).
 *
 * Not `cancelConsultation`: that raises a refund request for anything paid,
 * and a CHPS consultation was never charged.
 */
export async function cancelRequest(
  ctx: StaffContext,
  visitPublicId: string,
  reason: string,
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<VisitConsultation> {
  const visit = await db.patientVisit.findUnique({ where: { publicId: visitPublicId } });
  if (!visit || visit.facilityId !== ctx.facilityId) throw errors.notFound('Visit not found.');

  const active = await activeConsultationFor(visit.id, db);
  if (!active) throw errors.businessRule('There is no doctor request to cancel.');

  await withdraw(active.id, active.state, reason, ctx, db, clock);
  return (await consultationView(visit.id, db))!;
}

async function withdraw(
  consultationId: string,
  state: ConsultationState,
  reason: string,
  ctx: StaffContext,
  db: PrismaClient,
  clock: Clock,
) {
  if (!canPharmacyCancel(state)) {
    throw errors.businessRule(
      'A doctor is already with this patient. The doctor will end the consultation.',
    );
  }
  await db.$transaction(async (tx) => {
    await transition(
      consultationId,
      'CANCELLED',
      { actorType: 'FACILITY', actorId: ctx.userId, reason },
      tx,
      clock,
    );
  });
  await recordAudit(
    {
      action: AUDIT_ACTIONS.CONSULTATION_STATE_CHANGED,
      actorType: 'FACILITY',
      actorId: ctx.userId,
      entityType: 'consultation',
      entityId: consultationId,
      correlationId: ctx.correlationId,
      metadata: { to: 'CANCELLED', channel: 'CHPS', reason },
    },
    db,
  );
}

/**
 * Called when a visit goes down the emergency path. A request still waiting
 * for a doctor is withdrawn, because an emergency does not wait in the queue
 * (D74). One a doctor has already taken is left alone: that doctor may be the
 * help the CHO needs right now.
 */
export async function withdrawWaitingRequest(
  ctx: StaffContext,
  visitId: string,
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<void> {
  const active = await activeConsultationFor(visitId, db);
  if (active && BEFORE_A_DOCTOR.includes(active.state)) {
    await withdraw(active.id, active.state, 'escalated_to_emergency', ctx, db, clock);
  }
}

/** What the facility sees about a visit's latest consultation: its state, and who has it. */
export async function consultationView(
  visitId: string,
  db: Db = getPrisma(),
): Promise<VisitConsultation | null> {
  const latest = await db.consultation.findFirst({
    where: { visitId },
    orderBy: { createdAt: 'desc' },
    include: {
      doctor: { select: { fullName: true } },
      language: { select: { label: true } },
    },
  });
  return latest ? toConsultationView(latest) : null;
}

export function toConsultationView(row: {
  publicId: string;
  state: ConsultationState;
  type: 'AUDIO' | 'VIDEO' | 'CALL_ME' | null;
  createdAt: Date;
  doctor: { fullName: string } | null;
  language: { label: string } | null;
}): VisitConsultation {
  return {
    reference: row.publicId,
    state: row.state,
    type: row.type === 'AUDIO' ? 'AUDIO' : 'VIDEO',
    requestedAt: row.createdAt.toISOString(),
    // Named only once they have accepted; an offer may still be declined.
    doctorName: ['ASSIGNED', 'WAITING_FOR_DOCTOR', 'REASSIGNING'].includes(row.state)
      ? null
      : (row.doctor?.fullName ?? null),
    language: row.language?.label ?? null,
    active: !isTerminal(row.state),
  };
}
