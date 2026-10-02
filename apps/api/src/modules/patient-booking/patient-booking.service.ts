import type { Prisma, PrismaClient } from '@prisma/client';
import { getPrisma } from '../../db/prisma.ts';
import { getEnv } from '../../config/env.ts';
import { errors } from '../../lib/errors.ts';
import { getLogger } from '../../lib/logger.ts';
import { addMinutes, addSeconds, systemClock, type Clock } from '../../lib/clock.ts';
import { generateToken } from '../../lib/crypto.ts';
import { getIntSetting } from '../settings/settings.service.ts';
import { SETTING_KEYS } from '../settings/settings.defaults.ts';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit.service.ts';
import { assertDoctorOnDuty } from '../queue/availability.service.ts';
import { clinicRoster } from '../queue/allocation.service.ts';
import { bookableServiceRow } from '../service/service.service.ts';
import { createDirectConsultation } from './direct-consultation.ts';
import { confirmPaidAppointment } from '../appointment/appointment.service.ts';
import { transition } from '../consultation/consultation.service.ts';
import { selectModeAndEnterQueue } from '../consultation/patient-session.service.ts';

/**
 * A patient booking themselves a consultation (v2, plan phase 4).
 *
 * The counter's version of this is three screens and a QR code: the pharmacy
 * creates a consultation, takes the money, and hands the patient a token to
 * exchange. Nobody hands a patient at home anything, so this does the same
 * work in one step — and then mints exactly the session the QR exchange would
 * have minted, so everything downstream (the waiting screen, the video call,
 * the documents) is the code that already exists rather than a second copy.
 *
 * Money is still the gate. A booking is PENDING_PAYMENT until Paystack says
 * otherwise, and only then does the patient enter the queue.
 */

export interface ImmediateBookingInput {
  serviceCode: string;
  languageCode: string;
  type: 'AUDIO' | 'VIDEO';
  fullName: string;
  age: number;
  sex: 'MALE' | 'FEMALE' | 'OTHER';
  phone: string;
  reason: string;
  /** Required on a prescription by s.103 of Act 857 (D60). */
  address: string;
  /** The privacy notice the patient agreed to (D60). */
  privacyNoticeVersion: string;
}

export interface ImmediateBooking {
  consultationReference: string;
  price: { amountMinor: number; currency: string };
  paymentDeadlineAt: string;
  /** The patient session cookie value. Returned once, never stored raw. */
  sessionToken: string;
  sessionExpiresAt: Date;
}

/**
 * Creates the consultation, the patient's session, and the record of what they
 * agreed to — in one transaction, because a booking with no session is a
 * consultation nobody can reach.
 */
export async function createImmediateBooking(
  accountId: string,
  input: ImmediateBookingInput,
  context: { ip?: string; correlationId?: string },
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<ImmediateBooking> {
  const service = await bookableServiceRow(input.serviceCode, db);

  /*
   * Refused before a price is quoted, let alone charged (D50). A patient at
   * home has no counter staff to explain why nothing happened afterwards.
   */
  await assertDoctorOnDuty(db, clock, {
    discipline: service.discipline,
    rosteredFor: clinicRoster(service),
  });

  const language = await db.language.findFirst({
    where: { code: input.languageCode, isActive: true },
  });
  if (!language) throw errors.businessRule('That language is not available.');

  const windowSeconds = await getIntSetting(SETTING_KEYS.PAYMENT_WINDOW_SECONDS, db);
  const now = clock.now();
  const sessionToken = generateToken();
  const sessionExpiresAt = addMinutes(now, getEnv().PATIENT_SESSION_TIMEOUT_MINUTES);
  const paymentDeadlineAt = addSeconds(now, windowSeconds);

  const consultation = await db.$transaction((tx) =>
    createDirectConsultation(tx, {
      service,
      accountId,
      languageId: language.id,
      intake: input,
      paymentDeadlineAt,
      sessionToken,
      sessionExpiresAt,
      now,
      ip: context.ip,
    }),
  );

  await recordAudit(
    {
      action: AUDIT_ACTIONS.CONSULTATION_STATE_CHANGED,
      actorType: 'PATIENT',
      entityType: 'consultation',
      entityId: consultation.id,
      correlationId: context.correlationId,
      metadata: { to: 'PENDING_PAYMENT', channel: 'DIRECT', service: service.code },
    },
    db,
  );

  return {
    consultationReference: consultation.publicId,
    price: { amountMinor: consultation.netMinor, currency: consultation.currency },
    paymentDeadlineAt: paymentDeadlineAt.toISOString(),
    sessionToken,
    sessionExpiresAt,
  };
}

/** A booking, but only if this account owns it. */
export async function ownedBooking(
  accountId: string,
  consultationReference: string,
  db: PrismaClient = getPrisma(),
) {
  const consultation = await db.consultation.findUnique({
    where: { publicId: consultationReference },
    include: { patientSession: true, appointment: true },
  });

  // The same refusal for somebody else's booking and one that does not exist.
  if (!consultation || consultation.patientAccountId !== accountId) {
    throw errors.notFound('Consultation not found.');
  }

  return consultation;
}

/**
 * Puts a paid booking into the queue, for the patient watching the screen.
 *
 * The counter reaches the queue when the patient scans the code; there is no
 * code here, so paying is what admits them. Idempotent, because that screen
 * polls.
 *
 * This is the convenience path, not the mechanism: the same thing happens at
 * settlement and again in a sweep, because a patient who paid must reach the
 * queue whether or not their browser survived the trip back from Paystack.
 */
export async function admitPaidBooking(
  consultationReference: string,
  accountId: string,
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<boolean> {
  // Ownership first, so a reference belonging to somebody else is refused
  // before anything is read from it.
  await ownedBooking(accountId, consultationReference, db);

  return admitPaidConsultation(consultationReference, db, clock);
}

/**
 * The same admission, asked for by the server rather than by the patient (D58).
 *
 * Deliberately takes no account id: the callers are the payment settlement and
 * a sweep, neither of which is acting for a signed-in patient. Ownership is not
 * skipped so much as irrelevant here — nothing is disclosed, the consultation
 * is named by the payment that settled it, and the only effect is to put a
 * patient who paid into the queue they paid to join.
 *
 * Safe to call repeatedly and from several places at once: anything other than
 * an ACTIVATED direct booking falls straight through.
 */
export async function admitPaidConsultation(
  consultationReference: string,
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<boolean> {
  const consultation = await db.consultation.findUnique({
    where: { publicId: consultationReference },
    include: { patientSession: true, appointment: true },
  });
  if (!consultation) return false;

  if (consultation.state !== 'ACTIVATED') return false;
  if (!consultation.patientSession) return false;

  /*
   * The counter's consultations are not admitted by payment.
   *
   * A pharmacy consultation is paid for before the patient has said who they
   * are, chosen a language or scanned anything — it reaches ACTIVATED and then
   * waits for them to arrive at the counter. Queueing it here would put a
   * patient in front of a doctor before they were in front of the pharmacist.
   */
  if (!consultation.patientAccountId) return false;

  /*
   * A booking for a time next week is paid for now and waits (v2). It joins
   * the queue when its hour comes, not when the money clears, so payment
   * confirms the appointment and stops there.
   */
  if (consultation.appointment) {
    await confirmPaidAppointment(consultation.id, db, clock);
    return false;
  }

  await transition(
    consultation.id,
    'WAITING_FOR_PATIENT',
    { actorType: 'PATIENT', reason: 'direct_booking_paid' },
    db,
    clock,
  );

  await selectModeAndEnterQueue(
    {
      patientSessionId: consultation.patientSession.id,
      consultationId: consultation.id,
      consultationPublicId: consultation.publicId,
      consultationState: 'WAITING_FOR_PATIENT',
    },
    consultation.type ?? 'VIDEO',
    db,
    clock,
  );

  return true;
}

/**
 * Admits paid bookings the browser never came back for (D58).
 *
 * The fault this exists for: admission used to happen in exactly one place,
 * the status screen the patient's browser polls after Paystack. A patient whose
 * redirect failed, whose phone dropped on the way back, or who simply closed
 * the tab was charged, activated, and never queued — invisible to every doctor,
 * and to the queue's own alerts, which only look at consultations that made it
 * into the queue. Nothing expired it either: the payment window ignores it
 * because it is paid, and the unserved sweep ignores it because it has no
 * queue entry.
 *
 * So the browser is now the fast path and this is the guarantee. It also picks
 * up anything stranded before this existed, which is the only way those
 * consultations are ever getting to a doctor.
 *
 * Deliberately narrow: direct bookings only, already ACTIVATED, which means a
 * payment the server itself verified.
 */
export async function admitStrandedBookings(
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<number> {
  const stranded = await db.consultation.findMany({
    where: {
      state: 'ACTIVATED',
      // A booking the patient made themselves; the counter's own consultations
      // wait for the patient to arrive and scan.
      patientAccountId: { not: null },
      // Nothing scheduled: an appointment joins the queue at its hour.
      appointment: null,
      queueEntry: null,
    },
    select: { id: true, publicId: true },
    orderBy: { createdAt: 'asc' },
    take: 50,
  });

  let admitted = 0;

  for (const consultation of stranded) {
    try {
      if (await admitPaidConsultation(consultation.publicId, db, clock)) {
        admitted += 1;
        getLogger().warn(
          { consultationId: consultation.id },
          'admitted a paid booking whose browser never returned',
        );
      }
    } catch (error) {
      // One stuck booking must not stop the rest being rescued.
      getLogger().error(
        { err: error, consultationId: consultation.id },
        'could not admit a stranded booking',
      );
    }
  }

  return admitted;
}
