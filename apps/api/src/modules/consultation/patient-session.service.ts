import type { PrismaClient } from '@prisma/client';
import type { PatientIdentity, PatientSessionView } from '@neem/contracts';
import { getPrisma, type Db } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { encryptField, decryptNullable, encryptNullable } from '../../lib/crypto.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
import { getIntSetting } from '../settings/settings.service.ts';
import { SETTING_KEYS } from '../settings/settings.defaults.ts';
import { transition } from './consultation.service.ts';
import type { PatientPrincipal } from './access-token.service.ts';

/**
 * The temporary patient session (spec §10, §11).
 *
 * Everything here is TEMPORARY. Name and phone are encrypted at rest, and the
 * whole row is hard-deleted when the doctor completes the consultation — the
 * only carry-forward being name, age and sex copied by value onto a
 * prescription or referral (docs/data-retention.md §2).
 *
 * The purge itself lands with the completion transaction in Phase 6; this
 * module is built so that purging is a single `DELETE` of one row rather than
 * a sweep across several tables.
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
    },
  });

  const identityCaptured = Boolean(consultation.patientSession?.fullNameEnc);
  const durationSeconds = await getIntSetting(SETTING_KEYS.CONSULTATION_DURATION_SECONDS, db);

  const step: PatientSessionView['step'] = !identityCaptured
    ? 'IDENTITY'
    : !consultation.languageId
      ? 'LANGUAGE'
      : !consultation.type
        ? 'MODE'
        : consultation.state === 'IN_PROGRESS' || consultation.state === 'DOCTOR_ACCEPTED'
          ? 'IN_CONSULTATION'
          : consultation.state === 'COMPLETED' || consultation.state === 'COMPLETING'
            ? 'COMPLETE'
            : consultation.state === 'CANCELLED' ||
                consultation.state === 'EXPIRED' ||
                consultation.state === 'ABANDONED'
              ? 'CLOSED'
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
  };
}

/**
 * The four fields a pharmacy may see about the patient, and only while the
 * consultation is live (spec §18, §73).
 *
 * Returns null once the consultation has ended — the row is gone by then, and
 * this returning null rather than throwing is what lets the pharmacy screen
 * degrade gracefully after completion.
 */
export async function readPatientPanel(
  consultationId: string,
  db: Db = getPrisma(),
  options: { includePhone?: boolean } = {},
): Promise<{ fullName: string; age: number; sex: string; phone?: string } | null> {
  const session = await db.patientSession.findUnique({ where: { consultationId } });

  // Hard-deleted at completion, so absence is the signal — see the note in
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
