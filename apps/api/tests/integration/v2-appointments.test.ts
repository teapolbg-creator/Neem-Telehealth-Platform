import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getPrisma, disconnectPrisma } from '../../src/db/prisma.ts';
import { closeTestApp, request } from '../helpers/app.ts';
import { createTestDoctor, resetDatabase, setDirectChannelEnabled } from '../helpers/database.ts';
import {
  MockNotificationProvider,
  resetNotificationProviders,
  setNotificationProviderForTesting,
} from '../../src/adapters/notification/index.ts';
import {
  setPaymentProviderForTesting,
  type InitializePaymentInput,
  type InitializePaymentResult,
  type PaymentProvider,
  type RefundResult,
  type VerifiedPayment,
  type VerifiedPaymentStatus,
  type WebhookEvent,
} from '../../src/adapters/payment/index.ts';
import { expirePendingPayments } from '../../src/modules/payment/payment.service.ts';
import {
  openDueAppointments,
  releaseLapsedReservations,
} from '../../src/modules/appointment/appointment.service.ts';
import { offerNextDoctor } from '../../src/modules/queue/allocation.service.ts';
import { goOnline } from '../../src/modules/queue/presence.service.ts';
import { fixedClock } from '../../src/lib/clock.ts';

/**
 * Appointments (v2, plan phase 6).
 *
 * A queue can be fair without anybody agreeing to a time. An appointment
 * cannot: it is a promise about one minute, and the two ways to break it are
 * to promise the same minute twice, and to let somebody hold a minute they
 * never paid for. These cover both, and what happens when the money arrives
 * after the reservation has already gone.
 */

const PATIENT = 'yaa@appointments.test';
const OTHER = 'kojo@appointments.test';
const SERVICE = 'WEIGHT_LOSS_DIETITIAN';

const email = new MockNotificationProvider('EMAIL');

/** A provider whose answers this test decides. */
class ScriptedProvider implements PaymentProvider {
  readonly name = 'scripted';
  readonly isMock = true;
  status: VerifiedPaymentStatus = 'PENDING';
  private amountMinor = 0;

  async initialize(input: InitializePaymentInput): Promise<InitializePaymentResult> {
    this.amountMinor = input.amountMinor;
    return {
      providerReference: `scripted_${input.reference}`,
      authorizationUrl: 'https://checkout.example.test/appointment',
    };
  }

  async verify(providerReference: string): Promise<VerifiedPayment> {
    return {
      providerReference,
      status: this.status,
      amountMinor: this.amountMinor,
      currency: 'GHS',
      channel: 'mobile_money',
      paidAt: this.status === 'SUCCESS' ? new Date() : undefined,
    };
  }

  parseWebhook(): WebhookEvent {
    throw new Error('not used');
  }

  async refund(): Promise<RefundResult> {
    throw new Error('not used');
  }
}

let provider: ScriptedProvider;

beforeEach(async () => {
  await resetDatabase();
  await setDirectChannelEnabled(true);

  provider = new ScriptedProvider();
  setPaymentProviderForTesting(provider);

  resetNotificationProviders();
  email.clear();
  setNotificationProviderForTesting('EMAIL', email);
});

afterAll(async () => {
  setPaymentProviderForTesting(undefined);
  resetNotificationProviders();
  await closeTestApp();
  await disconnectPrisma();
});

/**
 * A dietitian who takes bookings every day of the week, rostered for the
 * weight-loss dietitian service and speaking the patient's language.
 */
async function bookableDietitian(name = 'Akosua the dietitian') {
  const prisma = getPrisma();
  const { doctor } = await createTestDoctor(name);

  const service = await prisma.service.findUniqueOrThrow({ where: { code: SERVICE } });
  const language = await prisma.language.findFirstOrThrow({ where: { code: 'en' } });

  await prisma.doctor.update({
    where: { id: doctor.id },
    data: {
      discipline: 'DIETITIAN',
      mdcNumber: null,
      credentialType: 'GAND',
      credentialNumber: `D-${doctor.publicId.slice(-4)}`,
      services: { create: { serviceId: service.id } },
      languages: { create: { languageId: language.id, isPrimary: true } },
      availability: {
        create: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
          weekday,
          startsAt: '00:00',
          endsAt: '23:30',
        })),
      },
    },
  });

  return { ...doctor, serviceId: service.id };
}

async function signedInPatient(contact: string): Promise<Record<string, string>> {
  const asked = await request('/patient/account/code', { method: 'POST', payload: { contact } });
  expect(asked.status).toBe(202);

  const body = email
    .sent()
    .filter((sent) => sent.to === contact)
    .at(-1)?.body;
  const code = /\b(\d{6})\b/.exec(body ?? '')?.[1];

  const verified = await request('/patient/account/verify', {
    method: 'POST',
    payload: { contact, code },
  });
  expect(verified.status).toBe(200);

  return verified.cookies;
}

interface Slot {
  startsAt: string;
  professional: { publicId: string };
}

async function firstSlot(cookies: Record<string, string>): Promise<Slot> {
  const slots = await request<Slot[]>(`/patient/appointments/slots?serviceCode=${SERVICE}&days=2`, {
    cookies,
  });
  expect(slots.status).toBe(200);
  expect(slots.body.data!.length).toBeGreaterThan(0);

  return slots.body.data![0]!;
}

const INTAKE = {
  serviceCode: SERVICE,
  languageCode: 'en',
  type: 'VIDEO' as const,
  fullName: 'Yaa Asantewaa',
  age: 41,
  sex: 'FEMALE' as const,
  phone: '0244000222',
  reason: 'Wants help with a weight-loss plan',
  acceptsRemoteConsultation: true as const,
  readEmergencyGuidance: true as const,
};

function book(cookies: Record<string, string>, slot: Slot) {
  return request<{
    appointmentReference: string;
    consultationReference: string;
    startsAt: string;
    price: { amountMinor: number };
  }>('/patient/appointments', {
    method: 'POST',
    cookies,
    payload: {
      ...INTAKE,
      professionalPublicId: slot.professional.publicId,
      startsAt: slot.startsAt,
    },
  });
}

/** Takes an appointment all the way to CONFIRMED. */
async function paidAppointment(cookies: Record<string, string>, slot: Slot) {
  const booked = await book(cookies, slot);
  expect(booked.status).toBe(201);

  const reference = booked.body.data!.consultationReference;
  await request(`/patient/bookings/${reference}/payment`, { method: 'POST', cookies });
  provider.status = 'SUCCESS';
  await request(`/patient/bookings/${reference}/payment`, { cookies });

  return booked.body.data!;
}

describe('reserving a slot', () => {
  it('holds it, prices it from the service, and does not charge yet', async () => {
    await bookableDietitian();
    const cookies = await signedInPatient(PATIENT);
    const slot = await firstSlot(cookies);

    const booked = await book(cookies, slot);

    expect(booked.status).toBe(201);
    // GHS 100, the seeded price of a weight-loss consultation.
    expect(booked.body.data!.price.amountMinor).toBe(10000);

    const appointment = await getPrisma().appointment.findUniqueOrThrow({
      where: { publicId: booked.body.data!.appointmentReference },
    });
    expect(appointment.state).toBe('RESERVED');
    expect(appointment.slotKey).toBe(new Date(slot.startsAt).toISOString());

    const consultation = await getPrisma().consultation.findUniqueOrThrow({
      where: { publicId: booked.body.data!.consultationReference },
    });
    expect(consultation.state).toBe('PENDING_PAYMENT');
    expect(consultation.channel).toBe('DIRECT');
  });

  it('keeps what the patient said they needed, for whoever takes the call', async () => {
    await bookableDietitian();
    const cookies = await signedInPatient(PATIENT);
    const booked = await book(cookies, await firstSlot(cookies));

    const consultation = await getPrisma().consultation.findUniqueOrThrow({
      where: { publicId: booked.body.data!.consultationReference },
    });
    const session = await getPrisma().patientSession.findUniqueOrThrow({
      where: { consultationId: consultation.id },
    });

    // Stored encrypted, like every other thing the patient told us.
    expect(session.reasonEnc).not.toBeNull();
    expect(session.reasonEnc).not.toContain('weight-loss plan');
  });

  it('refuses the same minute to a second patient', async () => {
    await bookableDietitian();
    const mine = await signedInPatient(PATIENT);
    const slot = await firstSlot(mine);

    expect((await book(mine, slot)).status).toBe(201);

    const theirs = await signedInPatient(OTHER);
    const second = await book(theirs, slot);

    expect(second.status).toBe(409);
    expect(await getPrisma().appointment.count()).toBe(1);
  });

  /**
   * The unique index, not a check-then-write.
   *
   * Two requests that overlap must not both find the slot free and both take
   * it; exactly one row can carry the slot key, so exactly one wins however
   * they interleave.
   */
  it('refuses it even when both patients ask at the same moment', async () => {
    await bookableDietitian();
    const mine = await signedInPatient(PATIENT);
    const theirs = await signedInPatient(OTHER);
    const slot = await firstSlot(mine);

    const [first, second] = await Promise.all([book(mine, slot), book(theirs, slot)]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 409]);
    expect(await getPrisma().appointment.count()).toBe(1);
  });

  it('takes the slot out of the listing once it is held', async () => {
    await bookableDietitian();
    const cookies = await signedInPatient(PATIENT);
    const slot = await firstSlot(cookies);

    await book(cookies, slot);

    const after = await request<Slot[]>(
      `/patient/appointments/slots?serviceCode=${SERVICE}&days=2`,
      { cookies },
    );
    expect(after.body.data!.some((free) => free.startsAt === slot.startsAt)).toBe(false);
  });

  it('refuses a time the professional does not offer', async () => {
    const dietitian = await bookableDietitian();
    const cookies = await signedInPatient(PATIENT);

    const slot = await firstSlot(cookies);
    await getPrisma().professionalAvailability.deleteMany({ where: { doctorId: dietitian.id } });

    expect((await book(cookies, slot)).status).toBeGreaterThanOrEqual(400);
  });

  it('is refused to a caller who is not signed in', async () => {
    await bookableDietitian();
    const cookies = await signedInPatient(PATIENT);
    const slot = await firstSlot(cookies);

    expect((await book({}, slot)).status).toBe(401);
  });
});

describe('paying for a reservation', () => {
  it('confirms the appointment without joining the queue', async () => {
    await bookableDietitian();
    const cookies = await signedInPatient(PATIENT);
    const booked = await paidAppointment(cookies, await firstSlot(cookies));

    const appointment = await getPrisma().appointment.findUniqueOrThrow({
      where: { publicId: booked.appointmentReference },
    });
    expect(appointment.state).toBe('CONFIRMED');
    // Nothing releases it for non-payment now; it is theirs.
    expect(appointment.reservationExpiresAt).toBeNull();

    const consultation = await getPrisma().consultation.findUniqueOrThrow({
      where: { publicId: booked.consultationReference },
    });
    expect(consultation.state).toBe('ACTIVATED');

    // The queue is for people waiting now. This patient is waiting for Tuesday.
    expect(
      await getPrisma().consultationQueueEntry.count({
        where: { consultationId: consultation.id },
      }),
    ).toBe(0);
  });

  it('survives the sweep that releases unpaid reservations', async () => {
    await bookableDietitian();
    const cookies = await signedInPatient(PATIENT);
    const booked = await paidAppointment(cookies, await firstSlot(cookies));

    const later = fixedClock(new Date(Date.now() + 60 * 60_000));
    await expirePendingPayments(getPrisma(), later);
    await releaseLapsedReservations(getPrisma(), later);

    const appointment = await getPrisma().appointment.findUniqueOrThrow({
      where: { publicId: booked.appointmentReference },
    });
    expect(appointment.state).toBe('CONFIRMED');
    expect(appointment.slotKey).not.toBeNull();
  });

  it('belongs to nobody else, however well they know the reference', async () => {
    await bookableDietitian();
    const mine = await signedInPatient(PATIENT);
    const booked = await book(mine, await firstSlot(mine));

    const theirs = await signedInPatient(OTHER);
    const reference = booked.body.data!.appointmentReference;

    expect((await request(`/patient/appointments/${reference}`, { cookies: theirs })).status).toBe(
      404,
    );
  });
});

describe('a reservation nobody paid for', () => {
  it('expires, and the slot goes back', async () => {
    await bookableDietitian();
    const cookies = await signedInPatient(PATIENT);
    const slot = await firstSlot(cookies);
    const booked = await book(cookies, slot);

    const later = fixedClock(new Date(Date.now() + 60 * 60_000));
    expect(await expirePendingPayments(getPrisma(), later)).toBe(1);
    expect(await releaseLapsedReservations(getPrisma(), later)).toBe(1);

    const appointment = await getPrisma().appointment.findUniqueOrThrow({
      where: { publicId: booked.body.data!.appointmentReference },
    });
    expect(appointment.state).toBe('EXPIRED');
    expect(appointment.slotKey).toBeNull();

    // And somebody else can now have the minute.
    const theirs = await signedInPatient(OTHER);
    expect((await book(theirs, slot)).status).toBe(201);
  });

  it('keeps its slot while the consultation is still alive', async () => {
    await bookableDietitian();
    const cookies = await signedInPatient(PATIENT);
    const booked = await book(cookies, await firstSlot(cookies));

    // The deadline has passed, but nothing has expired the consultation yet.
    const later = fixedClock(new Date(Date.now() + 60 * 60_000));
    expect(await releaseLapsedReservations(getPrisma(), later)).toBe(0);

    const appointment = await getPrisma().appointment.findUniqueOrThrow({
      where: { publicId: booked.body.data!.appointmentReference },
    });
    expect(appointment.state).toBe('RESERVED');
  });

  /**
   * Money that arrives after the reservation has gone.
   *
   * The sweep asks the provider before expiring anything (D49), so a payment
   * that actually succeeded settles instead of being thrown away — and the
   * patient keeps the appointment they paid for rather than losing both.
   */
  it('is honoured when the payment turns out to have succeeded', async () => {
    await bookableDietitian();
    const cookies = await signedInPatient(PATIENT);
    const booked = await book(cookies, await firstSlot(cookies));
    const reference = booked.body.data!.consultationReference;

    await request(`/patient/bookings/${reference}/payment`, { method: 'POST', cookies });
    // It succeeded at the provider; our side has not been told.
    provider.status = 'SUCCESS';

    const later = fixedClock(new Date(Date.now() + 60 * 60_000));
    expect(await expirePendingPayments(getPrisma(), later)).toBe(0);
    await releaseLapsedReservations(getPrisma(), later);

    const consultation = await getPrisma().consultation.findUniqueOrThrow({
      where: { publicId: reference },
    });
    expect(consultation.state).toBe('ACTIVATED');

    const appointment = await getPrisma().appointment.findUniqueOrThrow({
      where: { publicId: booked.body.data!.appointmentReference },
    });
    expect(appointment.slotKey).not.toBeNull();
  });
});

describe('when the time comes', () => {
  it('hands the consultation over, and only to the professional who was booked', async () => {
    const booked = await bookableDietitian();
    const other = await bookableDietitian('Kwabena the other dietitian');
    await goOnline(booked.id);
    await goOnline(other.id);

    const cookies = await signedInPatient(PATIENT);
    const slot = await firstSlot(cookies);
    const appointment = await paidAppointment(cookies, slot);

    // The hour arrives, and both dietitians are at their desks.
    const atTheTime = fixedClock(new Date(Date.parse(appointment.startsAt) + 1000));
    await getPrisma().doctorPresence.updateMany({ data: { lastHeartbeatAt: atTheTime.now() } });

    expect(await openDueAppointments(getPrisma(), atTheTime)).toBe(1);

    const consultation = await getPrisma().consultation.findUniqueOrThrow({
      where: { publicId: appointment.consultationReference },
    });
    expect(consultation.state).toBe('WAITING_FOR_DOCTOR');

    /*
     * Both are eligible, and only one was booked. Whoever else is free and
     * ranks higher is irrelevant: the patient paid for this person.
     */
    const bookedId = slot.professional.publicId === booked.publicId ? booked.id : other.id;
    const offer = await offerNextDoctor(consultation.id, getPrisma(), atTheTime);

    expect(offer.offered).toBe(true);
    expect(offer.doctorId).toBe(bookedId);
  });

  it('does not open one whose time has not come', async () => {
    await bookableDietitian();
    const cookies = await signedInPatient(PATIENT);
    await paidAppointment(cookies, await firstSlot(cookies));

    expect(await openDueAppointments()).toBe(0);
  });

  it('does not open one that was never paid for', async () => {
    await bookableDietitian();
    const cookies = await signedInPatient(PATIENT);
    const slot = await firstSlot(cookies);
    await book(cookies, slot);

    const atTheTime = fixedClock(new Date(Date.parse(slot.startsAt) + 1000));
    expect(await openDueAppointments(getPrisma(), atTheTime)).toBe(0);
  });
});
