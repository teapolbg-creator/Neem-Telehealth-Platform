import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getPrisma, disconnectPrisma } from '../../src/db/prisma.ts';
import { closeTestApp, request, signIn } from '../helpers/app.ts';
import { createTestUser, resetDatabase } from '../helpers/database.ts';
import {
  MockPaymentProvider,
  setPaymentProviderForTesting,
  getPaymentProvider,
} from '../../src/adapters/payment/index.ts';
import { encryptField, generatePublicId } from '../../src/lib/crypto.ts';
import { verifyAndSettle } from '../../src/modules/payment/payment.service.ts';
import { runSubscriptionExpirySweep } from '../../src/modules/subscription/subscription.service.ts';
import { MEMBERSHIP_SUSPENSION_REASON } from '../../src/modules/subscription/membership-payment.service.ts';
import { fixedClock } from '../../src/lib/clock.ts';

/**
 * Doctor membership, paid (spec §27, §34).
 *
 * The lifecycle existed from Phase 2 and nothing could pay for it. What these
 * assert is that the money follows the same rule as every other payment in
 * Neem — only a server-side verification activates anything — and that paying
 * lifts a suspension for non-payment without lifting any other kind.
 */

const DOCTOR = { email: 'doctor@membership.test', password: 'DoctorPassword123!' };

async function setUpDoctor(status: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE', statusReason?: string) {
  const prisma = getPrisma();
  const user = await createTestUser({ ...DOCTOR, role: 'DOCTOR' });

  const expiry = new Date();
  expiry.setFullYear(expiry.getFullYear() + 1);

  const doctor = await prisma.doctor.create({
    data: {
      publicId: generatePublicId('doc'),
      userId: user.id,
      fullName: 'Dr. Membership',
      mdcNumber: `MDC-MEM-${generatePublicId('x').slice(-8)}`,
      mdcExpiresAt: expiry,
      status,
      statusReason: statusReason ?? null,
      isDemo: true,
      contractedHoursPerWeek: 20,
      employmentType: 'PART_TIME',
      signatures: { create: { signatureDataEnc: encryptField('data:image/png;base64,AAAA') } },
      documents: {
        create: {
          type: 'MDC_LICENCE',
          storageKey: 'test/mdc.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 1024,
          verifiedAt: new Date(),
        },
      },
    },
  });

  return { doctor, cookies: await signIn(DOCTOR.email, DOCTOR.password) };
}

beforeEach(async () => {
  await resetDatabase();
  setPaymentProviderForTesting(new MockPaymentProvider());
});

afterAll(async () => {
  setPaymentProviderForTesting(undefined);
  await closeTestApp();
  await disconnectPrisma();
});

// ---------------------------------------------------------------------------

describe('paying for a membership', () => {
  it('initiating activates nothing (spec §34)', async () => {
    const { doctor, cookies } = await setUpDoctor();

    const started = await request<{ providerReference: string; amountMinor: number }>(
      '/doctor/membership/payment',
      { method: 'POST', cookies, payload: {} },
    );

    expect(started.status).toBe(201);
    expect(started.body.data!.amountMinor).toBeGreaterThan(0);

    // The period exists but is not active: money has not been confirmed.
    const subscription = await getPrisma().doctorSubscription.findFirstOrThrow({
      where: { doctorId: doctor.id },
    });
    expect(subscription.status).toBe('PENDING');
  });

  it('activates only once the provider confirms', async () => {
    const { doctor, cookies } = await setUpDoctor();

    const started = await request<{ providerReference: string }>('/doctor/membership/payment', {
      method: 'POST',
      cookies,
      payload: {},
    });
    const reference = started.body.data!.providerReference;

    (getPaymentProvider() as MockPaymentProvider).settle(reference, 'SUCCESS');
    await verifyAndSettle(reference, { actorType: 'SYSTEM' });

    const subscription = await getPrisma().doctorSubscription.findFirstOrThrow({
      where: { doctorId: doctor.id },
    });
    expect(subscription.status).toBe('ACTIVE');
  });

  it('creates no revenue allocation — a membership fee is not a consultation', async () => {
    const { cookies } = await setUpDoctor();

    const started = await request<{ providerReference: string }>('/doctor/membership/payment', {
      method: 'POST',
      cookies,
      payload: {},
    });
    const reference = started.body.data!.providerReference;

    (getPaymentProvider() as MockPaymentProvider).settle(reference, 'SUCCESS');
    await verifyAndSettle(reference, { actorType: 'SYSTEM' });

    // No pharmacy has a share in a doctor's membership fee.
    expect(await getPrisma().revenueAllocation.count()).toBe(0);
  });

  it('settles idempotently, so a duplicate webhook changes nothing', async () => {
    const { doctor, cookies } = await setUpDoctor();

    const started = await request<{ providerReference: string }>('/doctor/membership/payment', {
      method: 'POST',
      cookies,
      payload: {},
    });
    const reference = started.body.data!.providerReference;

    (getPaymentProvider() as MockPaymentProvider).settle(reference, 'SUCCESS');
    await verifyAndSettle(reference, { actorType: 'SYSTEM' });
    await verifyAndSettle(reference, { actorType: 'SYSTEM' });
    await verifyAndSettle(reference, { actorType: 'SYSTEM' });

    expect(await getPrisma().doctorSubscription.count({ where: { doctorId: doctor.id } })).toBe(1);
  });

  it('reuses an attempt already in flight rather than charging twice', async () => {
    const { doctor, cookies } = await setUpDoctor();

    const first = await request<{ paymentPublicId: string }>('/doctor/membership/payment', {
      method: 'POST',
      cookies,
      payload: {},
    });
    const second = await request<{ paymentPublicId: string }>('/doctor/membership/payment', {
      method: 'POST',
      cookies,
      payload: {},
    });

    expect(second.body.data!.paymentPublicId).toBe(first.body.data!.paymentPublicId);
    expect(
      await getPrisma().payment.count({ where: { doctorSubscription: { doctorId: doctor.id } } }),
    ).toBe(1);
  });

  it('refuses a rejected account — membership is maintained, not bought', async () => {
    const prisma = getPrisma();
    const { doctor, cookies } = await setUpDoctor();
    await prisma.doctor.update({ where: { id: doctor.id }, data: { status: 'REJECTED' } });

    const response = await request('/doctor/membership/payment', {
      method: 'POST',
      cookies,
      payload: {},
    });

    expect(response.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------

describe('renewal and suspension', () => {
  it('lifts a suspension that was for non-payment', async () => {
    const { doctor, cookies } = await setUpDoctor('SUSPENDED', MEMBERSHIP_SUSPENSION_REASON);

    const started = await request<{ providerReference: string }>('/doctor/membership/payment', {
      method: 'POST',
      cookies,
      payload: {},
    });
    const reference = started.body.data!.providerReference;

    (getPaymentProvider() as MockPaymentProvider).settle(reference, 'SUCCESS');
    await verifyAndSettle(reference, { actorType: 'SYSTEM' });

    const after = await getPrisma().doctor.findUniqueOrThrow({ where: { id: doctor.id } });
    expect(after.status).toBe('ACTIVE');
  });

  /**
   * The rule that matters most here.
   *
   * A doctor suspended by an administrator — for conduct, for a licence
   * problem, for anything — does not become active again by paying a fee. A
   * rule that could not tell the two apart would let money undo a decision a
   * person made.
   */
  it('does not lift a suspension imposed for any other reason', async () => {
    const { doctor, cookies } = await setUpDoctor('SUSPENDED', 'Under investigation');

    const started = await request<{ providerReference: string }>('/doctor/membership/payment', {
      method: 'POST',
      cookies,
      payload: {},
    });
    const reference = started.body.data!.providerReference;

    (getPaymentProvider() as MockPaymentProvider).settle(reference, 'SUCCESS');
    await verifyAndSettle(reference, { actorType: 'SYSTEM' });

    const after = await getPrisma().doctor.findUniqueOrThrow({ where: { id: doctor.id } });
    expect(after.status).toBe('SUSPENDED');
    expect(after.statusReason).toBe('Under investigation');

    // The membership itself is still paid for — the money is not lost.
    const subscription = await getPrisma().doctorSubscription.findFirstOrThrow({
      where: { doctorId: doctor.id },
    });
    expect(subscription.status).toBe('ACTIVE');
  });

  it('renews from the end of the current period, not from today', async () => {
    const { doctor, cookies } = await setUpDoctor();

    const first = await request<{ providerReference: string; periodEnd: string }>(
      '/doctor/membership/payment',
      { method: 'POST', cookies, payload: {} },
    );
    (getPaymentProvider() as MockPaymentProvider).settle(
      first.body.data!.providerReference,
      'SUCCESS',
    );
    await verifyAndSettle(first.body.data!.providerReference, { actorType: 'SYSTEM' });

    const second = await request<{ periodStart: string }>('/doctor/membership/payment', {
      method: 'POST',
      cookies,
      payload: {},
    });

    // Renewing early must not forfeit the time already paid for.
    expect(new Date(second.body.data!.periodStart).toISOString()).toBe(
      new Date(first.body.data!.periodEnd).toISOString(),
    );
    expect(await getPrisma().doctorSubscription.count({ where: { doctorId: doctor.id } })).toBe(2);
  });

  it('suspends a doctor whose membership lapsed past its grace period', async () => {
    const prisma = getPrisma();
    const { doctor } = await setUpDoctor();

    const longAgo = new Date('2026-01-01T00:00:00.000Z');
    await prisma.doctorSubscription.create({
      data: {
        doctorId: doctor.id,
        periodStart: new Date('2025-07-01T00:00:00.000Z'),
        periodEnd: longAgo,
        amountMinor: 50_000,
        status: 'ACTIVE',
      },
    });

    const result = await runSubscriptionExpirySweep(
      prisma,
      fixedClock(new Date('2026-06-01T00:00:00.000Z')),
    );

    expect(result.suspended).toBe(1);

    const after = await prisma.doctor.findUniqueOrThrow({ where: { id: doctor.id } });
    expect(after.status).toBe('SUSPENDED');
    expect(after.statusReason).toBe(MEMBERSHIP_SUSPENSION_REASON);
  });
});

// ---------------------------------------------------------------------------

describe('the membership view', () => {
  it('tells a doctor with no membership that one is due', async () => {
    const { cookies } = await setUpDoctor();

    const response = await request<{ status: string; renewalDue: boolean; amountMinor: number }>(
      '/doctor/membership',
      { cookies },
    );

    expect(response.body.data!.status).toBe('NONE');
    expect(response.body.data!.renewalDue).toBe(true);
    expect(response.body.data!.amountMinor).toBeGreaterThan(0);
  });

  it('is closed to a pharmacy', async () => {
    await createTestUser({
      email: 'pharmacy@membership.test',
      password: 'PharmacyPassword123!',
      role: 'PHARMACY',
    });
    const cookies = await signIn('pharmacy@membership.test', 'PharmacyPassword123!');

    expect((await request('/doctor/membership', { cookies })).status).toBe(403);
  });
});
