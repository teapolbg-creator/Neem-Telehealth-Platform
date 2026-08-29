import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import { getPrisma, disconnectPrisma } from '../../src/db/prisma.ts';
import { encryptTotpSecret } from '../../src/modules/auth/totp.service.ts';
import { closeTestApp, request, signIn } from '../helpers/app.ts';
import { createTestUser, resetDatabase } from '../helpers/database.ts';

/**
 * Onboarding, verification and account lifecycle (spec §20, §21, §55, §83, §84).
 */

const ADMIN = { email: 'admin@test.local', password: 'AdminPassword123!' };

function validPharmacy(overrides: Record<string, unknown> = {}) {
  return {
    email: 'newpharmacy@test.local',
    password: 'PharmacyPassword123!',
    name: 'Test Street Pharmacy',
    councilRegistrationNo: 'PCG-TEST-99001',
    ownerName: 'Ama Owner',
    responsiblePharmacistName: 'Kojo Pharmacist',
    addressLine1: '5 Test Road',
    city: 'Accra',
    region: 'Greater Accra',
    phone: '0240000123',
    openingHours: [{ dayOfWeek: 1, opensAt: '08:00', closesAt: '20:00' }],
    tests: ['MALARIA_RDT'],
    equipment: ['BP_MONITOR'],
    services: [],
    ...overrides,
  };
}

function validDoctor(overrides: Record<string, unknown> = {}) {
  return {
    email: 'newdoctor@test.local',
    password: 'DoctorPassword123!',
    fullName: 'Dr. Test Applicant',
    mdcNumber: 'MDC-TEST-99001',
    mdcExpiresAt: '2030-01-01',
    qualifiedAt: '2016-06-01',
    yearsExperience: 9,
    specialty: 'General Practice',
    phone: '0240000124',
    languageCodes: ['en', 'tw'],
    ...overrides,
  };
}

/** Signs in an admin, completing the mandatory TOTP step. */
async function signInAdmin(): Promise<Record<string, string>> {
  const secret = authenticator.generateSecret(20);
  await createTestUser({
    ...ADMIN,
    role: 'ADMIN',
    twoFactorSecretEnc: encryptTotpSecret(secret),
    twoFactorEnabled: true,
  });

  const login = await request('/auth/login', { method: 'POST', payload: ADMIN });
  const challengeId = (login.body.data as { challengeId: string }).challengeId;

  const verify = await request('/auth/2fa/verify', {
    method: 'POST',
    payload: { challengeId, code: authenticator.generate(secret) },
  });

  return verify.cookies;
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeTestApp();
  await disconnectPrisma();
});

describe('pharmacy registration', () => {
  it('creates a PENDING pharmacy with a usable login account', async () => {
    const response = await request<{ publicId: string; status: string }>('/onboarding/pharmacy', {
      method: 'POST',
      payload: validPharmacy(),
    });

    expect(response.status).toBe(201);
    // Applications must never self-serve to ACTIVE (spec §84).
    expect(response.body.data?.status).toBe('PENDING');

    // The account exists and can sign in, but the pharmacy cannot yet operate.
    const cookies = await signIn('newpharmacy@test.local', 'PharmacyPassword123!');
    const me = await request<{ organisation: { status: string } }>('/auth/me', { cookies });
    expect(me.body.data?.organisation?.status).toBe('PENDING');
  });

  it('normalises a local phone number to international form', async () => {
    await request('/onboarding/pharmacy', { method: 'POST', payload: validPharmacy() });

    const pharmacy = await getPrisma().pharmacy.findFirstOrThrow();
    expect(pharmacy.phone).toBe('+233240000123');
  });

  it('refuses a duplicate Pharmacy Council registration number', async () => {
    await request('/onboarding/pharmacy', { method: 'POST', payload: validPharmacy() });

    const duplicate = await request('/onboarding/pharmacy', {
      method: 'POST',
      payload: validPharmacy({ email: 'other@test.local' }),
    });

    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error?.message).toMatch(/Pharmacy Council number/i);
  });

  it('refuses a duplicate email', async () => {
    await request('/onboarding/pharmacy', { method: 'POST', payload: validPharmacy() });

    const duplicate = await request('/onboarding/pharmacy', {
      method: 'POST',
      payload: validPharmacy({ councilRegistrationNo: 'PCG-TEST-99002' }),
    });

    expect(duplicate.status).toBe(409);
  });

  it('rejects a non-Ghanaian phone number', async () => {
    const response = await request('/onboarding/pharmacy', {
      method: 'POST',
      payload: validPharmacy({ phone: '+447700900000' }),
    });

    expect(response.status).toBe(400);
  });

  it('does not leave an orphan pharmacy when account creation fails', async () => {
    // A pre-existing user with the same email forces the second half of the
    // transaction to fail; the pharmacy must roll back with it.
    await createTestUser({ email: 'clash@test.local', password: 'Whatever123456!', role: 'PHARMACY' });

    const response = await request('/onboarding/pharmacy', {
      method: 'POST',
      payload: validPharmacy({ email: 'clash@test.local' }),
    });

    expect(response.status).toBe(409);
    expect(await getPrisma().pharmacy.count()).toBe(0);
  });
});

describe('doctor registration', () => {
  it('creates a PENDING doctor with the selected languages', async () => {
    const response = await request<{ status: string }>('/onboarding/doctor', {
      method: 'POST',
      payload: validDoctor(),
    });

    expect(response.status).toBe(201);
    expect(response.body.data?.status).toBe('PENDING');

    const doctor = await getPrisma().doctor.findFirstOrThrow({
      include: { languages: { include: { language: true } } },
    });
    expect(doctor.languages).toHaveLength(2);
    // The first language listed is the primary one.
    expect(doctor.languages.find((entry) => entry.isPrimary)?.language.code).toBe('en');
  });

  it('enforces the minimum experience requirement server-side (spec §21)', async () => {
    const response = await request('/onboarding/doctor', {
      method: 'POST',
      payload: validDoctor({ yearsExperience: 2 }),
    });

    expect(response.status).toBe(422);
    expect(response.body.error?.message).toMatch(/3 years/);
    expect(await getPrisma().doctor.count()).toBe(0);
  });

  it('refuses an already-expired MDC licence', async () => {
    const response = await request('/onboarding/doctor', {
      method: 'POST',
      payload: validDoctor({ mdcExpiresAt: '2020-01-01' }),
    });

    expect(response.status).toBe(422);
    expect(response.body.error?.message).toMatch(/expiry date is in the past/i);
  });

  it('refuses a language that is not active for the MVP', async () => {
    // Ewe is seeded but inactive — English, Twi and Ga only (decision D9).
    const response = await request('/onboarding/doctor', {
      method: 'POST',
      payload: validDoctor({ languageCodes: ['en', 'ee'] }),
    });

    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body.error?.details)).toContain('ee');
  });

  it('refuses a duplicate MDC number', async () => {
    await request('/onboarding/doctor', { method: 'POST', payload: validDoctor() });

    const duplicate = await request('/onboarding/doctor', {
      method: 'POST',
      payload: validDoctor({ email: 'other@test.local' }),
    });

    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error?.message).toMatch(/MDC number/i);
  });
});

describe('admin verification workflow', () => {
  it('moves a doctor through review to approval', async () => {
    const cookies = await signInAdmin();
    await request('/onboarding/doctor', { method: 'POST', payload: validDoctor() });

    const list = await request<Array<{ publicId: string; status: string }>>(
      '/admin/doctors?awaitingReview=true',
      { cookies },
    );
    expect(list.body.data).toHaveLength(1);
    const publicId = list.body.data![0]!.publicId;

    const review = await request(`/admin/doctors/${publicId}/status`, {
      method: 'POST',
      cookies,
      payload: { status: 'UNDER_REVIEW' },
    });
    expect(review.status).toBe(200);

    const approve = await request(`/admin/doctors/${publicId}/status`, {
      method: 'POST',
      cookies,
      payload: { status: 'APPROVED' },
    });
    expect(approve.status).toBe(200);
  });

  it('refuses to activate a doctor with no verified documents (spec §21)', async () => {
    const cookies = await signInAdmin();
    await request('/onboarding/doctor', { method: 'POST', payload: validDoctor() });

    const doctor = await getPrisma().doctor.findFirstOrThrow();
    await getPrisma().doctor.update({ where: { id: doctor.id }, data: { status: 'APPROVED' } });

    const activate = await request(`/admin/doctors/${doctor.publicId}/status`, {
      method: 'POST',
      cookies,
      payload: { status: 'ACTIVE' },
    });

    expect(activate.status).toBe(422);
    expect(activate.body.error?.message).toMatch(/no verified credential documents/i);
  });

  it('refuses an invalid state transition', async () => {
    const cookies = await signInAdmin();
    await request('/onboarding/doctor', { method: 'POST', payload: validDoctor() });
    const doctor = await getPrisma().doctor.findFirstOrThrow();

    // PENDING → ACTIVE is not a permitted edge.
    const response = await request(`/admin/doctors/${doctor.publicId}/status`, {
      method: 'POST',
      cookies,
      payload: { status: 'ACTIVE' },
    });

    expect(response.status).toBe(409);
    expect(response.body.error?.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('requires a reason to suspend (spec §96)', async () => {
    const cookies = await signInAdmin();
    const pharmacy = await getPrisma().pharmacy.create({
      data: {
        publicId: 'phm_testsuspend',
        name: 'Suspendable',
        councilRegistrationNo: 'PCG-TEST-88001',
        ownerName: 'Owner',
        responsiblePharmacistName: 'Pharmacist',
        addressLine1: '1 Road',
        city: 'Accra',
        region: 'Greater Accra',
        phone: '+233240000000',
        email: 'suspendable@test.local',
        status: 'ACTIVE',
      },
    });

    const withoutReason = await request(`/admin/pharmacies/${pharmacy.publicId}/status`, {
      method: 'POST',
      cookies,
      payload: { status: 'SUSPENDED' },
    });
    expect(withoutReason.status).toBe(400);

    const withReason = await request(`/admin/pharmacies/${pharmacy.publicId}/status`, {
      method: 'POST',
      cookies,
      payload: { status: 'SUSPENDED', reason: 'Pharmacy Council registration lapsed' },
    });
    expect(withReason.status).toBe(200);
  });

  it('ends a suspended pharmacy’s live session immediately (decision D4)', async () => {
    const adminCookies = await signInAdmin();
    await request('/onboarding/pharmacy', { method: 'POST', payload: validPharmacy() });

    const pharmacy = await getPrisma().pharmacy.findFirstOrThrow();
    await getPrisma().pharmacy.update({ where: { id: pharmacy.id }, data: { status: 'ACTIVE' } });

    const pharmacyCookies = await signIn('newpharmacy@test.local', 'PharmacyPassword123!');
    expect((await request('/auth/me', { cookies: pharmacyCookies })).body.data).not.toBeNull();

    await request(`/admin/pharmacies/${pharmacy.publicId}/status`, {
      method: 'POST',
      cookies: adminCookies,
      payload: { status: 'SUSPENDED', reason: 'Compliance review' },
    });

    // The session must die at once, not when the cookie expires.
    expect((await request('/auth/me', { cookies: pharmacyCookies })).body.data).toBeNull();
  });

  it('offers only transitions the state machine permits', async () => {
    const cookies = await signInAdmin();
    await request('/onboarding/doctor', { method: 'POST', payload: validDoctor() });
    const doctor = await getPrisma().doctor.findFirstOrThrow();

    const response = await request<{ current: string; allowed: string[] }>(
      `/admin/doctors/${doctor.publicId}/transitions`,
      { cookies },
    );

    expect(response.body.data?.current).toBe('PENDING');
    expect(response.body.data?.allowed).toEqual(['UNDER_REVIEW', 'REJECTED']);
  });
});

describe('authorization isolation', () => {
  it('refuses admin routes to a pharmacy account', async () => {
    await request('/onboarding/pharmacy', { method: 'POST', payload: validPharmacy() });
    const cookies = await signIn('newpharmacy@test.local', 'PharmacyPassword123!');

    const response = await request('/admin/doctors', { cookies });

    expect(response.status).toBe(403);
    expect(response.body.error?.code).toBe('FORBIDDEN');
  });

  it('refuses admin routes to an unauthenticated caller', async () => {
    const response = await request('/admin/pharmacies');
    expect(response.status).toBe(401);
  });

  it('refuses doctor routes to a pharmacy account', async () => {
    await request('/onboarding/pharmacy', { method: 'POST', payload: validPharmacy() });
    const cookies = await signIn('newpharmacy@test.local', 'PharmacyPassword123!');

    const response = await request('/doctor/profile', { cookies });
    expect(response.status).toBe(403);
  });

  it('never exposes ratings or a quality score to a doctor', async () => {
    // Spec §24 and §52 — these must have no route at all, not merely be hidden.
    await request('/onboarding/doctor', { method: 'POST', payload: validDoctor() });
    const cookies = await signIn('newdoctor@test.local', 'DoctorPassword123!');

    const profile = await request('/doctor/profile', { cookies });
    expect(profile.status).toBe(200);

    const serialised = JSON.stringify(profile.body.data);
    expect(serialised).not.toMatch(/qualityScore/i);
    expect(serialised).not.toMatch(/rating/i);
  });
});
