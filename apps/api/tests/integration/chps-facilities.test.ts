import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import type { FacilityDetail, FacilityStaffSetup, GeographyRegion } from '@neem/contracts';
import { disconnectPrisma, getPrisma } from '../../src/db/prisma.ts';
import { closeTestApp, request, signIn } from '../helpers/app.ts';
import { encryptTotpSecret } from '../../src/modules/auth/totp.service.ts';
import { createTestPharmacy, createTestUser, resetDatabase } from '../helpers/database.ts';
import { generatePublicId } from '../../src/lib/crypto.ts';
import { GHANA_REGIONS } from '../../prisma/seed/reference-data.ts';

/**
 * Health facilities, the geography they sit in, and CHPS staff accounts
 * (CHPS slice 1a, D73).
 */

afterAll(async () => {
  await closeTestApp();
  await disconnectPrisma();
});

async function adminCookies() {
  const email = `${generatePublicId('x').slice(-8).toLowerCase()}@admin.test`;
  const password = 'AdminPassword123!';
  const secret = authenticator.generateSecret(20);

  await createTestUser({
    email,
    password,
    role: 'ADMIN',
    twoFactorSecretEnc: encryptTotpSecret(secret),
    twoFactorEnabled: true,
  });

  const login = await request<{ challengeId: string }>('/auth/login', {
    method: 'POST',
    payload: { email, password },
  });
  const verify = await request('/auth/2fa/verify', {
    method: 'POST',
    payload: { challengeId: login.body.data!.challengeId, code: authenticator.generate(secret) },
  });
  return verify.cookies;
}

/** A region with one district and one sub-district, created through the API. */
async function place(admin: Record<string, string>) {
  const geography = await request<GeographyRegion[]>('/admin/geography', { cookies: admin });
  const region = geography.body.data!.find((entry) => entry.name === 'Volta')!;

  const district = await request<{ id: string }>('/admin/geography/districts', {
    method: 'POST',
    cookies: admin,
    payload: { regionId: region.id, name: 'Test District' },
  });
  const sub = await request<{ id: string }>('/admin/geography/sub-districts', {
    method: 'POST',
    cookies: admin,
    payload: { districtId: district.body.data!.id, name: 'Test Sub-district' },
  });

  return {
    regionId: region.id,
    districtId: district.body.data!.id,
    subDistrictId: sub.body.data!.id,
  };
}

async function registerFacility(
  admin: Record<string, string>,
  location: { districtId: string; subDistrictId: string },
  overrides: Record<string, unknown> = {},
) {
  return request<FacilityDetail>('/admin/facilities', {
    method: 'POST',
    cookies: admin,
    payload: {
      name: 'Avenorpeme CHPS',
      code: 'chps-test-001',
      type: 'CHPS',
      districtId: location.districtId,
      subDistrictId: location.subDistrictId,
      community: 'Avenorpeme',
      ghanaPostGps: 'VA-012-3456',
      contactPhone: '024 000 0000',
      ...overrides,
    },
  });
}

/** Uses the set-up link exactly as the staff member would, then signs in. */
async function completeSetup(setup: FacilityStaffSetup, password = 'ChoPassword123!') {
  const token = new URL(setup.setupPath, 'http://x').searchParams.get('token')!;
  const confirmed = await request('/auth/password-reset/confirm', {
    method: 'POST',
    payload: { token, password },
  });
  expect(confirmed.status).toBe(200);
  return signIn(setup.member.email, password);
}

describe('CHPS facilities', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('seeds the sixteen regions and nothing below them', async () => {
    const admin = await adminCookies();
    const geography = await request<GeographyRegion[]>('/admin/geography', { cookies: admin });

    expect(geography.status).toBe(200);
    expect(geography.body.data!.map((region) => region.name)).toEqual([...GHANA_REGIONS].sort());
    expect(geography.body.data!.every((region) => region.districts.length === 0)).toBe(true);
  });

  it('refuses a second district of the same name in one region', async () => {
    const admin = await adminCookies();
    const location = await place(admin);

    const again = await request('/admin/geography/districts', {
      method: 'POST',
      cookies: admin,
      payload: { regionId: location.regionId, name: 'Test District' },
    });
    expect(again.status).toBe(409);
  });

  it('registers a facility inactive, with nothing claimed about its equipment', async () => {
    const admin = await adminCookies();
    const location = await place(admin);

    const created = await registerFacility(admin, location, {
      // Not accepted on create: a new facility always starts switched off.
      status: 'ACTIVE',
      equipmentStatus: 'OPERATIONAL',
    });

    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      code: 'CHPS-TEST-001',
      status: 'INACTIVE',
      equipmentStatus: 'NOT_INSTALLED',
      connectivityStatus: 'UNKNOWN',
      location: { region: { name: 'Volta' }, district: { name: 'Test District' } },
    });

    // Codes are compared upper-cased, so a different spelling is the same code.
    const duplicate = await registerFacility(admin, location, { code: 'CHPS-test-001' });
    expect(duplicate.status).toBe(409);
  });

  it('refuses a sub-district from another district', async () => {
    const admin = await adminCookies();
    const location = await place(admin);
    const geography = await request<GeographyRegion[]>('/admin/geography', { cookies: admin });
    const otherRegion = geography.body.data!.find((region) => region.name === 'Oti')!;
    const other = await request<{ id: string }>('/admin/geography/districts', {
      method: 'POST',
      cookies: admin,
      payload: { regionId: otherRegion.id, name: 'Elsewhere' },
    });

    const created = await registerFacility(admin, {
      districtId: other.body.data!.id,
      subDistrictId: location.subDistrictId,
    });
    expect(created.status).toBe(400);
  });

  it('requires a reason to deactivate, and records when connectivity was reported', async () => {
    const admin = await adminCookies();
    const location = await place(admin);
    const created = await registerFacility(admin, location);
    const path = `/admin/facilities/${created.body.data!.publicId}`;

    const activated = await request<FacilityDetail>(path, {
      method: 'PATCH',
      cookies: admin,
      payload: { status: 'ACTIVE', connectivityStatus: 'INTERMITTENT' },
    });
    expect(activated.status).toBe(200);
    expect(activated.body.data!.status).toBe('ACTIVE');
    expect(activated.body.data!.connectivityReportedAt).not.toBeNull();

    const silent = await request(path, {
      method: 'PATCH',
      cookies: admin,
      payload: { status: 'INACTIVE' },
    });
    expect(silent.status).toBe(422);

    const explained = await request<FacilityDetail>(path, {
      method: 'PATCH',
      cookies: admin,
      payload: { status: 'INACTIVE', statusReason: 'Tablet stolen' },
    });
    expect(explained.body.data).toMatchObject({
      status: 'INACTIVE',
      statusReason: 'Tablet stolen',
    });
  });

  it('creates a CHO who sets their own password and sees only their facility', async () => {
    const admin = await adminCookies();
    const location = await place(admin);
    const created = await registerFacility(admin, location);
    const publicId = created.body.data!.publicId;

    const staff = await request<FacilityStaffSetup>(`/admin/facilities/${publicId}/staff`, {
      method: 'POST',
      cookies: admin,
      payload: {
        fullName: 'Akosua Mensah',
        email: 'Akosua.Mensah@CHPS.test',
        title: 'Community Health Officer',
      },
    });
    expect(staff.status).toBe(201);
    expect(staff.body.data!.setupPath).toMatch(/^\/auth\/reset\?token=/);
    expect(staff.body.data!.member).toMatchObject({
      email: 'akosua.mensah@chps.test',
      hasSetPassword: false,
      status: 'ACTIVE',
    });

    const cho = await completeSetup(staff.body.data!);

    const me = await request<{ role: string; organisation: { publicId: string } }>('/auth/me', {
      cookies: cho,
    });
    expect(me.body.data).toMatchObject({ role: 'FACILITY', organisation: { publicId } });

    const own = await request<FacilityDetail>('/facility/profile', { cookies: cho });
    expect(own.status).toBe(200);
    expect(own.body.data!.publicId).toBe(publicId);
    expect(own.body.data!.staff[0]!.hasSetPassword).toBe(true);

    // Nothing administrative, and nothing belonging to a pharmacy.
    expect((await request('/admin/facilities', { cookies: cho })).status).toBe(403);
    expect((await request('/pharmacy/profile', { cookies: cho })).status).toBe(403);
  });

  it('gives staff accounts only to CHPS compounds', async () => {
    const admin = await adminCookies();
    const location = await place(admin);
    const hospital = await registerFacility(admin, location, {
      name: 'District Hospital',
      code: 'DH-001',
      type: 'DISTRICT_HOSPITAL',
    });

    const staff = await request(`/admin/facilities/${hospital.body.data!.publicId}/staff`, {
      method: 'POST',
      cookies: admin,
      payload: { fullName: 'Kofi Boateng', email: 'kofi@hospital.test' },
    });
    expect(staff.status).toBe(422);
  });

  it('ends a suspended CHO’s session, and a new set-up link kills the old one', async () => {
    const admin = await adminCookies();
    const location = await place(admin);
    const created = await registerFacility(admin, location);
    const publicId = created.body.data!.publicId;

    const first = await request<FacilityStaffSetup>(`/admin/facilities/${publicId}/staff`, {
      method: 'POST',
      cookies: admin,
      payload: { fullName: 'Yaw Darko', email: 'yaw@chps.test' },
    });
    const userPublicId = first.body.data!.member.userPublicId;

    const second = await request<FacilityStaffSetup>(
      `/admin/facilities/${publicId}/staff/${userPublicId}/setup-link`,
      { method: 'POST', cookies: admin, payload: {} },
    );
    expect(second.status).toBe(200);

    const oldToken = new URL(first.body.data!.setupPath, 'http://x').searchParams.get('token');
    const stale = await request('/auth/password-reset/confirm', {
      method: 'POST',
      payload: { token: oldToken, password: 'ChoPassword123!' },
    });
    expect(stale.status).toBe(401);

    const cho = await completeSetup(second.body.data!);
    expect((await request('/facility/profile', { cookies: cho })).status).toBe(200);

    const suspended = await request(`/admin/facilities/${publicId}/staff/${userPublicId}/status`, {
      method: 'POST',
      cookies: admin,
      payload: { status: 'SUSPENDED' },
    });
    expect(suspended.status).toBe(200);
    expect((await request('/facility/profile', { cookies: cho })).status).toBe(401);
  });

  it('keeps facility administration from anybody but an administrator', async () => {
    const admin = await adminCookies();
    const location = await place(admin);
    const prisma = getPrisma();
    const pharmacy = await createTestPharmacy();
    const user = await createTestUser({
      email: 'counter@pharmacy.test',
      password: 'PharmacyPassword123!',
      role: 'PHARMACY',
    });
    await prisma.pharmacyUser.create({ data: { pharmacyId: pharmacy.id, userId: user.id } });
    const cookies = await signIn('counter@pharmacy.test', 'PharmacyPassword123!');

    expect((await request('/admin/facilities', { cookies })).status).toBe(403);
    expect((await registerFacility(cookies, location)).status).toBe(403);
    expect((await request('/facility/profile', { cookies })).status).toBe(403);

    expect(await prisma.facility.count()).toBe(0);
  });
});
