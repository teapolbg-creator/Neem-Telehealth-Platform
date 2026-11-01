import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import type { DistrictOverview, StaffAccount, StaffAccountSetup } from '@neem/contracts';
import { disconnectPrisma, getPrisma } from '../../src/db/prisma.ts';
import { closeTestApp, request, signIn } from '../helpers/app.ts';
import { encryptTotpSecret } from '../../src/modules/auth/totp.service.ts';
import { createTestUser, resetDatabase } from '../helpers/database.ts';
import { generatePublicId } from '../../src/lib/crypto.ts';

/**
 * Super administrators, operations administrators and district health
 * officers (CHPS slice 3a, D84).
 */

afterAll(async () => {
  await closeTestApp();
  await disconnectPrisma();
});

async function adminCookies(role: 'ADMIN' | 'OPS_ADMIN' = 'ADMIN') {
  const email = `${generatePublicId('x').slice(-8).toLowerCase()}@admin.test`;
  const password = 'AdminPassword123!';
  const secret = authenticator.generateSecret(20);

  const user = await createTestUser({
    email,
    password,
    role,
    twoFactorSecretEnc: encryptTotpSecret(secret),
    twoFactorEnabled: true,
  });
  await getPrisma().admin.create({ data: { userId: user.id, fullName: `Test ${role}` } });

  const login = await request<{ challengeId: string }>('/auth/login', {
    method: 'POST',
    payload: { email, password },
  });
  const verify = await request('/auth/2fa/verify', {
    method: 'POST',
    payload: { challengeId: login.body.data!.challengeId, code: authenticator.generate(secret) },
  });
  return { cookies: verify.cookies, userId: user.id, publicId: user.publicId };
}

/** Two districts of Volta, each with one CHPS compound. */
async function twoDistricts() {
  const prisma = getPrisma();
  const [ho, keta] = await prisma.district.findMany({
    where: { region: { name: 'Volta' } },
    orderBy: { name: 'asc' },
    take: 2,
  });
  const facility = (districtId: string, label: string) =>
    prisma.facility.create({
      data: {
        publicId: generatePublicId('fac'),
        code: `CHPS-${label}`,
        name: `${label} CHPS`,
        type: 'CHPS',
        districtId,
        community: label,
        status: 'ACTIVE',
        createdByUserId: 'test',
        isDemo: true,
      },
    });
  await facility(ho!.id, 'Mine');
  await facility(keta!.id, 'Theirs');
  return { regionId: ho!.regionId, mine: ho!, theirs: keta! };
}

/** Uses the set-up link as its owner would, then signs in. */
async function claim(setup: StaffAccountSetup, password = 'OfficerPassword123!') {
  const token = new URL(setup.setupPath, 'http://x').searchParams.get('token')!;
  const confirmed = await request('/auth/password-reset/confirm', {
    method: 'POST',
    payload: { token, password },
  });
  expect(confirmed.status).toBe(200);
  return signIn(setup.account.email, password);
}

describe('staff accounts and roles (D84)', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('lets operations run facilities but not staff accounts, settings, money or the audit log', async () => {
    const ops = await adminCookies('OPS_ADMIN');

    expect((await request('/admin/facilities', { cookies: ops.cookies })).status).toBe(200);
    expect((await request('/admin/geography', { cookies: ops.cookies })).status).toBe(200);
    for (const path of [
      '/admin/staff',
      '/admin/settings',
      '/admin/audit-logs',
      '/admin/analytics/financial',
    ]) {
      expect((await request(path, { cookies: ops.cookies })).status, path).toBe(403);
    }
    const created = await request('/admin/staff', {
      method: 'POST',
      cookies: ops.cookies,
      payload: { role: 'OPS_ADMIN', fullName: 'Kofi Ops', email: 'kofi@ops.test' },
    });
    expect(created.status).toBe(403);
  });

  it('gives an operations administrator no session until 2FA is enrolled', async () => {
    await createTestUser({ email: 'new@ops.test', password: 'OpsPassword123!', role: 'OPS_ADMIN' });
    const login = await request<{ challengeId: string; enrollment?: unknown }>('/auth/login', {
      method: 'POST',
      payload: { email: 'new@ops.test', password: 'OpsPassword123!' },
    });
    expect(login.status).toBe(200);
    expect(login.body.data!.challengeId).toBeTruthy();
    expect(login.cookies.neem_session).toBeUndefined();
  });

  it('creates a district officer whose overview holds their district only', async () => {
    const admin = await adminCookies();
    const { regionId, mine } = await twoDistricts();

    const created = await request<StaffAccountSetup>('/admin/staff', {
      method: 'POST',
      cookies: admin.cookies,
      payload: {
        role: 'DISTRICT',
        fullName: 'Esi Officer',
        email: 'esi@ghs.test',
        title: 'District Director of Health Services',
        scope: { level: 'DISTRICT', regionId, districtId: mine.id },
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.data!.account).toMatchObject({
      role: 'DISTRICT',
      hasSetPassword: false,
      scope: { level: 'DISTRICT', label: `${mine.name}, Volta` },
    });

    const officer = await claim(created.body.data!);
    const me = await request<{ role: string; displayName: string }>('/auth/me', {
      cookies: officer,
    });
    expect(me.body.data).toMatchObject({ role: 'DISTRICT', displayName: 'Esi Officer' });

    const overview = await request<DistrictOverview>('/district/overview', { cookies: officer });
    expect(overview.status).toBe(200);
    expect(overview.body.data!.facilities.map((facility) => facility.name)).toEqual(['Mine CHPS']);

    // Read-only, and nowhere else.
    for (const path of ['/admin/facilities', '/facility/profile', '/admin/staff']) {
      expect((await request(path, { cookies: officer })).status, path).toBe(403);
    }

    const list = await request<StaffAccount[]>('/admin/staff', { cookies: admin.cookies });
    expect(list.body.data!.find((account) => account.email === 'esi@ghs.test')).toMatchObject({
      hasSetPassword: true,
    });
  });

  it('sees the whole region at region level', async () => {
    const admin = await adminCookies();
    const { regionId } = await twoDistricts();
    const created = await request<StaffAccountSetup>('/admin/staff', {
      method: 'POST',
      cookies: admin.cookies,
      payload: {
        role: 'DISTRICT',
        fullName: 'Regional Officer',
        email: 'region@ghs.test',
        // A district sent with a region-level scope is dropped, not trusted.
        scope: { level: 'REGION', regionId, districtId: 'ignored' },
      },
    });
    expect(created.status).toBe(201);
    const officer = await claim(created.body.data!);
    const overview = await request<DistrictOverview>('/district/overview', { cookies: officer });
    expect(overview.body.data!.facilities.map((facility) => facility.name).sort()).toEqual([
      'Mine CHPS',
      'Theirs CHPS',
    ]);
  });

  it('refuses an area that does not fit together', async () => {
    const admin = await adminCookies();
    const { mine } = await twoDistricts();
    const ashanti = await getPrisma().region.findFirstOrThrow({ where: { name: 'Ashanti' } });

    const mismatched = await request('/admin/staff', {
      method: 'POST',
      cookies: admin.cookies,
      payload: {
        role: 'DISTRICT',
        fullName: 'Wrong Place',
        email: 'wrong@ghs.test',
        scope: { level: 'DISTRICT', regionId: ashanti.id, districtId: mine.id },
      },
    });
    expect(mismatched.status).toBe(400);

    const missing = await request('/admin/staff', {
      method: 'POST',
      cookies: admin.cookies,
      payload: {
        role: 'DISTRICT',
        fullName: 'No District',
        email: 'none@ghs.test',
        scope: { level: 'DISTRICT', regionId: ashanti.id },
      },
    });
    expect(missing.status).toBe(400);
  });

  it('suspends an officer at once, and never a super administrator or oneself', async () => {
    const admin = await adminCookies();
    const other = await adminCookies();
    const { regionId, mine } = await twoDistricts();
    const created = await request<StaffAccountSetup>('/admin/staff', {
      method: 'POST',
      cookies: admin.cookies,
      payload: {
        role: 'DISTRICT',
        fullName: 'Esi Officer',
        email: 'esi@ghs.test',
        scope: { level: 'DISTRICT', regionId, districtId: mine.id },
      },
    });
    const officer = await claim(created.body.data!);
    const { userPublicId } = created.body.data!.account;

    const suspended = await request<StaffAccount>(`/admin/staff/${userPublicId}/status`, {
      method: 'POST',
      cookies: admin.cookies,
      payload: { status: 'SUSPENDED' },
    });
    expect(suspended.body.data!.status).toBe('SUSPENDED');
    expect((await request('/district/overview', { cookies: officer })).status).toBe(401);

    for (const target of [admin.publicId, other.publicId]) {
      const refused = await request(`/admin/staff/${target}/status`, {
        method: 'POST',
        cookies: admin.cookies,
        payload: { status: 'SUSPENDED' },
      });
      expect(refused.status).toBe(422);
    }
  });
});
