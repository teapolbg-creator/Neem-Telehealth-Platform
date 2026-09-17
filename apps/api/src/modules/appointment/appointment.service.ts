import type { PrismaClient } from '@prisma/client';
import { getPrisma, isUniqueConstraintError } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { getEnv } from '../../config/env.ts';
import { addMinutes, addSeconds, systemClock, type Clock } from '../../lib/clock.ts';
import { generatePublicId, generateToken } from '../../lib/crypto.ts';
import { getLogger } from '../../lib/logger.ts';
import { getIntSetting } from '../settings/settings.service.ts';
import { SETTING_KEYS } from '../settings/settings.defaults.ts';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit.service.ts';
import { bookableServiceRow } from '../service/service.service.ts';
import { transition } from '../consultation/consultation.service.ts';
import { selectModeAndEnterQueue } from '../consultation/patient-session.service.ts';
import { createDirectConsultation } from '../patient-booking/direct-consultation.ts';
import { slotIsOffered, slotMinutes } from './availability.service.ts';

/**
 * Appointments: a consultation at a time the patient chose (v2, plan phase 6).
 *
 * The immediate journey is a queue — pay, wait, take whoever is free. This one
 * names a person and a minute, which brings the two problems the queue never
 * had: two people can want the same minute, and somebody can hold one without
 * paying for it.
 *
 * Both are answered by the same column. `slotKey` carries the start time while
 * an appointment holds the slot, is unique per professional, and is nulled the
 * moment the appointment stops holding it. The database refuses the second
 * booking; nothing here has to check first and hope.
 *
 * The consultation exists from the moment the slot is reserved and is
 * PENDING_PAYMENT like any other, so the payment window, the sweep that
 * closes it, and the refund for a payment that lands too late are all the
 * machinery that already exists (D49).
 */

export interface AppointmentBookingInput {
  serviceCode: string;
  professionalPublicId: string;
  startsAt: Date;
  languageCode: string;
  type: 'AUDIO' | 'VIDEO';
  fullName: string;
  age: number;
  sex: 'MALE' | 'FEMALE' | 'OTHER';
  phone: string;
  reason: string;
}

export interface ReservedAppointment {
  appointmentReference: string;
  consultationReference: string;
  startsAt: string;
  endsAt: string;
  professional: { publicId: string; fullName: string };
  price: { amountMinor: number; currency: string };
  reservationExpiresAt: string;
  /** The patient session cookie value. Returned once, never stored raw. */
  sessionToken: string;
  sessionExpiresAt: Date;
}

export async function reserveAppointment(
  accountId: string,
  input: AppointmentBookingInput,
  context: { ip?: string; correlationId?: string },
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<ReservedAppointment> {
  const service = await bookableServiceRow(input.serviceCode, db);

  const professional = await db.doctor.findUnique({
    where: { publicId: input.professionalPublicId },
    select: { id: true, publicId: true, fullName: true, status: true, discipline: true },
  });
  if (!professional || professional.status !== 'ACTIVE') {
    throw errors.notFound('That professional is not available.');
  }
  if (professional.discipline !== service.discipline) {
    throw errors.businessRule('That professional does not provide this service.');
  }

  const rostered = await db.professionalService.findFirst({
    where: { doctorId: professional.id, serviceId: service.id, isActive: true },
    select: { id: true },
  });
  if (!rostered) throw errors.businessRule('That professional does not provide this service.');

  const now = clock.now();
  if (input.startsAt <= now) {
    throw errors.businessRule('That time has passed. Choose another.');
  }

  const minutes = await slotMinutes(service, db);
  if (!(await slotIsOffered(professional.id, input.startsAt, minutes, db))) {
    throw errors.businessRule('That professional does not offer that time.');
  }

  const language = await db.language.findFirst({
    where: { code: input.languageCode, isActive: true },
  });
  if (!language) throw errors.businessRule('That language is not available.');

  const windowSeconds = await getIntSetting(SETTING_KEYS.PAYMENT_WINDOW_SECONDS, db);
  const paymentDeadlineAt = addSeconds(now, windowSeconds);
  const sessionToken = generateToken();
  /*
   * The session has to outlive the wait. A patient who books on Monday for
   * Thursday must still be able to reach the consultation on Thursday, so it
   * expires after the appointment rather than after the ordinary idle window.
   */
  const endsAt = new Date(input.startsAt.getTime() + minutes * 60_000);
  const sessionExpiresAt = addMinutes(endsAt, getEnv().PATIENT_SESSION_TIMEOUT_MINUTES);

  try {
    const { appointment, consultation } = await db.$transaction(async (tx) => {
      const created = await createDirectConsultation(tx, {
        service,
        accountId,
        languageId: language.id,
        intake: input,
        paymentDeadlineAt,
        sessionToken,
        sessionExpiresAt,
        now,
        ip: context.ip,
      });

      const booked = await tx.appointment.create({
        data: {
          publicId: generatePublicId('apt'),
          doctorId: professional.id,
          serviceId: service.id,
          patientAccountId: accountId,
          consultationId: created.id,
          startsAt: input.startsAt,
          endsAt,
          // Holding the slot IS the reservation; the unique index is the lock.
          slotKey: input.startsAt.toISOString(),
          state: 'RESERVED',
          reservationExpiresAt: paymentDeadlineAt,
        },
      });

      return { appointment: booked, consultation: created };
    });

    await recordAudit(
      {
        action: AUDIT_ACTIONS.APPOINTMENT_RESERVED,
        actorType: 'PATIENT',
        entityType: 'appointment',
        entityId: appointment.id,
        correlationId: context.correlationId,
        metadata: {
          service: service.code,
          startsAt: appointment.startsAt.toISOString(),
          consultation: consultation.publicId,
        },
      },
      db,
    );

    return {
      appointmentReference: appointment.publicId,
      consultationReference: consultation.publicId,
      startsAt: appointment.startsAt.toISOString(),
      endsAt: appointment.endsAt.toISOString(),
      professional: { publicId: professional.publicId, fullName: professional.fullName },
      price: { amountMinor: consultation.netMinor, currency: consultation.currency },
      reservationExpiresAt: paymentDeadlineAt.toISOString(),
      sessionToken,
      sessionExpiresAt,
    };
  } catch (error) {
    /*
     * Somebody else got the minute. This is the whole point of the unique
     * index: the loser is told plainly rather than ending up with a second
     * appointment nobody can honour.
     */
    if (isUniqueConstraintError(error)) {
      throw errors.conflict('That time has just been taken. Please choose another.');
    }
    throw error;
  }
}

/**
 * Confirms a paid reservation.
 *
 * A confirmed appointment does NOT enter the queue — that is what separates it
 * from an immediate booking. The consultation waits, activated, until its time
 * comes round and `openDueAppointments` hands it over.
 *
 * Idempotent, because the screen the patient watches while paying polls.
 */
export async function confirmPaidAppointment(
  consultationId: string,
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<boolean> {
  const appointment = await db.appointment.findUnique({
    where: { consultationId },
    include: { consultation: { select: { state: true } } },
  });

  if (!appointment) return false;
  if (appointment.state !== 'RESERVED') return false;
  if (appointment.consultation.state !== 'ACTIVATED') return false;

  await db.appointment.update({
    where: { id: appointment.id },
    data: {
      state: 'CONFIRMED',
      // It is theirs now; nothing releases it for non-payment any more.
      reservationExpiresAt: null,
      updatedAt: clock.now(),
    },
  });

  return true;
}

/**
 * Releases the slots of reservations that were never paid for.
 *
 * It does not expire the consultation — `expirePendingPayments` does that, and
 * with it the check that asks the provider whether a late payment arrived
 * after all (D49). This sweep only lets go of the minute, and it waits for the
 * consultation to actually be gone before doing so, so a payment settled
 * seconds before the deadline never loses the slot it paid for.
 */
export async function releaseLapsedReservations(
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<number> {
  const now = clock.now();

  const lapsed = await db.appointment.findMany({
    where: {
      state: 'RESERVED',
      slotKey: { not: null },
      reservationExpiresAt: { lt: now },
      consultation: { state: { in: ['EXPIRED', 'CANCELLED', 'REFUND_REQUESTED', 'REFUNDED'] } },
    },
    select: { id: true, publicId: true },
  });

  let released = 0;

  for (const appointment of lapsed) {
    try {
      await db.appointment.update({
        where: { id: appointment.id },
        data: {
          state: 'EXPIRED',
          slotKey: null,
          releasedAt: now,
          releasedReason: 'reservation_unpaid',
        },
      });
      released += 1;
    } catch (error) {
      getLogger().warn({ err: error, appointmentId: appointment.id }, 'could not release slot');
    }
  }

  return released;
}

/**
 * Hands over appointments whose time has come.
 *
 * The patient is admitted to the queue exactly as an immediate booking is, and
 * for the same reason: everything after this — the waiting screen, the offer,
 * the call, the documents — is the machinery that already exists. What differs
 * is the pool it is offered to, which the appointment narrows to the one
 * professional the patient booked (see `offerNextDoctor`).
 */
export async function openDueAppointments(
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<number> {
  const now = clock.now();

  const due = await db.appointment.findMany({
    where: {
      state: 'CONFIRMED',
      startsAt: { lte: now },
      consultation: { state: 'ACTIVATED' },
    },
    include: {
      consultation: { select: { id: true, publicId: true, type: true } },
    },
    take: 50,
  });

  let opened = 0;

  for (const appointment of due) {
    const patientSession = await db.patientSession.findUnique({
      where: { consultationId: appointment.consultationId },
      select: { id: true },
    });
    if (!patientSession) continue;

    try {
      await transition(
        appointment.consultationId,
        'WAITING_FOR_PATIENT',
        { actorType: 'SYSTEM', reason: 'appointment_due' },
        db,
        clock,
      );

      await selectModeAndEnterQueue(
        {
          patientSessionId: patientSession.id,
          consultationId: appointment.consultationId,
          consultationPublicId: appointment.consultation.publicId,
          consultationState: 'WAITING_FOR_PATIENT',
        },
        appointment.consultation.type ?? 'VIDEO',
        db,
        clock,
      );

      await db.appointment.update({
        where: { id: appointment.id },
        data: { state: 'OPENED', openedAt: now, slotKey: null },
      });

      await recordAudit(
        {
          action: AUDIT_ACTIONS.APPOINTMENT_OPENED,
          actorType: 'SYSTEM',
          entityType: 'appointment',
          entityId: appointment.id,
          metadata: { consultation: appointment.consultation.publicId },
        },
        db,
      );

      opened += 1;
    } catch (error) {
      getLogger().warn({ err: error, appointmentId: appointment.id }, 'could not open appointment');
    }
  }

  return opened;
}

/** An appointment, but only if this account booked it. */
export async function ownedAppointment(
  accountId: string,
  reference: string,
  db: PrismaClient = getPrisma(),
) {
  const appointment = await db.appointment.findUnique({
    where: { publicId: reference },
    include: {
      consultation: { select: { publicId: true, state: true } },
      doctor: { select: { publicId: true, fullName: true } },
      service: { select: { code: true, name: true } },
    },
  });

  // The same refusal for somebody else's appointment and one that does not exist.
  if (!appointment || appointment.patientAccountId !== accountId) {
    throw errors.notFound('Appointment not found.');
  }

  return appointment;
}

export async function listAccountAppointments(
  accountId: string,
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
) {
  const rows = await db.appointment.findMany({
    where: {
      patientAccountId: accountId,
      startsAt: { gte: new Date(clock.now().getTime() - 86_400_000) },
    },
    include: {
      consultation: { select: { publicId: true, state: true } },
      doctor: { select: { publicId: true, fullName: true } },
      service: { select: { code: true, name: true } },
    },
    orderBy: { startsAt: 'asc' },
  });

  return rows.map((row) => ({
    reference: row.publicId,
    consultationReference: row.consultation.publicId,
    state: row.state,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    professional: row.doctor,
    service: row.service,
    consultationState: row.consultation.state,
  }));
}
