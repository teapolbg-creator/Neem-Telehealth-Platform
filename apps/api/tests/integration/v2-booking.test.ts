import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getPrisma, disconnectPrisma } from '../../src/db/prisma.ts';
import { closeTestApp, request } from '../helpers/app.ts';
import { admitStrandedBookings } from '../../src/modules/patient-booking/patient-booking.service.ts';
import { verifyAndSettle } from '../../src/modules/payment/payment.service.ts';
import {
  createTestDoctor,
  createTestPharmacy,
  resetDatabase,
  setDirectChannelEnabled,
  setDoctorOnDutyRequired,
} from '../helpers/database.ts';
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

/**
 * A patient booking and paying for themselves (v2, plan phase 4).
 *
 * The counter creates a consultation, takes the money and hands over a QR
 * code. Nobody hands a patient at home anything, so the money is the only gate
 * left — and these say what it gates: nothing reaches the queue until Paystack
 * has confirmed it, and nothing is booked at all when no doctor is on duty.
 */

const PATIENT = 'ama@booking.test';
const OTHER = 'kofi@booking.test';

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
      authorizationUrl: 'https://checkout.example.test/booking',
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
  // The duty rule is production's (D50); this file books against a real rota.
  await setDoctorOnDutyRequired(true);

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

/** A doctor who is on duty now, so a booking is allowed to exist. */
async function doctorOnDuty() {
  const prisma = getPrisma();
  const { doctor } = await createTestDoctor('Dr. Direct');

  const now = new Date();
  const hour = now.getUTCHours();
  const code = hour >= 8 && hour < 14 ? 'MORNING' : hour >= 14 && hour < 20 ? 'AFTERNOON' : 'NIGHT';
  const shift = await prisma.shiftDefinition.findUniqueOrThrow({ where: { code } });

  await prisma.doctorShiftAssignment.create({
    data: {
      doctorId: doctor.id,
      shiftDefinitionId: shift.id,
      serviceDate: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())),
      status: 'CONFIRMED',
      confirmedAt: now,
      minutesPlanned: 360,
    },
  });

  return doctor;
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

const BOOKING = {
  serviceCode: 'GENERAL_CONSULTATION',
  languageCode: 'en',
  type: 'VIDEO' as const,
  fullName: 'Ama Mensah',
  age: 31,
  sex: 'FEMALE' as const,
  phone: '0244000111',
  reason: 'Persistent cough for four days',
  acceptsRemoteConsultation: true as const,
  readEmergencyGuidance: true as const,
};

function book(cookies: Record<string, string>, overrides: Record<string, unknown> = {}) {
  return request<{ consultationReference: string; price: { amountMinor: number } }>(
    '/patient/bookings/immediate',
    { method: 'POST', cookies, payload: { ...BOOKING, ...overrides } },
  );
}

describe('booking a consultation', () => {
  it('creates one that is unpaid, priced from the service, and not yet live', async () => {
    await doctorOnDuty();
    const cookies = await signedInPatient(PATIENT);

    const booked = await book(cookies);
    expect(booked.status).toBe(201);
    // GHS 50, the seeded price of a general consultation.
    expect(booked.body.data?.price.amountMinor).toBe(5000);

    const consultation = await getPrisma().consultation.findUniqueOrThrow({
      where: { publicId: booked.body.data!.consultationReference },
    });
    expect(consultation.state).toBe('PENDING_PAYMENT');
    expect(consultation.channel).toBe('DIRECT');
    expect(consultation.pharmacyId).toBeNull();

    /*
     * The booking mints the session the QR exchange would have — but an unpaid
     * consultation is not one a patient session may read, exactly as at the
     * counter, where no token exists before the money does.
     */
    const session = await request('/patient/session', { cookies: booked.cookies });
    expect(session.status).toBe(401);
  });

  it('records what the patient agreed to', async () => {
    await doctorOnDuty();
    const cookies = await signedInPatient(PATIENT);
    const booked = await book(cookies);

    const consultation = await getPrisma().consultation.findUniqueOrThrow({
      where: { publicId: booked.body.data!.consultationReference },
    });
    const consents = await getPrisma().consent.findMany({
      where: { consultationId: consultation.id },
    });

    expect(consents.map((row) => row.purpose).sort()).toEqual([
      'consultation.emergency-guidance',
      'consultation.remote',
    ]);
    expect(consents.every((row) => row.granted)).toBe(true);
  });

  it('is refused when no doctor is on duty, before any price is charged', async () => {
    const cookies = await signedInPatient(PATIENT);

    const booked = await book(cookies);

    expect(booked.status).toBeGreaterThanOrEqual(400);
    expect(booked.body.error?.message).toMatch(/no doctor is on duty/i);
    expect(await getPrisma().consultation.count()).toBe(0);
  });

  it('is refused while the patient-direct service is switched off', async () => {
    await doctorOnDuty();
    const cookies = await signedInPatient(PATIENT);
    await setDirectChannelEnabled(false);

    expect((await book(cookies)).status).toBeGreaterThanOrEqual(400);
  });

  it('is refused to a caller who is not signed in', async () => {
    await doctorOnDuty();

    expect((await book({})).status).toBe(401);
  });
});

describe('paying for it', () => {
  it('admits the patient to the queue only once the payment is confirmed', async () => {
    await doctorOnDuty();
    const cookies = await signedInPatient(PATIENT);
    const booked = await book(cookies);
    const reference = booked.body.data!.consultationReference;

    const started = await request<{ authorizationUrl: string | null }>(
      `/patient/bookings/${reference}/payment`,
      { method: 'POST', cookies },
    );
    expect(started.status).toBe(200);
    expect(started.body.data?.authorizationUrl).toContain('checkout.example.test');

    // Still unpaid: the provider has said nothing yet.
    const waiting = await request<{ state: string; joinedQueue: boolean }>(
      `/patient/bookings/${reference}/payment`,
      { cookies },
    );
    expect(waiting.body.data?.joinedQueue).toBe(false);
    expect(waiting.body.data?.state).toBe('PAYMENT_PROCESSING');

    provider.status = 'SUCCESS';
    const paid = await request<{ state: string; joinedQueue: boolean }>(
      `/patient/bookings/${reference}/payment`,
      { cookies },
    );

    expect(paid.body.data?.state).toBe('WAITING_FOR_DOCTOR');
    expect(paid.body.data?.joinedQueue).toBe(true);

    const consultation = await getPrisma().consultation.findUniqueOrThrow({
      where: { publicId: reference },
    });
    const entry = await getPrisma().consultationQueueEntry.findUnique({
      where: { consultationId: consultation.id },
    });
    expect(entry?.state).toBe('WAITING');

    // And the cookie the booking minted is now the patient's session: the
    // waiting screen, the call and the documents are the counter's own code.
    const session = await request<{ consultationPublicId: string }>('/patient/session', {
      cookies: booked.cookies,
    });
    expect(session.status).toBe(200);
    expect(session.body.data?.consultationPublicId).toBe(reference);
  });

  it('is idempotent while the patient watches the screen', async () => {
    await doctorOnDuty();
    const cookies = await signedInPatient(PATIENT);
    const reference = (await book(cookies)).body.data!.consultationReference;

    await request(`/patient/bookings/${reference}/payment`, { method: 'POST', cookies });
    provider.status = 'SUCCESS';

    await request(`/patient/bookings/${reference}/payment`, { cookies });
    const second = await request<{ state: string }>(`/patient/bookings/${reference}/payment`, {
      cookies,
    });

    expect(second.status).toBe(200);
    expect(second.body.data?.state).toBe('WAITING_FOR_DOCTOR');
  });

  it('belongs to nobody else, however well they know the reference', async () => {
    await doctorOnDuty();
    const mine = await signedInPatient(PATIENT);
    const reference = (await book(mine)).body.data!.consultationReference;

    const theirs = await signedInPatient(OTHER);

    expect(
      (
        await request(`/patient/bookings/${reference}/payment`, {
          method: 'POST',
          cookies: theirs,
        })
      ).status,
    ).toBe(404);
    expect(
      (await request(`/patient/bookings/${reference}/payment`, { cookies: theirs })).status,
    ).toBe(404);
  });
});

/*
 * Coming back to a consultation already paid for (D57).
 *
 * The session cookie is the only thing a closed browser destroys, and it is
 * not what the patient bought. These say so twice: the owner gets back in
 * with no second payment, and somebody else's reference is refused as though
 * it did not exist.
 */
/**
 * A patient who paid reaches the queue whichever way the browser goes (D58).
 *
 * Admission used to live in exactly one place: the status screen the patient's
 * browser polls on the way back from Paystack. A redirect that failed, a phone
 * that dropped, a closed tab — any of them left the patient charged, ACTIVATED
 * and outside the queue, where no doctor and no alert could see them, because
 * everything that watches the queue watches consultations that are in it.
 *
 * These exercise the paths that do not involve that screen at all.
 */
describe('reaching the queue without the browser', () => {
  it('admits a patient whose browser never came back from the checkout', async () => {
    await doctorOnDuty();
    const cookies = await signedInPatient(PATIENT);
    const booked = await book(cookies);
    const reference = booked.body.data!.consultationReference;

    await request(`/patient/bookings/${reference}/payment`, { method: 'POST', cookies });

    /*
     * The money settles and the patient is never seen again: no GET of the
     * status route, which is what the closed tab means here.
     */
    provider.status = 'SUCCESS';
    const payment = await getPrisma().payment.findFirstOrThrow({
      where: { consultation: { publicId: reference } },
    });
    await verifyAndSettle(payment.providerReference, { actorType: 'SYSTEM' });

    const consultation = await getPrisma().consultation.findUniqueOrThrow({
      where: { publicId: reference },
      include: { queueEntry: true },
    });

    expect(consultation.state).toBe('WAITING_FOR_DOCTOR');
    expect(consultation.queueEntry).not.toBeNull();
  });

  it('rescues one that was stranded before any of this existed', async () => {
    await doctorOnDuty();
    const cookies = await signedInPatient(PATIENT);
    const booked = await book(cookies);
    const reference = booked.body.data!.consultationReference;

    await request(`/patient/bookings/${reference}/payment`, { method: 'POST', cookies });
    provider.status = 'SUCCESS';
    const payment = await getPrisma().payment.findFirstOrThrow({
      where: { consultation: { publicId: reference } },
    });
    await verifyAndSettle(payment.providerReference, { actorType: 'SYSTEM' });

    /*
     * Put it back where the old code left it: paid, activated, no queue entry.
     * This is the state the consultations stranded in production are in, and
     * the sweep is the only thing that will ever move them.
     */
    const before = await getPrisma().consultation.findUniqueOrThrow({
      where: { publicId: reference },
    });
    await getPrisma().consultationQueueEntry.deleteMany({
      where: { consultationId: before.id },
    });
    await getPrisma().consultation.update({
      where: { id: before.id },
      data: { state: 'ACTIVATED' },
    });

    expect(await admitStrandedBookings()).toBe(1);

    const rescued = await getPrisma().consultation.findUniqueOrThrow({
      where: { publicId: reference },
      include: { queueEntry: true },
    });
    expect(rescued.state).toBe('WAITING_FOR_DOCTOR');
    expect(rescued.queueEntry).not.toBeNull();

    // And it does not do it twice.
    expect(await admitStrandedBookings()).toBe(0);
  });

  it('leaves the counter’s consultations alone', async () => {
    /*
     * A pharmacy consultation is paid for before the patient has said who they
     * are, chosen a language or scanned anything: it reaches ACTIVATED and
     * waits at the counter. Queueing it on payment would put a patient in
     * front of a doctor before they were in front of the pharmacist.
     */
    const pharmacy = await createTestPharmacy('Counter Pharmacy', 'ACTIVE');
    const consultation = await getPrisma().consultation.create({
      data: {
        publicId: 'con_counter_test',
        pharmacyId: pharmacy.id,
        state: 'ACTIVATED',
        netMinor: 5000,
        priceMinor: 5000,
        currency: 'GHS',
        paymentDeadlineAt: new Date(Date.now() + 600_000),
      },
    });

    expect(await admitStrandedBookings()).toBe(0);

    const untouched = await getPrisma().consultation.findUniqueOrThrow({
      where: { id: consultation.id },
      include: { queueEntry: true },
    });
    expect(untouched.state).toBe('ACTIVATED');
    expect(untouched.queueEntry).toBeNull();
  });
});

describe('rejoining', () => {
  it('lets the patient back in without asking for money again', async () => {
    await doctorOnDuty();
    const cookies = await signedInPatient(PATIENT);
    const booked = await book(cookies);
    const reference = booked.body.data!.consultationReference;

    await request(`/patient/bookings/${reference}/payment`, { method: 'POST', cookies });
    provider.status = 'SUCCESS';
    await request(`/patient/bookings/${reference}/payment`, { cookies });

    const paymentsBefore = await getPrisma().payment.count();

    // A different browser: the account cookie, and no patient session.
    const rejoined = await request<{ consultationReference: string; state: string }>(
      `/patient/bookings/${reference}/rejoin`,
      { method: 'POST', cookies },
    );

    expect(rejoined.status).toBe(200);
    expect(rejoined.body.data!.consultationReference).toBe(reference);
    // A usable session came back, which is the whole of what a rejoin is.
    expect(Object.keys(rejoined.cookies)).toContain('neem_patient');
    // And no payment was created, initiated or asked for.
    expect(await getPrisma().payment.count()).toBe(paymentsBefore);
  });

  it('refuses another account’s consultation as not found', async () => {
    await doctorOnDuty();
    const owner = await signedInPatient(PATIENT);
    const stranger = await signedInPatient(OTHER);
    const booked = await book(owner);
    const reference = booked.body.data!.consultationReference;

    const response = await request(`/patient/bookings/${reference}/rejoin`, {
      method: 'POST',
      cookies: stranger,
    });

    // 404, not 403: a stranger must not learn the consultation exists.
    expect(response.status).toBe(404);
  });
});
