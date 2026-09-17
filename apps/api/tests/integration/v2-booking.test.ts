import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getPrisma, disconnectPrisma } from '../../src/db/prisma.ts';
import { closeTestApp, request } from '../helpers/app.ts';
import {
  createTestDoctor,
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
