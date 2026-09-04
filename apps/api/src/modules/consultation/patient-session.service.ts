import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import type { PatientFeedback, PatientIdentity, PatientSessionView } from '@neem/contracts';
import { getPrisma, type Db } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import {
  encryptField,
  decryptNullable,
  encryptNullable,
  generatePublicId,
} from '../../lib/crypto.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
import { getIntSetting } from '../settings/settings.service.ts';
import { SETTING_KEYS } from '../settings/settings.defaults.ts';
import { transition } from './consultation.service.ts';
import { isTerminal } from '../../domain/consultation-state.ts';
import type { PatientPrincipal } from './access-token.service.ts';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit.service.ts';

/**
 * The patient session (spec §10, §11).
 *
 * Name and phone are encrypted at rest. Name, age and sex are copied by value
 * onto any prescription or referral issued — the only permitted carry-forward
 * (docs/data-retention.md §2).
 *
 * **Changed by decision D23.** This row was to be hard-deleted the moment the
 * doctor completed. Ghanaian record-keeping law does not permit that, so it is
 * instead sealed at completion and destroyed when the retention period
 * expires. Identity is kept *inside* the record so the record identifies
 * itself when opened; it is not an index, and nothing finds a record by
 * person — retrieval is by consultation reference (D24).
 *
 * Phase 5.5 implements the sealing and the expiry job. This module stays built
 * so that destruction is a single `DELETE` of one row rather than a sweep
 * across several tables.
 */

export async function captureIdentity(
  principal: PatientPrincipal,
  identity: PatientIdentity,
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<void> {
  if (principal.consultationState !== 'WAITING_FOR_PATIENT') {
    throw errors.businessRule('This consultation is no longer accepting patient details.');
  }

  await db.patientSession.update({
    where: { id: principal.patientSessionId },
    data: {
      fullNameEnc: encryptField(identity.fullName),
      age: identity.age,
      sex: identity.sex,
      phoneEnc: encryptField(identity.phone),
      // Recorded only when the bill was settled from a different number, and
      // deleted alongside everything else (spec §36).
      paymentPhoneEnc: encryptNullable(identity.paymentPhone ?? null),
      updatedAt: clock.now(),
    },
  });
}

export async function selectLanguage(
  principal: PatientPrincipal,
  languageCode: string,
  db: PrismaClient = getPrisma(),
): Promise<{ code: string; label: string }> {
  const language = await db.language.findFirst({
    where: { code: languageCode, isActive: true },
  });
  if (!language) {
    throw errors.validation([{ field: 'languageCode', issue: 'That language is not available' }]);
  }

  await db.consultation.update({
    where: { id: principal.consultationId },
    data: { languageId: language.id },
  });

  return { code: language.code, label: language.label };
}

/**
 * Records the consultation mode and moves the patient into the queue.
 *
 * This is the point at which the consultation becomes the queue's problem —
 * identity, language and mode are all present, so a doctor can be matched
 * (spec §29).
 */
export async function selectModeAndEnterQueue(
  principal: PatientPrincipal,
  type: 'AUDIO' | 'VIDEO' | 'CALL_ME',
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<void> {
  const consultation = await db.consultation.findUniqueOrThrow({
    where: { id: principal.consultationId },
    include: { patientSession: true },
  });

  if (!consultation.languageId) {
    throw errors.businessRule('Choose a language before selecting how to consult.');
  }
  if (!consultation.patientSession?.fullNameEnc) {
    throw errors.businessRule('Enter your details before selecting how to consult.');
  }

  await db.$transaction(async (tx) => {
    await tx.consultation.update({
      where: { id: consultation.id },
      data: { type },
    });

    if (consultation.state === 'WAITING_FOR_PATIENT') {
      await transition(
        consultation.id,
        'PATIENT_JOINED',
        { actorType: 'PATIENT', reason: 'details_complete' },
        tx,
        clock,
      );
    }

    await transition(
      consultation.id,
      'WAITING_FOR_DOCTOR',
      { actorType: 'PATIENT', reason: 'entered_queue' },
      tx,
      clock,
    );

    // The queue entry the allocation engine will consume in Phase 4.
    await tx.consultationQueueEntry.upsert({
      where: { consultationId: consultation.id },
      update: { state: 'WAITING', enqueuedAt: clock.now() },
      create: {
        consultationId: consultation.id,
        languageId: consultation.languageId!,
        state: 'WAITING',
        enqueuedAt: clock.now(),
      },
    });
  });
}

/**
 * Builds what the patient's own screen may show (spec §72).
 *
 * Deliberately omits queue position, doctor scores and any performance data.
 * The patient sees their own status, not the platform's internals.
 */
export async function buildSessionView(
  principal: PatientPrincipal,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<PatientSessionView> {
  const consultation = await db.consultation.findUniqueOrThrow({
    where: { id: principal.consultationId },
    include: {
      pharmacy: { select: { name: true } },
      language: { select: { code: true, label: true } },
      doctor: { select: { fullName: true, specialty: true } },
      patientSession: { select: { fullNameEnc: true, expiresAt: true } },
      queueEntry: { select: { enqueuedAt: true } },
      feedback: { select: { id: true } },
    },
  });

  const identityCaptured = Boolean(consultation.patientSession?.fullNameEnc);
  const durationSeconds = await getIntSetting(SETTING_KEYS.CONSULTATION_DURATION_SECONDS, db);

  /**
   * How the consultation ended outranks how far the patient got through it.
   *
   * The onboarding steps used to be tested first, so a consultation that
   * ended before the patient finished one reported that step: a consultation
   * cancelled while they were choosing a language reported LANGUAGE. That was
   * unreachable while the session died at the end of the consultation, and
   * became reachable the moment it stopped doing so — the patient would have
   * been shown a language picker for a consultation that no longer exists.
   */
  const step: PatientSessionView['step'] = isTerminal(consultation.state)
    ? consultation.state === 'COMPLETED'
      ? 'COMPLETE'
      : 'CLOSED'
    : // A consultation held for a refund decision is not a consultation in
      // progress. Without this it fell through to WAITING and the patient was
      // shown a waiting room for something that will not resume.
      consultation.state === 'REFUND_REQUESTED'
      ? 'CLOSED'
      : consultation.state === 'COMPLETING'
        ? 'COMPLETE'
        : !identityCaptured
          ? 'IDENTITY'
          : !consultation.languageId
            ? 'LANGUAGE'
            : !consultation.type
              ? 'MODE'
              : consultation.state === 'IN_PROGRESS' || consultation.state === 'DOCTOR_ACCEPTED'
                ? 'IN_CONSULTATION'
                : 'WAITING';

  const waitingSince = consultation.queueEntry?.enqueuedAt;

  return {
    consultationPublicId: consultation.publicId,
    state: consultation.state,
    step,
    pharmacyName: consultation.pharmacy.name,
    identityCaptured,
    language: consultation.language
      ? { code: consultation.language.code, label: consultation.language.label }
      : null,
    type: consultation.type,
    // The patient is told who they will see, not how that doctor was chosen.
    doctor: consultation.doctor
      ? { fullName: consultation.doctor.fullName, specialty: consultation.doctor.specialty }
      : null,
    waitingSinceSeconds: waitingSince
      ? Math.max(0, Math.floor((clock.now().getTime() - waitingSince.getTime()) / 1000))
      : null,
    consultationDurationSeconds: durationSeconds,
    expiresAt: consultation.patientSession?.expiresAt?.toISOString() ?? null,
    // So the completion screen asks once and then thanks them, rather than
    // presenting a form that will be refused.
    feedbackSubmitted: consultation.feedback !== null,
  };
}

/**
 * The four fields a pharmacy may see about the patient, and only while the
 * consultation is live (spec §18, §73).
 *
 * Returns null when the details are not available — today because the row was
 * purged, and after Phase 5.5 because a sealed record is not readable through
 * any product surface (D23). Returning null rather than throwing is what lets
 * the pharmacy screen degrade gracefully once the consultation ends, and it
 * stays correct under both models.
 */
export async function readPatientPanel(
  consultationId: string,
  db: Db = getPrisma(),
  options: { includePhone?: boolean } = {},
): Promise<{ fullName: string; age: number; sex: string; phone?: string } | null> {
  const session = await db.patientSession.findUnique({ where: { consultationId } });

  // Pre-D23: hard-deleted at completion, so absence was the signal. Phase 5.5
  // changes this to a sealed retained row; the null-check stays correct either
  // way, because a purged expired record is still absent. See the note in
  // access-token.service.ts on why there is no soft-delete flag.
  if (!session || !session.fullNameEnc || session.age === null || !session.sex) {
    return null;
  }

  return {
    fullName: decryptNullable(session.fullNameEnc) ?? '',
    age: session.age,
    sex: session.sex,
    // Off by default, and NOT included for the doctor. Call Me exists so that
    // neither party learns the other's number (spec §33); handing the doctor
    // the patient's number in a side panel would defeat it entirely. The
    // pharmacy is the exception — they captured it, with the patient present.
    ...(options.includePhone ? { phone: decryptNullable(session.phoneEnc) ?? '' } : {}),
  };
}

/**
 * Records the patient's feedback (spec §51).
 *
 * One row per consultation, guaranteed by the unique key rather than by a
 * read-then-write: on a slow connection the patient taps twice, and a
 * check-first would let both through.
 *
 * A COMPLAINT also opens a complaint for an administrator to work, so the
 * category is not merely a statistic. The category catalogue is seeded
 * reference data; if the row is missing the feedback is still recorded —
 * losing the patient's rating because an admin deleted a category would be
 * the wrong trade.
 */
export async function submitFeedback(
  principal: PatientPrincipal,
  feedback: PatientFeedback,
  db: PrismaClient = getPrisma(),
): Promise<void> {
  try {
    await db.$transaction(async (tx) => {
      const created = await tx.feedback.create({
        data: {
          consultationId: principal.consultationId,
          doctorRating: feedback.doctorRating,
          neemRating: feedback.neemRating,
          category: feedback.category,
          // Encrypted at rest like every other field the patient wrote
          // (spec §58). A comment left on a COMPLAINT is a patient
          // describing their own care, which is health information however
          // the form was labelled.
          commentEnc: encryptNullable(feedback.comment),
        },
      });

      if (feedback.category !== 'COMPLAINT') return;

      const category =
        (await tx.complaintCategory.findFirst({
          where: { isActive: true, code: feedback.complaintCategoryCode },
          select: { id: true },
        })) ??
        (await tx.complaintCategory.findFirst({
          where: { isActive: true, code: 'OTHER' },
          select: { id: true },
        }));
      if (!category) return;

      await tx.complaint.create({
        data: {
          publicId: generatePublicId('cmp'),
          feedbackId: created.id,
          consultationId: principal.consultationId,
          categoryId: category.id,
          descriptionEnc: encryptField(
            feedback.comment ?? 'The patient marked this consultation as a complaint.',
          ),
        },
      });
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw errors.conflict('Feedback has already been given for this consultation.');
    }
    throw error;
  }

  await recordAudit({
    action: AUDIT_ACTIONS.FEEDBACK_SUBMITTED,
    actorType: 'PATIENT',
    entityType: 'consultation',
    entityId: principal.consultationId,
    // Ratings and category only. The comment is the patient's words about
    // their care and does not belong in an append-only operational log.
    metadata: {
      doctorRating: feedback.doctorRating,
      neemRating: feedback.neemRating,
      category: feedback.category,
    },
  });
}
