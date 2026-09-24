import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getPrisma, disconnectPrisma } from '../../src/db/prisma.ts';
import { closeTestApp, request } from '../helpers/app.ts';
import { createTestPharmacy, createTestUser, resetDatabase } from '../helpers/database.ts';
import {
  MockPaymentProvider,
  setPaymentProviderForTesting,
} from '../../src/adapters/payment/index.ts';
import { transition } from '../../src/modules/consultation/consultation.service.ts';
import { completeConsultation } from '../../src/modules/clinical/clinical.service.ts';
import { earningStatement, recordEarning } from '../../src/modules/payment/earnings.service.ts';
import {
  calculateProfessionalPayouts,
  listProfessionalPayouts,
  markProfessionalPayoutPaid,
  reconcile,
} from '../../src/modules/payment/professional-payout.service.ts';
import { updateSetting } from '../../src/modules/settings/settings.service.ts';
import { SETTING_KEYS } from '../../src/modules/settings/settings.defaults.ts';
import { encryptField, generatePublicId } from '../../src/lib/crypto.ts';

/**
 * What a professional earns, and what Neem sends them (v2, plan phase 7).
 *
 * Three records that must never be collapsed into one: what the patient paid,
 * what somebody earned by doing the work, and what was actually transferred.
 * These cover the arithmetic, the refusal to run on an unconfigured split, the
 * reversal when a consultation is refunded, and the protections against paying
 * the same period twice.
 */

const ADMIN_ID = 'admin-test-id';
/** 60% to the professional. A test figure, not a business decision. */
const SHARE_BP = 6000;

beforeEach(async () => {
  await resetDatabase();
  setPaymentProviderForTesting(new MockPaymentProvider());
});

afterAll(async () => {
  setPaymentProviderForTesting(undefined);
  await closeTestApp();
  await disconnectPrisma();
});

/** The share first, then the switch — which is the order the guard demands. */
async function enableEarnings(shareBp = SHARE_BP): Promise<void> {
  await updateSetting(SETTING_KEYS.REVENUE_PROFESSIONAL_BP, shareBp, {
    adminId: ADMIN_ID,
    reason: 'test',
  });
  await updateSetting(SETTING_KEYS.REVENUE_PROFESSIONAL_EARNINGS_ENABLED, true, {
    adminId: ADMIN_ID,
    reason: 'test',
  });
}

interface Fixture {
  consultationId: string;
  consultationPublicId: string;
  doctorId: string;
  priceMinor: number;
}

/**
 * A patient-direct consultation IN_PROGRESS, paid for, with a professional.
 *
 * Built through the state machine rather than by writing columns, so the
 * earning is recorded by the same path production uses.
 */
async function liveDirectConsultation(priceMinor = 10_000): Promise<Fixture> {
  const prisma = getPrisma();
  const suffix = generatePublicId('x').slice(-8).toLowerCase();

  const user = await createTestUser({
    email: `${suffix}@professional.test`,
    password: 'ProfessionalPassword123!',
    role: 'DOCTOR',
  });

  const doctor = await prisma.doctor.create({
    data: {
      publicId: generatePublicId('doc'),
      userId: user.id,
      fullName: 'Ama the dietitian',
      discipline: 'DIETITIAN',
      mdcNumber: null,
      credentialType: 'GAND',
      credentialNumber: `D-${suffix.slice(-4)}`,
      status: 'ACTIVE',
      isDemo: true,
      signatures: { create: { signatureDataEnc: encryptField('data:image/png;base64,AAAA') } },
    },
  });

  const service = await prisma.service.findUniqueOrThrow({
    where: { code: 'WEIGHT_LOSS_DIETITIAN' },
  });
  const language = await prisma.language.findFirstOrThrow({ where: { code: 'en' } });

  const consultation = await prisma.consultation.create({
    data: {
      publicId: generatePublicId('NEEM'),
      channel: 'DIRECT',
      serviceId: service.id,
      languageId: language.id,
      doctorId: doctor.id,
      type: 'VIDEO',
      state: 'PENDING_PAYMENT',
      priceMinor,
      netMinor: priceMinor,
      currency: 'GHS',
      isDemo: true,
    },
  });

  await prisma.patientSession.create({
    data: {
      consultationId: consultation.id,
      fullNameEnc: encryptField('Adwoa Mensah'),
      age: 34,
      sex: 'FEMALE',
      phoneEnc: encryptField('0245551234'),
    },
  });

  // The payment the earning is a share of.
  await prisma.payment.create({
    data: {
      publicId: generatePublicId('pay'),
      consultationId: consultation.id,
      provider: 'mock',
      providerReference: `mock_${suffix}`,
      amountMinor: priceMinor,
      currency: 'GHS',
      status: 'SUCCESS',
      paidAt: new Date(),
      idempotencyKey: `key_${suffix}`,
      isDemo: true,
    },
  });

  for (const state of [
    'PAYMENT_PROCESSING',
    'PAID',
    'ACTIVATED',
    'WAITING_FOR_PATIENT',
    'PATIENT_JOINED',
    'WAITING_FOR_DOCTOR',
    'ASSIGNED',
    'DOCTOR_ACCEPTED',
    'IN_PROGRESS',
  ] as const) {
    await transition(consultation.id, state, { actorType: 'SYSTEM', reason: 'fixture' });
  }

  return {
    consultationId: consultation.id,
    consultationPublicId: consultation.publicId,
    doctorId: doctor.id,
    priceMinor,
  };
}

const COMPLETION = {
  outcome: 'ADVICE_ONLY' as const,
  notes: { notes: 'Talked through a meal plan.' },
};

/** The summary an advice-only completion requires (D25). */
async function completeWithSummary(fixture: Fixture) {
  const { issueSummary } = await import('../../src/modules/documents/document.service.ts');
  await issueSummary(fixture.consultationId, fixture.doctorId, {
    presentingComplaint: 'Wants to lose weight',
    assessment: 'No red flags.',
    advice: 'Three meals a day.',
    safetyNetting: 'See a doctor if you feel faint.',
  });

  return completeConsultation(fixture.consultationId, fixture.doctorId, COMPLETION);
}

describe('recording what was earned', () => {
  it('records nothing at all while earnings are switched off', async () => {
    await updateSetting(SETTING_KEYS.REVENUE_PROFESSIONAL_EARNINGS_ENABLED, false, {
      adminId: ADMIN_ID,
      reason: 'test',
    });

    const fixture = await liveDirectConsultation();

    await completeWithSummary(fixture);

    expect(await getPrisma().professionalEarning.count()).toBe(0);
  });

  it('refuses to switch earnings on before a share is set', async () => {
    // Clearing the share is allowed while nobody is earning; switching
    // earnings on afterwards is not.
    await updateSetting(SETTING_KEYS.REVENUE_PROFESSIONAL_EARNINGS_ENABLED, false, {
      adminId: ADMIN_ID,
      reason: 'test',
    });
    await updateSetting(SETTING_KEYS.REVENUE_PROFESSIONAL_BP, 0, {
      adminId: ADMIN_ID,
      reason: 'test',
    });

    await expect(
      updateSetting(SETTING_KEYS.REVENUE_PROFESSIONAL_EARNINGS_ENABLED, true, {
        adminId: ADMIN_ID,
        reason: 'test',
      }),
    ).rejects.toThrow(/share must be between/i);

    const setting = await getPrisma().systemSetting.findUniqueOrThrow({
      where: { key: SETTING_KEYS.REVENUE_PROFESSIONAL_EARNINGS_ENABLED },
    });
    expect(setting.value).toBe(false);
  });

  it('refuses to zero the share while earnings are switched on', async () => {
    await enableEarnings();

    await expect(
      updateSetting(SETTING_KEYS.REVENUE_PROFESSIONAL_BP, 0, {
        adminId: ADMIN_ID,
        reason: 'test',
      }),
    ).rejects.toThrow(/share must be between/i);
  });

  it('splits what the patient paid, and keeps the rate it used', async () => {
    await enableEarnings();
    const fixture = await liveDirectConsultation(10_000);

    await completeWithSummary(fixture);

    const earning = await getPrisma().professionalEarning.findUniqueOrThrow({
      where: { consultationId: fixture.consultationId },
    });

    expect(earning.grossMinor).toBe(10_000);
    expect(earning.professionalShareMinor).toBe(6_000);
    expect(earning.neemShareMinor).toBe(4_000);
    // The parts reconstitute the whole — no pesewa created or lost.
    expect(earning.professionalShareMinor + earning.neemShareMinor).toBe(earning.grossMinor);
    // The rate is copied in, so a change next month cannot rewrite this.
    expect(earning.professionalSharePctBp).toBe(SHARE_BP);
    expect(earning.discipline).toBe('DIETITIAN');
  });

  it('takes the provider fee off before splitting what is left', async () => {
    await enableEarnings();
    const fixture = await liveDirectConsultation(10_000);

    // Paystack charged GHS 1.95 to collect GHS 100.
    await getPrisma().payment.updateMany({
      where: { consultationId: fixture.consultationId },
      data: { feeMinor: 195 },
    });

    await completeWithSummary(fixture);

    const earning = await getPrisma().professionalEarning.findUniqueOrThrow({
      where: { consultationId: fixture.consultationId },
    });

    expect(earning.grossMinor).toBe(10_000);
    expect(earning.feeMinor).toBe(195);
    expect(earning.netMinor).toBe(9_805);
    // 60% of what was left, not 60% of the gross: both parties carry the cost
    // of collecting the money.
    expect(earning.professionalShareMinor).toBe(5_883);
    expect(earning.neemShareMinor).toBe(3_922);
    expect(earning.professionalShareMinor + earning.neemShareMinor).toBe(earning.netMinor);
  });

  it('splits the gross, visibly, when the provider reported no fee', async () => {
    await enableEarnings();
    const fixture = await liveDirectConsultation(10_000);
    await completeWithSummary(fixture);

    const earning = await getPrisma().professionalEarning.findUniqueOrThrow({
      where: { consultationId: fixture.consultationId },
    });

    // Zero, and recorded as zero — a reconciliation can see it rather than
    // having to infer that a fee was never reported.
    expect(earning.feeMinor).toBe(0);
    expect(earning.netMinor).toBe(10_000);
  });

  it('is not rewritten when the share changes afterwards', async () => {
    await enableEarnings();
    const fixture = await liveDirectConsultation(10_000);
    await completeWithSummary(fixture);

    await updateSetting(SETTING_KEYS.REVENUE_PROFESSIONAL_BP, 9000, {
      adminId: ADMIN_ID,
      reason: 'test',
    });

    const earning = await getPrisma().professionalEarning.findUniqueOrThrow({
      where: { consultationId: fixture.consultationId },
    });
    expect(earning.professionalShareMinor).toBe(6_000);
  });

  it('records one earning per consultation, however often it is asked', async () => {
    await enableEarnings();
    const fixture = await liveDirectConsultation();
    await completeWithSummary(fixture);

    // A replay, of the kind a retried job would produce.
    expect(await recordEarning(fixture.consultationId)).toBe(false);
    expect(await getPrisma().professionalEarning.count()).toBe(1);
  });

  it('records nothing for a counter consultation, which is salaried work', async () => {
    await enableEarnings();
    const fixture = await liveDirectConsultation();

    const pharmacy = await createTestPharmacy('Counter pharmacy', 'ACTIVE');
    await getPrisma().consultation.update({
      where: { id: fixture.consultationId },
      data: { channel: 'COUNTER', pharmacyId: pharmacy.id },
    });

    await completeWithSummary(fixture);

    expect(await getPrisma().professionalEarning.count()).toBe(0);
  });
});

describe('a refunded consultation', () => {
  it('reverses the earning rather than deleting it', async () => {
    await enableEarnings();
    const fixture = await liveDirectConsultation();
    await completeWithSummary(fixture);

    const { requestRefund, decideRefund } =
      await import('../../src/modules/payment/refund.service.ts');
    const refund = await requestRefund(
      fixture.consultationId,
      { reason: 'Patient asked', requestedByType: 'ADMIN', requestedByRef: ADMIN_ID },
      getPrisma(),
    );
    await decideRefund(refund.publicId, ADMIN_ID, { approve: true }, getPrisma());

    const earning = await getPrisma().professionalEarning.findUniqueOrThrow({
      where: { consultationId: fixture.consultationId },
    });
    // The row stays, so a payout already calculated from it is explainable.
    expect(earning.reversedAt).not.toBeNull();
  });

  it('is left out of the payout, not subtracted from it', async () => {
    await enableEarnings();
    const kept = await liveDirectConsultation(10_000);
    await completeWithSummary(kept);

    const reversed = await liveDirectConsultation(10_000);
    await completeWithSummary(reversed);
    await getPrisma().professionalEarning.updateMany({
      where: { consultationId: reversed.consultationId },
      data: { reversedAt: new Date() },
    });

    const period = { periodStart: new Date(), periodEnd: new Date() };
    await calculateProfessionalPayouts(period, ADMIN_ID);

    const payouts = await listProfessionalPayouts({});

    // One payout, for the professional whose consultation still stands. The
    // reversed one produced no payout at all rather than a payout of zero or
    // a deduction from somebody else's.
    expect(payouts).toHaveLength(1);
    expect(payouts[0]!.amountDueMinor).toBe(6_000);
    expect(
      await getPrisma().professionalPayout.count({ where: { doctorId: reversed.doctorId } }),
    ).toBe(0);
  });
});

describe('paying a professional', () => {
  async function earnedPeriod() {
    await enableEarnings();
    const fixture = await liveDirectConsultation(10_000);
    await completeWithSummary(fixture);

    const period = { periodStart: new Date(), periodEnd: new Date() };
    await calculateProfessionalPayouts(period, ADMIN_ID);

    return { fixture, period };
  }

  it('creates one payout per professional per period, and recalculates until it is sent', async () => {
    const { fixture, period } = await earnedPeriod();

    // A second consultation lands in the same period.
    const second = await liveDirectConsultation(10_000);
    await getPrisma().consultation.update({
      where: { id: second.consultationId },
      data: { doctorId: fixture.doctorId },
    });
    await getPrisma().professionalEarning.create({
      data: {
        consultationId: second.consultationId,
        paymentId: (
          await getPrisma().payment.findFirstOrThrow({
            where: { consultationId: second.consultationId },
          })
        ).id,
        doctorId: fixture.doctorId,
        grossMinor: 10_000,
        netMinor: 10_000,
        professionalSharePctBp: SHARE_BP,
        professionalShareMinor: 6_000,
        neemShareMinor: 4_000,
        currency: 'GHS',
        discipline: 'DIETITIAN',
      },
    });

    const again = await calculateProfessionalPayouts(period, ADMIN_ID);

    expect(again.created).toBe(0);
    expect(again.updated).toBe(1);

    const payouts = await listProfessionalPayouts({ doctorId: fixture.doctorId });
    expect(payouts).toHaveLength(1);
    expect(payouts[0]!.amountDueMinor).toBe(12_000);
  });

  it('refuses to be marked paid twice', async () => {
    const { fixture } = await earnedPeriod();
    const [payout] = await listProfessionalPayouts({ doctorId: fixture.doctorId });

    await markProfessionalPayoutPaid(payout!.publicId, ADMIN_ID, {
      paymentReference: 'MOMO-123',
    });

    await expect(
      markProfessionalPayoutPaid(payout!.publicId, ADMIN_ID, { paymentReference: 'MOMO-123' }),
    ).rejects.toThrow(/already paid/i);
  });

  it('freezes the figure once the money has been sent', async () => {
    const { fixture, period } = await earnedPeriod();
    const [payout] = await listProfessionalPayouts({ doctorId: fixture.doctorId });

    await markProfessionalPayoutPaid(payout!.publicId, ADMIN_ID, { paymentReference: 'MOMO-123' });

    // A late earning lands in a period that has already been paid.
    const late = await liveDirectConsultation(10_000);
    await getPrisma().professionalEarning.create({
      data: {
        consultationId: late.consultationId,
        paymentId: (
          await getPrisma().payment.findFirstOrThrow({
            where: { consultationId: late.consultationId },
          })
        ).id,
        doctorId: fixture.doctorId,
        grossMinor: 10_000,
        netMinor: 10_000,
        professionalSharePctBp: SHARE_BP,
        professionalShareMinor: 6_000,
        neemShareMinor: 4_000,
        currency: 'GHS',
        discipline: 'DIETITIAN',
      },
    });

    const again = await calculateProfessionalPayouts(period, ADMIN_ID);
    expect(again.frozen).toBe(1);

    const [after] = await listProfessionalPayouts({ doctorId: fixture.doctorId });
    // The amount somebody has already transferred is not rewritten underneath them.
    expect(after!.amountDueMinor).toBe(6_000);
    expect(after!.amountPaidMinor).toBe(6_000);
  });

  it('requires a reference, so a payout can be traced', async () => {
    const { fixture } = await earnedPeriod();
    const [payout] = await listProfessionalPayouts({ doctorId: fixture.doctorId });

    const marked = await markProfessionalPayoutPaid(payout!.publicId, ADMIN_ID, {
      paymentReference: 'MOMO-987',
    });

    const row = await getPrisma().professionalPayout.findUniqueOrThrow({
      where: { publicId: marked.publicId },
    });
    expect(row.paymentReference).toBe('MOMO-987');
    expect(row.markedByAdminId).toBe(ADMIN_ID);
  });
});

describe('the statement and the reconciliation', () => {
  it('totals only what was earned, and still shows what was reversed', async () => {
    await enableEarnings();
    const kept = await liveDirectConsultation(10_000);
    await completeWithSummary(kept);

    const statement = await earningStatement(kept.doctorId, {
      from: new Date(Date.now() - 86_400_000),
      to: new Date(Date.now() + 86_400_000),
    });

    expect(statement.totalMinor).toBe(6_000);
    expect(statement.consultations).toBe(1);
    expect(statement.lines[0]!.reversed).toBe(false);

    await getPrisma().professionalEarning.updateMany({
      where: { consultationId: kept.consultationId },
      data: { reversedAt: new Date() },
    });

    const after = await earningStatement(kept.doctorId, {
      from: new Date(Date.now() - 86_400_000),
      to: new Date(Date.now() + 86_400_000),
    });
    expect(after.totalMinor).toBe(0);
    // Shown, not hidden: they did the consultation and should see what happened.
    expect(after.lines).toHaveLength(1);
    expect(after.lines[0]!.reversed).toBe(true);
  });

  it('puts collected, earned and paid side by side', async () => {
    await enableEarnings();
    const fixture = await liveDirectConsultation(10_000);
    await completeWithSummary(fixture);

    const period = { periodStart: new Date(), periodEnd: new Date() };
    await calculateProfessionalPayouts(period, ADMIN_ID);

    const before = await reconcile(period);
    expect(before.collectedMinor).toBe(10_000);
    expect(before.feesMinor).toBe(0);
    expect(before.earnedMinor).toBe(6_000);
    expect(before.neemMinor).toBe(4_000);
    expect(before.paidOutMinor).toBe(0);
    // Earned but not yet sent — which is exactly what an open period looks like.
    expect(before.outstandingMinor).toBe(6_000);

    const [payout] = await listProfessionalPayouts({ doctorId: fixture.doctorId });
    await markProfessionalPayoutPaid(payout!.publicId, ADMIN_ID, { paymentReference: 'MOMO-1' });

    const after = await reconcile(period);
    expect(after.paidOutMinor).toBe(6_000);
    expect(after.outstandingMinor).toBe(0);
  });
});
