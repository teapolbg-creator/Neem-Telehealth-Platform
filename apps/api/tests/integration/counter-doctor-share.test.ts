import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getPrisma, disconnectPrisma } from '../../src/db/prisma.ts';
import { closeTestApp, request, signIn } from '../helpers/app.ts';
import { createTestPharmacy, createTestUser, resetDatabase } from '../helpers/database.ts';
import {
  MockPaymentProvider,
  setPaymentProviderForTesting,
} from '../../src/adapters/payment/index.ts';
import { transition } from '../../src/modules/consultation/consultation.service.ts';
import { completeConsultation } from '../../src/modules/clinical/clinical.service.ts';
import { issueSummary } from '../../src/modules/documents/document.service.ts';
import { updateSetting } from '../../src/modules/settings/settings.service.ts';
import { SETTING_KEYS } from '../../src/modules/settings/settings.defaults.ts';
import { runSubscriptionExpirySweep } from '../../src/modules/subscription/subscription.service.ts';
import {
  initiateMembershipPayment,
  membershipView,
} from '../../src/modules/subscription/membership-payment.service.ts';
import { calculatePayroll } from '../../src/modules/doctor/payroll.service.ts';
import { collectCandidates } from '../../src/modules/queue/allocation.service.ts';
import { settlePayment } from '../../src/modules/payment/payment.service.ts';
import { encryptField, generatePublicId } from '../../src/lib/crypto.ts';

/**
 * Counter doctors paid by share instead of salary (operator's decision,
 * 2026-09-18).
 *
 * GHS 50 a consultation; the pharmacy keeps 20% of what the patient paid, as
 * it always has; the provider's fee comes off what is left; the doctor and Neem
 * split the rest evenly. From the first of October, and not a day before —
 * September is paid as salary, and paying both would pay for it twice. The
 * membership fee is dropped outright.
 */

const ADMIN_ID = 'admin-test-id';
const PHARMACY_PASSWORD = 'PharmacyPassword123!';

beforeEach(async () => {
  await resetDatabase();
  setPaymentProviderForTesting(new MockPaymentProvider());
});

afterAll(async () => {
  setPaymentProviderForTesting(undefined);
  await closeTestApp();
  await disconnectPrisma();
});

async function setting(key: (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS], value: unknown) {
  await updateSetting(key, value, { adminId: ADMIN_ID, reason: 'test' });
}

/** Earnings on, shares starting in a month that has already begun. */
async function sharesStartedAlready() {
  await setting(SETTING_KEYS.REVENUE_PROFESSIONAL_EARNINGS_ENABLED, true);
  const now = new Date();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  await setting(SETTING_KEYS.REVENUE_COUNTER_SHARE_FROM, `${now.getUTCFullYear()}-${month}-01`);
}

async function doctor() {
  const prisma = getPrisma();
  const suffix = generatePublicId('x').slice(-8).toLowerCase();
  const user = await createTestUser({
    email: `${suffix}@doctor.test`,
    password: 'DoctorPassword123!',
    role: 'DOCTOR',
  });

  return prisma.doctor.create({
    data: {
      publicId: generatePublicId('doc'),
      userId: user.id,
      fullName: 'Dr. Yaw Mensah',
      mdcNumber: `MDC-S-${suffix}`,
      status: 'ACTIVE',
      isDemo: true,
      signatures: { create: { signatureDataEnc: encryptField('data:image/png;base64,AAAA') } },
    },
  });
}

/**
 * A counter consultation paid through the real settlement path, then taken to
 * IN_PROGRESS with this doctor — so the pharmacy's share is the one the
 * settlement actually recorded, not one this test made up.
 */
async function paidCounterConsultation(doctorId: string, feeMinor: number | null) {
  const prisma = getPrisma();
  const suffix = generatePublicId('x').slice(-8).toLowerCase();

  const pharmacy = await createTestPharmacy(`Pharmacy ${suffix}`, 'ACTIVE');
  const pharmacyUser = await createTestUser({
    email: `${suffix}@pharmacy.test`,
    password: PHARMACY_PASSWORD,
    role: 'PHARMACY',
  });
  await prisma.pharmacyUser.create({ data: { pharmacyId: pharmacy.id, userId: pharmacyUser.id } });

  const cookies = await signIn(pharmacyUser.email, PHARMACY_PASSWORD);
  const created = await request<{ publicId: string }>('/pharmacy/consultations', {
    method: 'POST',
    cookies,
    payload: {},
  });
  const publicId = created.body.data!.publicId;

  await request(`/pharmacy/consultations/${publicId}/payment`, {
    method: 'POST',
    cookies,
    payload: {},
  });
  await request(`/pharmacy/consultations/${publicId}/payment/simulate`, {
    method: 'POST',
    cookies,
    payload: { outcome: 'SUCCESS' },
  });

  const consultation = await prisma.consultation.findUniqueOrThrow({ where: { publicId } });
  await prisma.payment.updateMany({
    where: { consultationId: consultation.id },
    data: { feeMinor },
  });

  await prisma.patientSession.upsert({
    where: { consultationId: consultation.id },
    update: {},
    create: {
      consultationId: consultation.id,
      fullNameEnc: encryptField('Adwoa Mensah'),
      age: 34,
      sex: 'FEMALE',
      phoneEnc: encryptField('0245551234'),
    },
  });
  await prisma.consultation.update({
    where: { id: consultation.id },
    data: { doctorId, type: 'VIDEO' },
  });

  for (const state of [
    'WAITING_FOR_PATIENT',
    'PATIENT_JOINED',
    'WAITING_FOR_DOCTOR',
    'ASSIGNED',
    'DOCTOR_ACCEPTED',
    'IN_PROGRESS',
  ] as const) {
    await transition(consultation.id, state, { actorType: 'SYSTEM', reason: 'fixture' });
  }

  return consultation;
}

async function complete(consultationId: string, doctorId: string) {
  await issueSummary(consultationId, doctorId, {
    presentingComplaint: 'Cough',
    assessment: 'Viral.',
    advice: 'Rest and fluids.',
    safetyNetting: 'Return if breathless.',
  });
  return completeConsultation(consultationId, doctorId, { outcome: 'ADVICE_ONLY' });
}

describe('a counter consultation from the cut-over', () => {
  it('pays the pharmacy 20% of the gross, takes the fee off the rest, and splits it evenly', async () => {
    await sharesStartedAlready();
    const professional = await doctor();
    const consultation = await paidCounterConsultation(professional.id, 100);

    expect(consultation.netMinor).toBe(5_000);

    await complete(consultation.id, professional.id);

    const earning = await getPrisma().professionalEarning.findUniqueOrThrow({
      where: { consultationId: consultation.id },
    });

    // GHS 50 paid; pharmacy 10; fee 1; 39 split evenly.
    expect(earning.grossMinor).toBe(5_000);
    expect(earning.pharmacyShareMinor).toBe(1_000);
    expect(earning.feeMinor).toBe(100);
    expect(earning.netMinor).toBe(3_900);
    expect(earning.professionalShareMinor).toBe(1_950);
    expect(earning.neemShareMinor).toBe(1_950);

    // Every pesewa accounted for, once.
    expect(
      earning.pharmacyShareMinor +
        earning.feeMinor +
        earning.professionalShareMinor +
        earning.neemShareMinor,
    ).toBe(earning.grossMinor);
  });

  it("uses the pharmacy's share as it was recorded at payment, not today's rate", async () => {
    await sharesStartedAlready();
    const professional = await doctor();
    const consultation = await paidCounterConsultation(professional.id, 0);

    // The rate changes between payment and completion.
    await setting(SETTING_KEYS.REVENUE_PHARMACY_BP, 3_000);
    await complete(consultation.id, professional.id);

    const earning = await getPrisma().professionalEarning.findUniqueOrThrow({
      where: { consultationId: consultation.id },
    });
    expect(earning.pharmacyShareMinor).toBe(1_000);
    expect(earning.professionalShareMinor).toBe(2_000);
  });
});

describe('a counter consultation before the cut-over', () => {
  it('earns nothing, because the salary already paid for it', async () => {
    await setting(SETTING_KEYS.REVENUE_PROFESSIONAL_EARNINGS_ENABLED, true);
    // Next month's first: today is still salaried.
    const next = new Date();
    next.setUTCMonth(next.getUTCMonth() + 1, 1);
    await setting(
      SETTING_KEYS.REVENUE_COUNTER_SHARE_FROM,
      `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-01`,
    );

    const professional = await doctor();
    const consultation = await paidCounterConsultation(professional.id, 100);
    await complete(consultation.id, professional.id);

    expect(await getPrisma().professionalEarning.count()).toBe(0);
  });
});

describe('the cut-over date', () => {
  it('must be the first of a month, because the salary it replaces is monthly', async () => {
    await expect(setting(SETTING_KEYS.REVENUE_COUNTER_SHARE_FROM, '2026-10-15')).rejects.toThrow(
      /first of a month/i,
    );
  });

  it('ends salary in payroll from its month, and not before', async () => {
    await setting(SETTING_KEYS.REVENUE_COUNTER_SHARE_FROM, '2026-10-01');
    await getPrisma().doctor.update({
      where: { id: (await doctor()).id },
      data: { contractedHoursPerWeek: 40, employmentType: 'FULL_TIME' },
    });

    // September 2026 runs from ISO week 36; October from week 40.
    const september = await calculatePayroll({ isoYear: 2026, fromIsoWeek: 36, toIsoWeek: 40 });
    expect(september.salaryEnded).toBe(false);
    expect(september.lines).toHaveLength(1);

    const october = await calculatePayroll({ isoYear: 2026, fromIsoWeek: 40, toIsoWeek: 44 });
    expect(october.salaryEnded).toBe(true);
    expect(october.lines).toHaveLength(0);
    expect(october.totalMinor).toBe(0);
  });

  it('handles a month whose first day falls in the week before', async () => {
    // 1 November 2026 is a Sunday, in ISO week 44, which is mostly October.
    await setting(SETTING_KEYS.REVENUE_COUNTER_SHARE_FROM, '2026-11-01');

    const october = await calculatePayroll({ isoYear: 2026, fromIsoWeek: 40, toIsoWeek: 44 });
    const november = await calculatePayroll({ isoYear: 2026, fromIsoWeek: 44, toIsoWeek: 49 });

    expect(october.salaryEnded).toBe(false);
    expect(november.salaryEnded).toBe(true);
  });
});

describe('a patient-direct consultation', () => {
  it('records no pharmacy share, because there is no pharmacy', async () => {
    const prisma = getPrisma();
    const service = await prisma.service.findUniqueOrThrow({
      where: { code: 'GENERAL_CONSULTATION' },
    });
    const consultation = await prisma.consultation.create({
      data: {
        publicId: generatePublicId('NEEM'),
        channel: 'DIRECT',
        serviceId: service.id,
        state: 'PAYMENT_PROCESSING',
        priceMinor: 5_000,
        netMinor: 5_000,
        currency: 'GHS',
        isDemo: true,
      },
    });
    await prisma.payment.create({
      data: {
        publicId: generatePublicId('pay'),
        consultationId: consultation.id,
        provider: 'mock',
        providerReference: 'mock_direct_split',
        amountMinor: 5_000,
        currency: 'GHS',
        status: 'PROCESSING',
        idempotencyKey: 'direct-split',
        isDemo: true,
      },
    });

    await settlePayment(
      {
        providerReference: 'mock_direct_split',
        status: 'SUCCESS',
        amountMinor: 5_000,
        currency: 'GHS',
        paidAt: new Date(),
      },
      { actorType: 'SYSTEM' },
    );

    const allocation = await prisma.revenueAllocation.findUniqueOrThrow({
      where: { consultationId: consultation.id },
    });
    expect(allocation.pharmacyShareMinor).toBe(0);
    expect(allocation.neemShareMinor).toBe(5_000);
  });
});

describe('membership, once dropped', () => {
  async function lapsedMember() {
    const professional = await doctor();
    const past = new Date(Date.now() - 60 * 86_400_000);
    await getPrisma().doctorSubscription.create({
      data: {
        doctorId: professional.id,
        periodStart: new Date(past.getTime() - 180 * 86_400_000),
        periodEnd: past,
        amountMinor: 50_000,
        status: 'ACTIVE',
      },
    });
    return professional;
  }

  it('suspends nobody for letting it lapse', async () => {
    const professional = await lapsedMember();

    await runSubscriptionExpirySweep();

    const after = await getPrisma().doctor.findUniqueOrThrow({ where: { id: professional.id } });
    expect(after.status).toBe('ACTIVE');
  });

  it('keeps nobody out of the queue', async () => {
    const professional = await lapsedMember();

    const candidates = await collectCandidates('00000000-0000-0000-0000-000000000000');
    const mine = candidates.find((candidate) => candidate.doctorId === professional.id);

    expect(mine?.subscriptionUsable).toBe(true);
  });

  it('is not sold, and the screen says why', async () => {
    const professional = await doctor();

    await expect(initiateMembershipPayment(professional.id, {})).rejects.toThrow(
      /no longer required/i,
    );

    const view = await membershipView(professional.id);
    expect(view.required).toBe(false);
    expect(view.renewalDue).toBe(false);
  });

  it('still suspends for a lapse if an administrator turns it back on', async () => {
    await setting(SETTING_KEYS.DOCTOR_MEMBERSHIP_REQUIRED, true);
    const professional = await lapsedMember();

    await runSubscriptionExpirySweep();

    const after = await getPrisma().doctor.findUniqueOrThrow({ where: { id: professional.id } });
    expect(after.status).toBe('SUSPENDED');
  });
});
