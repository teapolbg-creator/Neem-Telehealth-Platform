import { authenticator } from 'otplib';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getPrisma, disconnectPrisma } from '../../src/db/prisma.ts';
import { closeTestApp, request, signIn } from '../helpers/app.ts';
import { createTestPharmacy, createTestUser, resetDatabase } from '../helpers/database.ts';
import { encryptTotpSecret } from '../../src/modules/auth/totp.service.ts';
import { encryptField, generatePublicId } from '../../src/lib/crypto.ts';
import {
  MockPaymentProvider,
  setPaymentProviderForTesting,
} from '../../src/adapters/payment/index.ts';
import { currentPayrollPeriod } from '../../src/modules/doctor/payroll.service.ts';

/**
 * Payroll and promotions (spec §26, §42, decision D28).
 *
 * Both were half-built: `domain/compensation.ts` implemented D28's formula and
 * nothing called it, and `PROMOTION_MANAGE` was a permission with no route
 * behind it, so the only way to run a campaign was to write database rows by
 * hand.
 */

const ADMIN = { email: 'admin@payroll.test', password: 'AdminPassword123!' };

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

async function createDoctor(options: {
  email: string;
  fullName: string;
  contractedHoursPerWeek: number | null;
}) {
  const prisma = getPrisma();
  const user = await createTestUser({
    email: options.email,
    password: 'DoctorPassword123!',
    role: 'DOCTOR',
  });

  const expiry = new Date();
  expiry.setFullYear(expiry.getFullYear() + 1);

  return prisma.doctor.create({
    data: {
      publicId: generatePublicId('doc'),
      userId: user.id,
      fullName: options.fullName,
      mdcNumber: `MDC-PR-${generatePublicId('x').slice(-8)}`,
      mdcExpiresAt: expiry,
      status: 'ACTIVE',
      isDemo: true,
      contractedHoursPerWeek: options.contractedHoursPerWeek,
      employmentType: options.contractedHoursPerWeek === 40 ? 'FULL_TIME' : 'PART_TIME',
      signatures: { create: { signatureDataEnc: encryptField('data:image/png;base64,AAAA') } },
    },
  });
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

describe('payroll (decision D28)', () => {
  it('pays a full-time doctor the configured monthly figure', async () => {
    await createDoctor({
      email: 'full@payroll.test',
      fullName: 'Dr. Full Time',
      contractedHoursPerWeek: 40,
    });

    const admin = await adminCookies();
    const response = await request<{
      fullTimeMonthlyMinor: number;
      lines: Array<{ monthlyMinor: number; isFullTime: boolean }>;
    }>('/admin/payroll', { cookies: admin });

    expect(response.status).toBe(200);
    const line = response.body.data!.lines[0]!;
    expect(line.isFullTime).toBe(true);
    expect(line.monthlyMinor).toBe(response.body.data!.fullTimeMonthlyMinor);
  });

  it('scales a part-time doctor by contracted hours', async () => {
    await createDoctor({
      email: 'half@payroll.test',
      fullName: 'Dr. Half Time',
      contractedHoursPerWeek: 20,
    });

    const admin = await adminCookies();
    const response = await request<{
      fullTimeMonthlyMinor: number;
      lines: Array<{ monthlyMinor: number; fraction: number }>;
    }>('/admin/payroll', { cookies: admin });

    const line = response.body.data!.lines[0]!;
    // GHS 8,000 × (20 ÷ 40), in pesewas, exactly.
    expect(line.monthlyMinor).toBe(Math.floor(response.body.data!.fullTimeMonthlyMinor / 2));
    expect(line.fraction).toBeCloseTo(0.5);
  });

  /**
   * A missing contract is a gap in the record, not a doctor owed nothing.
   *
   * Assuming full-time would invent a salary; assuming zero would hide the
   * gap. The doctor is omitted and counted so an administrator can see it.
   */
  it('omits a doctor with no contracted hours, and says how many', async () => {
    await createDoctor({
      email: 'contract@payroll.test',
      fullName: 'Dr. Contracted',
      contractedHoursPerWeek: 40,
    });
    await createDoctor({
      email: 'nocontract@payroll.test',
      fullName: 'Dr. No Contract',
      contractedHoursPerWeek: null,
    });

    const admin = await adminCookies();
    const response = await request<{
      lines: Array<{ fullName: string }>;
      doctorsWithoutContract: number;
    }>('/admin/payroll', { cookies: admin });

    expect(response.body.data!.lines).toHaveLength(1);
    expect(response.body.data!.lines[0]!.fullName).toBe('Dr. Contracted');
    expect(response.body.data!.doctorsWithoutContract).toBe(1);
  });

  it('totals only the doctors it could calculate', async () => {
    await createDoctor({
      email: 'a@payroll.test',
      fullName: 'Dr. A',
      contractedHoursPerWeek: 40,
    });
    await createDoctor({
      email: 'b@payroll.test',
      fullName: 'Dr. B',
      contractedHoursPerWeek: 20,
    });

    const admin = await adminCookies();
    const response = await request<{
      totalMinor: number;
      lines: Array<{ monthlyMinor: number }>;
    }>('/admin/payroll', { cookies: admin });

    expect(response.body.data!.totalMinor).toBe(
      response.body.data!.lines.reduce((sum, line) => sum + line.monthlyMinor, 0),
    );
  });

  it('shows a doctor their own figure and nobody else’s', async () => {
    await createDoctor({
      email: 'mine@payroll.test',
      fullName: 'Dr. Mine',
      contractedHoursPerWeek: 20,
    });
    await createDoctor({
      email: 'theirs@payroll.test',
      fullName: 'Dr. Theirs',
      contractedHoursPerWeek: 40,
    });

    const cookies = await signIn('mine@payroll.test', 'DoctorPassword123!');
    const response = await request<{ monthlyMinor: number; contractedHoursPerWeek: number }>(
      '/doctor/earnings',
      { cookies },
    );

    expect(response.status).toBe(200);
    expect(response.body.data!.contractedHoursPerWeek).toBe(20);
    // No other doctor appears anywhere in the payload.
    expect(JSON.stringify(response.body.data)).not.toContain('Theirs');
  });

  it('never returns a rating or a quality score to a doctor (spec §24, §52)', async () => {
    await createDoctor({
      email: 'scored@payroll.test',
      fullName: 'Dr. Scored',
      contractedHoursPerWeek: 20,
    });

    const cookies = await signIn('scored@payroll.test', 'DoctorPassword123!');
    const body = JSON.stringify(
      (await request('/doctor/earnings', { cookies })).body.data,
    ).toLowerCase();

    expect(body).not.toContain('rating');
    expect(body).not.toContain('qualityscore');
  });

  it('is closed to a doctor at the admin route', async () => {
    await createDoctor({
      email: 'nosy@payroll.test',
      fullName: 'Dr. Nosy',
      contractedHoursPerWeek: 20,
    });

    const cookies = await signIn('nosy@payroll.test', 'DoctorPassword123!');
    expect((await request('/admin/payroll', { cookies })).status).toBe(403);
  });

  it('covers the current month as ISO weeks', () => {
    const period = currentPayrollPeriod();
    expect(period.toIsoWeek).toBeGreaterThanOrEqual(period.fromIsoWeek);
  });
});

// ---------------------------------------------------------------------------

describe('promotions (spec §42)', () => {
  const window = () => ({
    startsAt: new Date(Date.now() - 3600_000).toISOString(),
    endsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  });

  it('creates a percentage code an admin can withdraw', async () => {
    const admin = await adminCookies();

    const created = await request<{ code: string }>('/admin/promotions', {
      method: 'POST',
      cookies: admin,
      payload: { code: 'launch20', type: 'PERCENT', valueBp: 2000, ...window() },
    });

    expect(created.status).toBe(201);
    expect(created.body.data!.code).toBe('LAUNCH20');

    const withdrawn = await request<{ isActive: boolean }>(
      '/admin/promotions/LAUNCH20/deactivate',
      { method: 'POST', cookies: admin, payload: {} },
    );
    expect(withdrawn.body.data!.isActive).toBe(false);

    // Withdrawn, not deleted — consultations reference it.
    expect(await getPrisma().promotion.count({ where: { code: 'LAUNCH20' } })).toBe(1);
  });

  /**
   * A PERCENT promotion carrying only `valueMinor` would store cleanly and
   * then discount nothing, because `computeDiscount` reads the field its type
   * names. Refusing here means a campaign cannot be launched broken.
   */
  it('refuses a promotion whose value does not match its type', async () => {
    const admin = await adminCookies();

    const percentWithoutPercent = await request('/admin/promotions', {
      method: 'POST',
      cookies: admin,
      payload: { code: 'BROKEN1', type: 'PERCENT', valueMinor: 1000, ...window() },
    });
    const fixedWithoutAmount = await request('/admin/promotions', {
      method: 'POST',
      cookies: admin,
      payload: { code: 'BROKEN2', type: 'FIXED', valueBp: 2000, ...window() },
    });

    expect(percentWithoutPercent.status).toBe(422);
    expect(fixedWithoutAmount.status).toBe(422);
  });

  it('refuses a window that ends before it starts, or has already ended', async () => {
    const admin = await adminCookies();

    const backwards = await request('/admin/promotions', {
      method: 'POST',
      cookies: admin,
      payload: {
        code: 'BACKWARD',
        type: 'PERCENT',
        valueBp: 1000,
        startsAt: new Date(Date.now() + 86_400_000).toISOString(),
        endsAt: new Date().toISOString(),
      },
    });
    const alreadyOver = await request('/admin/promotions', {
      method: 'POST',
      cookies: admin,
      payload: {
        code: 'EXPIRED1',
        type: 'PERCENT',
        valueBp: 1000,
        startsAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        endsAt: new Date(Date.now() - 86_400_000).toISOString(),
      },
    });

    expect(backwards.status).toBe(422);
    expect(alreadyOver.status).toBe(422);
  });

  it('refuses a duplicate code', async () => {
    const admin = await adminCookies();
    const payload = { code: 'ONLYONCE', type: 'PERCENT' as const, valueBp: 1000, ...window() };

    expect((await request('/admin/promotions', { method: 'POST', cookies: admin, payload })).status).toBe(201);
    expect((await request('/admin/promotions', { method: 'POST', cookies: admin, payload })).status).toBe(409);
  });

  it('discounts a consultation and reports what the campaign cost', async () => {
    const prisma = getPrisma();
    const admin = await adminCookies();

    await request('/admin/promotions', {
      method: 'POST',
      cookies: admin,
      payload: { code: 'HALFOFF', type: 'PERCENT', valueBp: 5000, ...window() },
    });

    const pharmacy = await createTestPharmacy('Promo Pharmacy', 'ACTIVE');
    const user = await createTestUser({
      email: 'pharmacy@promo.test',
      password: 'PharmacyPassword123!',
      role: 'PHARMACY',
    });
    await prisma.pharmacyUser.create({ data: { pharmacyId: pharmacy.id, userId: user.id } });
    const cookies = await signIn('pharmacy@promo.test', 'PharmacyPassword123!');

    const created = await request<{ publicId: string }>('/pharmacy/consultations', {
      method: 'POST',
      cookies,
      payload: { promotionCode: 'HALFOFF' },
    });

    const consultation = await prisma.consultation.findUniqueOrThrow({
      where: { publicId: created.body.data!.publicId },
    });

    // The discount is computed server-side; the client supplied only a code.
    expect(consultation.netMinor).toBe(consultation.priceMinor - consultation.discountMinor);
    expect(consultation.discountMinor).toBe(Math.floor(consultation.priceMinor / 2));

    const listed = await request<Array<{ code: string; usedCount: number; discountedMinor: number }>>(
      '/admin/promotions',
      { cookies: admin },
    );
    const promotion = listed.body.data!.find((row) => row.code === 'HALFOFF')!;

    expect(promotion.usedCount).toBe(1);
    expect(promotion.discountedMinor).toBe(consultation.discountMinor);
  });

  it('refuses a withdrawn code at redemption', async () => {
    const prisma = getPrisma();
    const admin = await adminCookies();

    await request('/admin/promotions', {
      method: 'POST',
      cookies: admin,
      payload: { code: 'GONE', type: 'PERCENT', valueBp: 5000, ...window() },
    });
    await request('/admin/promotions/GONE/deactivate', {
      method: 'POST',
      cookies: admin,
      payload: {},
    });

    const pharmacy = await createTestPharmacy('Withdrawn Pharmacy', 'ACTIVE');
    const user = await createTestUser({
      email: 'pharmacy@withdrawn.test',
      password: 'PharmacyPassword123!',
      role: 'PHARMACY',
    });
    await prisma.pharmacyUser.create({ data: { pharmacyId: pharmacy.id, userId: user.id } });
    const cookies = await signIn('pharmacy@withdrawn.test', 'PharmacyPassword123!');

    const response = await request('/pharmacy/consultations', {
      method: 'POST',
      cookies,
      payload: { promotionCode: 'GONE' },
    });

    expect(response.status).toBe(422);
  });

  it('is closed to a pharmacy', async () => {
    const prisma = getPrisma();
    const pharmacy = await createTestPharmacy('Nosy Pharmacy', 'ACTIVE');
    const user = await createTestUser({
      email: 'pharmacy@nosy.test',
      password: 'PharmacyPassword123!',
      role: 'PHARMACY',
    });
    await prisma.pharmacyUser.create({ data: { pharmacyId: pharmacy.id, userId: user.id } });
    const cookies = await signIn('pharmacy@nosy.test', 'PharmacyPassword123!');

    expect((await request('/admin/promotions', { cookies })).status).toBe(403);
  });
});
