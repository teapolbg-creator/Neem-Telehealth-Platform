import { authenticator } from 'otplib';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getPrisma, disconnectPrisma } from '../../src/db/prisma.ts';
import { closeTestApp, request, signIn } from '../helpers/app.ts';
import { createTestPharmacy, createTestUser, resetDatabase } from '../helpers/database.ts';
import { encryptTotpSecret } from '../../src/modules/auth/totp.service.ts';
import {
  MockPaymentProvider,
  setPaymentProviderForTesting,
  getPaymentProvider,
} from '../../src/adapters/payment/index.ts';
import { getTestApp } from '../helpers/app.ts';

/**
 * Payouts and the §103 critical financial test.
 *
 * The specification singles out one property above all others in this area:
 * **a duplicate webhook must not create duplicate revenue, and the split must
 * be exact and reproducible.** That is asserted here against a real database,
 * because the guarantee is a unique constraint rather than an application
 * check and only the database can be trusted to prove it.
 */

const PHARMACY = { email: 'pharmacy@payout.test', password: 'PharmacyPassword123!' };
const ADMIN = { email: 'admin@payout.test', password: 'AdminPassword123!' };

async function setUpPharmacy(name = 'Payout Pharmacy') {
  const prisma = getPrisma();
  const pharmacy = await createTestPharmacy(name, 'ACTIVE');
  const user = await createTestUser({ ...PHARMACY, role: 'PHARMACY' });
  await prisma.pharmacyUser.create({ data: { pharmacyId: pharmacy.id, userId: user.id } });

  return { pharmacy, cookies: await signIn(PHARMACY.email, PHARMACY.password) };
}

async function adminCookies() {
  const secret = authenticator.generateSecret(20);
  await createTestUser({
    ...ADMIN,
    role: 'ADMIN',
    twoFactorSecretEnc: encryptTotpSecret(secret),
    twoFactorEnabled: true,
  });

  const login = await request<{ challengeId: string }>('/auth/login', {
    method: 'POST',
    payload: ADMIN,
  });
  const verify = await request('/auth/2fa/verify', {
    method: 'POST',
    payload: { challengeId: login.body.data!.challengeId, code: authenticator.generate(secret) },
  });

  return verify.cookies;
}

async function paidConsultation(cookies: Record<string, string>) {
  const created = await request<{ publicId: string }>('/pharmacy/consultations', {
    method: 'POST',
    cookies,
    payload: {},
  });
  const publicId = created.body.data!.publicId;

  const initiated = await request<{ providerReference: string }>(
    `/pharmacy/consultations/${publicId}/payment`,
    { method: 'POST', cookies, payload: {} },
  );
  await request(`/pharmacy/consultations/${publicId}/payment/simulate`, {
    method: 'POST',
    cookies,
    payload: { outcome: 'SUCCESS' },
  });

  return { publicId, providerReference: initiated.body.data!.providerReference };
}

const today = () => new Date().toISOString().slice(0, 10);

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
// Spec §103
// ---------------------------------------------------------------------------

describe('the critical financial test (spec §103)', () => {
  it('creates no duplicate revenue when the same webhook arrives twice', async () => {
    const { cookies } = await setUpPharmacy();
    const created = await request<{ publicId: string }>('/pharmacy/consultations', {
      method: 'POST',
      cookies,
      payload: {},
    });
    const publicId = created.body.data!.publicId;

    const initiated = await request<{ providerReference: string }>(
      `/pharmacy/consultations/${publicId}/payment`,
      { method: 'POST', cookies, payload: {} },
    );
    const reference = initiated.body.data!.providerReference;

    const provider = getPaymentProvider() as MockPaymentProvider;
    provider.settle(reference, 'SUCCESS');

    const consultation = await getPrisma().consultation.findUniqueOrThrow({ where: { publicId } });

    const body = Buffer.from(
      JSON.stringify({
        id: 'evt_revenue_duplicate',
        event: 'charge.completed',
        data: {
          reference,
          status: 'success',
          amount: consultation.netMinor,
          currency: consultation.currency,
        },
      }),
    );
    const signature = provider.signWebhook(body);
    const app = await getTestApp();

    const send = () =>
      app.inject({
        method: 'POST',
        url: '/api/v1/webhooks/payment',
        headers: { 'content-type': 'application/json', 'x-neem-mock-signature': signature },
        payload: body,
      });

    await send();
    await send();
    await send();

    const allocations = await getPrisma().revenueAllocation.findMany({
      where: { consultationId: consultation.id },
    });

    // UNIQUE(paymentId) on revenue_allocations is what guarantees this. The
    // application-level "already settled" check helps, but the constraint is
    // what survives two webhooks arriving at the same instant.
    expect(allocations).toHaveLength(1);
  });

  it('splits exactly, with the remainder landing on Neem', async () => {
    const { cookies } = await setUpPharmacy();
    const { publicId } = await paidConsultation(cookies);

    const consultation = await getPrisma().consultation.findUniqueOrThrow({ where: { publicId } });
    const allocation = await getPrisma().revenueAllocation.findUniqueOrThrow({
      where: { consultationId: consultation.id },
    });

    // The invariant: the parts reconstitute the whole, exactly, in integers.
    expect(allocation.pharmacyShareMinor + allocation.neemShareMinor).toBe(allocation.netMinor);
    expect(allocation.netMinor).toBe(consultation.netMinor);
    expect(Number.isInteger(allocation.pharmacyShareMinor)).toBe(true);

    // And it is reproducible: the rate in force is stored, so recomputing it
    // later — after an admin changes the split — still yields these figures.
    const expectedPharmacy = Math.floor(
      (allocation.netMinor * allocation.pharmacySharePctBp) / 10_000,
    );
    expect(allocation.pharmacyShareMinor).toBe(expectedPharmacy);
  });

  it('stores the rate in force, so a later change cannot rewrite history', async () => {
    const { cookies } = await setUpPharmacy();
    const { publicId } = await paidConsultation(cookies);

    const consultation = await getPrisma().consultation.findUniqueOrThrow({ where: { publicId } });
    const before = await getPrisma().revenueAllocation.findUniqueOrThrow({
      where: { consultationId: consultation.id },
    });

    await getPrisma().systemSetting.updateMany({
      where: { key: 'revenue.pharmacy_share_bp' },
      data: { value: '5000' },
    });

    const after = await getPrisma().revenueAllocation.findUniqueOrThrow({
      where: { consultationId: consultation.id },
    });

    expect(after.pharmacySharePctBp).toBe(before.pharmacySharePctBp);
    expect(after.pharmacyShareMinor).toBe(before.pharmacyShareMinor);
  });
});

// ---------------------------------------------------------------------------

describe('calculating payouts', () => {
  it('totals a pharmacy’s share for the period', async () => {
    const { cookies, pharmacy } = await setUpPharmacy();
    await paidConsultation(cookies);
    await paidConsultation(cookies);

    const admin = await adminCookies();
    const calculated = await request<{ created: number }>('/admin/payouts/calculate', {
      method: 'POST',
      cookies: admin,
      payload: { periodStart: today(), periodEnd: today() },
    });

    expect(calculated.status).toBe(200);
    expect(calculated.body.data?.created).toBe(1);

    const payout = await getPrisma().pharmacyPayout.findFirstOrThrow({
      where: { pharmacyId: pharmacy.id },
    });
    const allocations = await getPrisma().revenueAllocation.findMany({
      where: { consultation: { pharmacyId: pharmacy.id } },
    });

    expect(payout.amountDueMinor).toBe(
      allocations.reduce((sum, row) => sum + row.pharmacyShareMinor, 0),
    );
  });

  it('excludes a refunded consultation rather than netting it off', async () => {
    const { cookies, pharmacy } = await setUpPharmacy();
    const first = await paidConsultation(cookies);
    await paidConsultation(cookies);

    const consultation = await getPrisma().consultation.findUniqueOrThrow({
      where: { publicId: first.publicId },
    });
    await getPrisma().revenueAllocation.updateMany({
      where: { consultationId: consultation.id },
      data: { reversedAt: new Date() },
    });

    const admin = await adminCookies();
    await request('/admin/payouts/calculate', {
      method: 'POST',
      cookies: admin,
      payload: { periodStart: today(), periodEnd: today() },
    });

    const payout = await getPrisma().pharmacyPayout.findFirstOrThrow({
      where: { pharmacyId: pharmacy.id },
    });
    const remaining = await getPrisma().revenueAllocation.findMany({
      where: { consultation: { pharmacyId: pharmacy.id }, reversedAt: null },
    });

    expect(payout.amountDueMinor).toBe(
      remaining.reduce((sum, row) => sum + row.pharmacyShareMinor, 0),
    );
  });

  it('updates a pending payout when re-run', async () => {
    const { cookies, pharmacy } = await setUpPharmacy();
    await paidConsultation(cookies);

    const admin = await adminCookies();
    const period = { periodStart: today(), periodEnd: today() };
    await request('/admin/payouts/calculate', { method: 'POST', cookies: admin, payload: period });

    const before = await getPrisma().pharmacyPayout.findFirstOrThrow({
      where: { pharmacyId: pharmacy.id },
    });

    await paidConsultation(cookies);
    const rerun = await request<{ updated: number }>('/admin/payouts/calculate', {
      method: 'POST',
      cookies: admin,
      payload: period,
    });

    const after = await getPrisma().pharmacyPayout.findFirstOrThrow({
      where: { pharmacyId: pharmacy.id },
    });

    expect(rerun.body.data?.updated).toBe(1);
    expect(after.amountDueMinor).toBeGreaterThan(before.amountDueMinor);
  });

  /**
   * The figure someone has already transferred against must not move under
   * them. A later correction is a new period's adjustment, not an edit.
   */
  it('leaves a paid payout exactly as it was', async () => {
    const { cookies, pharmacy } = await setUpPharmacy();
    await paidConsultation(cookies);

    const admin = await adminCookies();
    const period = { periodStart: today(), periodEnd: today() };
    await request('/admin/payouts/calculate', { method: 'POST', cookies: admin, payload: period });

    const payout = await getPrisma().pharmacyPayout.findFirstOrThrow({
      where: { pharmacyId: pharmacy.id },
    });
    await request(`/admin/payouts/${payout.publicId}/mark-paid`, {
      method: 'POST',
      cookies: admin,
      payload: { paymentReference: 'MOMO-12345' },
    });

    await paidConsultation(cookies);
    const rerun = await request<{ frozen: number }>('/admin/payouts/calculate', {
      method: 'POST',
      cookies: admin,
      payload: period,
    });

    const after = await getPrisma().pharmacyPayout.findFirstOrThrow({ where: { id: payout.id } });

    expect(rerun.body.data?.frozen).toBe(1);
    expect(after.amountDueMinor).toBe(payout.amountDueMinor);
  });
});

// ---------------------------------------------------------------------------

describe('marking a payout paid', () => {
  it('records the reference and refuses a second attempt', async () => {
    const { cookies, pharmacy } = await setUpPharmacy();
    await paidConsultation(cookies);

    const admin = await adminCookies();
    await request('/admin/payouts/calculate', {
      method: 'POST',
      cookies: admin,
      payload: { periodStart: today(), periodEnd: today() },
    });
    const payout = await getPrisma().pharmacyPayout.findFirstOrThrow({
      where: { pharmacyId: pharmacy.id },
    });

    const first = await request(`/admin/payouts/${payout.publicId}/mark-paid`, {
      method: 'POST',
      cookies: admin,
      payload: { paymentReference: 'MOMO-99999' },
    });
    const second = await request(`/admin/payouts/${payout.publicId}/mark-paid`, {
      method: 'POST',
      cookies: admin,
      payload: { paymentReference: 'MOMO-99999' },
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);

    const after = await getPrisma().pharmacyPayout.findFirstOrThrow({ where: { id: payout.id } });
    expect(after.paymentReference).toBe('MOMO-99999');
    expect(after.amountPaidMinor).toBe(after.amountDueMinor);
  });

  it('requires a reference — a payout with nothing to trace is not a record', async () => {
    const { cookies, pharmacy } = await setUpPharmacy();
    await paidConsultation(cookies);

    const admin = await adminCookies();
    await request('/admin/payouts/calculate', {
      method: 'POST',
      cookies: admin,
      payload: { periodStart: today(), periodEnd: today() },
    });
    const payout = await getPrisma().pharmacyPayout.findFirstOrThrow({
      where: { pharmacyId: pharmacy.id },
    });

    const response = await request(`/admin/payouts/${payout.publicId}/mark-paid`, {
      method: 'POST',
      cookies: admin,
      payload: {},
    });

    expect(response.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------

describe('a pharmacy’s own earnings', () => {
  it('shows its share and nothing about Neem’s', async () => {
    const { cookies } = await setUpPharmacy();
    await paidConsultation(cookies);

    const response = await request<{
      allTimeMinor: number;
      awaitingPayoutMinor: number;
      consultations30Days: number;
    }>('/pharmacy/finance', { cookies });

    expect(response.status).toBe(200);
    expect(response.body.data!.allTimeMinor).toBeGreaterThan(0);
    expect(response.body.data!.consultations30Days).toBe(1);
    expect(JSON.stringify(response.body.data)).not.toContain('neemShare');
  });

  it('counts only its own consultations', async () => {
    const { cookies } = await setUpPharmacy();
    await paidConsultation(cookies);

    const prisma = getPrisma();
    const other = await createTestPharmacy('Other Payout Pharmacy', 'ACTIVE');
    const otherUser = await createTestUser({
      email: 'other@payout.test',
      password: 'OtherPassword123!',
      role: 'PHARMACY',
    });
    await prisma.pharmacyUser.create({ data: { pharmacyId: other.id, userId: otherUser.id } });
    const otherCookies = await signIn('other@payout.test', 'OtherPassword123!');

    const response = await request<{ allTimeMinor: number }>('/pharmacy/finance', {
      cookies: otherCookies,
    });

    expect(response.body.data!.allTimeMinor).toBe(0);
  });

  it('is closed to a doctor', async () => {
    await createTestUser({
      email: 'doctor@payout.test',
      password: 'DoctorPassword123!',
      role: 'DOCTOR',
    });
    const cookies = await signIn('doctor@payout.test', 'DoctorPassword123!');

    expect((await request('/pharmacy/finance', { cookies })).status).toBe(403);
  });
});
