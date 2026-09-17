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
import { offerNextDoctor } from '../../src/modules/queue/allocation.service.ts';
import { goOnline } from '../../src/modules/queue/presence.service.ts';

/**
 * The weight-loss clinic (v2, plan phase 8).
 *
 * Three professions, one clinic, and — by the operator's decision of
 * 2026-09-17 — three separately bookable consultations rather than a package.
 * So what has to be true is narrow and checkable: each of the three can be
 * booked and paid for on its own, each reaches its own profession, and joining
 * the clinic is something a professional does rather than something their
 * discipline does for them.
 */

const PATIENT = 'efua@clinic.test';

const email = new MockNotificationProvider('EMAIL');

class ScriptedProvider implements PaymentProvider {
  readonly name = 'scripted';
  readonly isMock = true;
  status: VerifiedPaymentStatus = 'PENDING';
  private amountMinor = 0;

  async initialize(input: InitializePaymentInput): Promise<InitializePaymentResult> {
    this.amountMinor = input.amountMinor;
    return {
      providerReference: `scripted_${input.reference}`,
      authorizationUrl: 'https://checkout.example.test/clinic',
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

/**
 * A professional on duty now, optionally signed up to a clinic service.
 *
 * Duty is a confirmed shift covering the whole day plus a heartbeat, so the
 * only thing left for a test to vary is the roster and the discipline.
 */
async function onDuty(options: {
  name: string;
  discipline: 'DOCTOR' | 'DIETITIAN' | 'TRAINER';
  serviceCode?: string;
}) {
  const prisma = getPrisma();
  const { doctor } = await createTestDoctor(options.name);
  const language = await prisma.language.findFirstOrThrow({ where: { code: 'en' } });

  const service = options.serviceCode
    ? await prisma.service.findUniqueOrThrow({ where: { code: options.serviceCode } })
    : null;

  await prisma.doctor.update({
    where: { id: doctor.id },
    data: {
      discipline: options.discipline,
      ...(options.discipline === 'DOCTOR'
        ? {}
        : {
            mdcNumber: null,
            credentialType: 'GAND',
            credentialNumber: `C-${doctor.publicId.slice(-4)}`,
          }),
      languages: { create: { languageId: language.id, isPrimary: true } },
      ...(service ? { services: { create: { serviceId: service.id } } } : {}),
    },
  });

  const allDay = await prisma.shiftDefinition.upsert({
    where: { code: 'TEST_ALL_DAY' },
    update: { isActive: true },
    create: {
      code: 'TEST_ALL_DAY',
      label: 'Test all-day shift',
      startsAt: '00:00',
      endsAt: '23:59',
      isActive: true,
    },
  });

  const now = new Date();
  await prisma.doctorShiftAssignment.create({
    data: {
      doctorId: doctor.id,
      shiftDefinitionId: allDay.id,
      serviceDate: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())),
      status: 'CONFIRMED',
      minutesPlanned: 1439,
    },
  });

  await goOnline(doctor.id);

  return doctor;
}

async function signedInPatient(): Promise<Record<string, string>> {
  const asked = await request('/patient/account/code', {
    method: 'POST',
    payload: { contact: PATIENT },
  });
  expect(asked.status).toBe(202);

  const body = email.sent().at(-1)?.body;
  const code = /\b(\d{6})\b/.exec(body ?? '')?.[1];

  const verified = await request('/patient/account/verify', {
    method: 'POST',
    payload: { contact: PATIENT, code },
  });
  expect(verified.status).toBe(200);

  return verified.cookies;
}

function book(cookies: Record<string, string>, serviceCode: string) {
  return request<{ consultationReference: string; price: { amountMinor: number } }>(
    '/patient/bookings/immediate',
    {
      method: 'POST',
      cookies,
      payload: {
        serviceCode,
        languageCode: 'en',
        type: 'VIDEO',
        fullName: 'Efua Mensah',
        age: 38,
        sex: 'FEMALE',
        phone: '0244000333',
        reason: 'Wants to lose weight before a wedding',
        acceptsRemoteConsultation: true,
        readEmergencyGuidance: true,
      },
    },
  );
}

/** Books and pays, and returns the consultation that is now in the queue. */
async function bookAndPay(cookies: Record<string, string>, serviceCode: string) {
  const booked = await book(cookies, serviceCode);
  expect(booked.status).toBe(201);

  const reference = booked.body.data!.consultationReference;
  await request(`/patient/bookings/${reference}/payment`, { method: 'POST', cookies });
  provider.status = 'SUCCESS';
  await request(`/patient/bookings/${reference}/payment`, { cookies });
  provider.status = 'PENDING';

  return {
    reference,
    priceMinor: booked.body.data!.price.amountMinor,
    consultation: await getPrisma().consultation.findUniqueOrThrow({
      where: { publicId: reference },
    }),
  };
}

interface Clinic {
  code: string;
  name: string;
  fromPrice: { amountMinor: number } | null;
  services: Array<{ code: string; discipline: string; price: { amountMinor: number } }>;
}

describe('what the patient is offered', () => {
  it('shows the clinic as one offer with three professions inside it', async () => {
    const clinics = await request<{ enabled: boolean; clinics: Clinic[] }>('/patient/clinics');

    expect(clinics.status).toBe(200);
    const weightLoss = clinics.body.data!.clinics.find((clinic) => clinic.code === 'WEIGHT_LOSS');

    expect(weightLoss?.name).toBe('Weight-loss clinic');
    expect(weightLoss?.services.map((service) => service.discipline).sort()).toEqual([
      'DIETITIAN',
      'DOCTOR',
      'TRAINER',
    ]);
    // Each is its own consultation at its own price — no package, no bundle.
    expect(weightLoss?.services.every((service) => service.price.amountMinor === 10_000)).toBe(
      true,
    );
    expect(weightLoss?.fromPrice?.amountMinor).toBe(10_000);
  });

  it('says nothing at all while the patient-direct service is switched off', async () => {
    await setDirectChannelEnabled(false);

    const clinics = await request<{ enabled: boolean; clinics: Clinic[] }>('/patient/clinics');

    expect(clinics.body.data!.enabled).toBe(false);
    expect(clinics.body.data!.clinics).toEqual([]);
  });

  it('follows the price an administrator sets', async () => {
    const prisma = getPrisma();
    await prisma.service.update({
      where: { code: 'WEIGHT_LOSS_TRAINER' },
      data: { priceMinor: 6_000 },
    });

    const clinics = await request<{ clinics: Clinic[] }>('/patient/clinics');
    const weightLoss = clinics.body.data!.clinics.find((clinic) => clinic.code === 'WEIGHT_LOSS');

    expect(weightLoss?.fromPrice?.amountMinor).toBe(6_000);
  });

  it('does not show a clinic whose services have all been withdrawn', async () => {
    await getPrisma().service.updateMany({
      where: { clinic: 'WEIGHT_LOSS' },
      data: { isActive: false },
    });

    const clinics = await request<{ clinics: Clinic[] }>('/patient/clinics');

    expect(clinics.body.data!.clinics.some((clinic) => clinic.code === 'WEIGHT_LOSS')).toBe(false);
  });
});

describe('booking each profession on its own', () => {
  const CASES = [
    { serviceCode: 'WEIGHT_LOSS_DOCTOR', discipline: 'DOCTOR' as const },
    { serviceCode: 'WEIGHT_LOSS_DIETITIAN', discipline: 'DIETITIAN' as const },
    { serviceCode: 'WEIGHT_LOSS_TRAINER', discipline: 'TRAINER' as const },
  ];

  it.each(CASES)(
    'reaches the $discipline who is in the clinic',
    async ({ serviceCode, discipline }) => {
      const professional = await onDuty({
        name: `Clinic ${discipline.toLowerCase()}`,
        discipline,
        serviceCode,
      });
      const cookies = await signedInPatient();

      const paid = await bookAndPay(cookies, serviceCode);

      expect(paid.priceMinor).toBe(10_000);
      expect(paid.consultation.state).toBe('WAITING_FOR_DOCTOR');

      const offer = await offerNextDoctor(paid.consultation.id);
      expect(offer.offered).toBe(true);
      expect(offer.doctorId).toBe(professional.id);
    },
  );

  it('can be booked three times over, once for each profession', async () => {
    for (const { serviceCode, discipline } of CASES) {
      await onDuty({ name: `Clinic ${discipline.toLowerCase()}`, discipline, serviceCode });
    }
    const cookies = await signedInPatient();

    for (const { serviceCode } of CASES) {
      const paid = await bookAndPay(cookies, serviceCode);
      expect(paid.consultation.state).toBe('WAITING_FOR_DOCTOR');
    }

    // Three consultations, three payments, three prices. Not one package.
    expect(await getPrisma().consultation.count()).toBe(3);
    expect(await getPrisma().payment.count({ where: { status: 'SUCCESS' } })).toBe(3);
  });
});

describe('joining the clinic', () => {
  it('is what decides who is offered its patients, not the discipline alone', async () => {
    // A dietitian who has not joined the weight-loss clinic.
    await onDuty({ name: 'Unenrolled dietitian', discipline: 'DIETITIAN' });
    const cookies = await signedInPatient();

    const booked = await book(cookies, 'WEIGHT_LOSS_DIETITIAN');

    // Refused before any money is taken: nobody could have served it (D50).
    expect(booked.status).toBeGreaterThanOrEqual(400);
    expect(booked.body.error?.message).toMatch(/no dietitian is on duty/i);
    expect(await getPrisma().consultation.count()).toBe(0);
  });

  it('is not required for a general consultation, which is not a clinic', async () => {
    await onDuty({ name: 'Dr. General', discipline: 'DOCTOR' });
    const cookies = await signedInPatient();

    const paid = await bookAndPay(cookies, 'GENERAL_CONSULTATION');

    expect(paid.priceMinor).toBe(5_000);
    expect((await offerNextDoctor(paid.consultation.id)).offered).toBe(true);
  });

  it('does not let a clinic doctor be offered another clinic service', async () => {
    const doctor = await onDuty({
      name: 'Clinic doctor',
      discipline: 'DOCTOR',
      serviceCode: 'WEIGHT_LOSS_DOCTOR',
    });
    // A dietitian in the clinic, so the dietitian booking is allowed to exist.
    await onDuty({
      name: 'Clinic dietitian',
      discipline: 'DIETITIAN',
      serviceCode: 'WEIGHT_LOSS_DIETITIAN',
    });

    const cookies = await signedInPatient();
    const paid = await bookAndPay(cookies, 'WEIGHT_LOSS_DIETITIAN');

    const offer = await offerNextDoctor(paid.consultation.id);
    expect(offer.doctorId).not.toBe(doctor.id);
  });
});
