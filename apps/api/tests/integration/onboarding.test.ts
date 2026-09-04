import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import { getPrisma, disconnectPrisma } from '../../src/db/prisma.ts';
import { encryptTotpSecret } from '../../src/modules/auth/totp.service.ts';
import { closeTestApp, minimalPng, request, signIn, upload } from '../helpers/app.ts';
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
    await createTestUser({
      email: 'clash@test.local',
      password: 'Whatever123456!',
      role: 'PHARMACY',
    });

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

/**
 * Pharmacy verification (spec §20, §83).
 *
 * This existed for doctors and not for pharmacies. There was no pharmacy
 * document upload route at all, so `verifiedDocumentCount` was structurally
 * always zero and every pharmacy that had ever gone ACTIVE did so without a
 * single document being looked at. An active pharmacy dispenses prescriptions.
 */
describe('pharmacy document verification', () => {
  async function applyAndSignIn() {
    await request('/onboarding/pharmacy', { method: 'POST', payload: validPharmacy() });
    const pharmacy = await getPrisma().pharmacy.findFirstOrThrow();
    const cookies = await signIn('newpharmacy@test.local', 'PharmacyPassword123!');
    return { pharmacy, cookies };
  }

  async function uploadCertificate(cookies: Record<string, string>) {
    return upload<{ id: string }>('/pharmacy/documents', {
      cookies,
      fields: { documentType: 'COUNCIL_REGISTRATION' },
      file: { name: 'cert.png', mimeType: 'image/png', body: minimalPng() },
    });
  }

  it('refuses to activate a pharmacy with no verified documents', async () => {
    const adminCookies = await signInAdmin();
    const { pharmacy } = await applyAndSignIn();

    await getPrisma().pharmacy.update({
      where: { id: pharmacy.id },
      data: { status: 'APPROVED' },
    });

    const activate = await request(`/admin/pharmacies/${pharmacy.publicId}/status`, {
      method: 'POST',
      cookies: adminCookies,
      payload: { status: 'ACTIVE' },
    });

    expect(activate.status).toBe(422);
    expect(activate.body.error?.message).toMatch(/no verified documents/i);
  });

  it('still refuses when documents are uploaded but not yet verified', async () => {
    const adminCookies = await signInAdmin();
    const { pharmacy, cookies } = await applyAndSignIn();

    expect((await uploadCertificate(cookies)).status).toBe(201);

    await getPrisma().pharmacy.update({
      where: { id: pharmacy.id },
      data: { status: 'APPROVED' },
    });

    // Uploading is not verifying. A human must look at the file.
    const activate = await request(`/admin/pharmacies/${pharmacy.publicId}/status`, {
      method: 'POST',
      cookies: adminCookies,
      payload: { status: 'ACTIVE' },
    });

    expect(activate.status).toBe(422);
  });

  it('activates once an admin has verified a document', async () => {
    const adminCookies = await signInAdmin();
    const { pharmacy, cookies } = await applyAndSignIn();

    const uploaded = await uploadCertificate(cookies);

    const verified = await request(`/admin/pharmacies/documents/${uploaded.body.data!.id}/verify`, {
      method: 'POST',
      cookies: adminCookies,
      payload: { verified: true },
    });
    expect(verified.status).toBe(200);

    for (const status of ['UNDER_REVIEW', 'APPROVED', 'ACTIVE']) {
      const response = await request(`/admin/pharmacies/${pharmacy.publicId}/status`, {
        method: 'POST',
        cookies: adminCookies,
        payload: { status },
      });
      expect(response.status, `transition to ${status}`).toBe(200);
    }

    const fresh = await getPrisma().pharmacy.findUniqueOrThrow({ where: { id: pharmacy.id } });
    expect(fresh.status).toBe('ACTIVE');
  });

  it('lets the admin open the document before deciding on it', async () => {
    const adminCookies = await signInAdmin();
    const { cookies } = await applyAndSignIn();

    const uploaded = await uploadCertificate(cookies);

    // Without this route, verification was a decision made blind.
    const file = await request(`/admin/pharmacies/documents/${uploaded.body.data!.id}`, {
      cookies: adminCookies,
    });

    expect(file.status).toBe(200);
    expect(file.raw.headers['content-type']).toBe('image/png');
    expect(file.raw.headers['cache-control']).toBe('private, no-store');
  });

  it('refuses a file whose contents do not match its declared type', async () => {
    const { cookies } = await applyAndSignIn();

    const response = await upload('/pharmacy/documents', {
      cookies,
      fields: { documentType: 'COUNCIL_REGISTRATION' },
      file: { name: 'fake.png', mimeType: 'image/png', body: Buffer.from('this is not a png') },
    });

    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toMatch(/do not match its file type/i);
  });

  it('refuses a document type belonging to the doctor workflow', async () => {
    const { cookies } = await applyAndSignIn();

    const response = await upload('/pharmacy/documents', {
      cookies,
      fields: { documentType: 'MDC_LICENCE' },
      file: { name: 'cert.png', mimeType: 'image/png', body: minimalPng() },
    });

    expect(response.status).toBe(400);
  });

  it('will not let one pharmacy read another pharmacy’s document', async () => {
    const { cookies } = await applyAndSignIn();
    const uploaded = await uploadCertificate(cookies);

    await request('/onboarding/pharmacy', {
      method: 'POST',
      payload: validPharmacy({
        email: 'other@pharmacy.test',
        name: 'Other Pharmacy',
        councilRegistrationNo: 'PCG-TEST-99002',
      }),
    });
    const otherCookies = await signIn('other@pharmacy.test', 'PharmacyPassword123!');

    const response = await request(`/pharmacy/documents/${uploaded.body.data!.id}`, {
      cookies: otherCookies,
    });

    // 404, not 403: confirming another pharmacy's document exists would itself
    // be a disclosure (spec §102).
    expect(response.status).toBe(404);
  });

  it('shows the applicant what is still outstanding', async () => {
    const adminCookies = await signInAdmin();
    const { cookies } = await applyAndSignIn();

    const before = await request<{ outstanding: string[]; verifiedDocumentCount: number }>(
      '/pharmacy/profile',
      { cookies },
    );
    expect(before.status).toBe(200);
    expect(before.body.data!.verifiedDocumentCount).toBe(0);
    expect(before.body.data!.outstanding.join(' ')).toMatch(/upload/i);

    const uploaded = await uploadCertificate(cookies);
    await request(`/admin/pharmacies/documents/${uploaded.body.data!.id}/verify`, {
      method: 'POST',
      cookies: adminCookies,
      payload: { verified: true },
    });

    const after = await request<{ outstanding: string[]; verifiedDocumentCount: number }>(
      '/pharmacy/profile',
      { cookies },
    );
    expect(after.body.data!.verifiedDocumentCount).toBe(1);
    // The upload prompt is gone; the wait-for-review line remains.
    expect(after.body.data!.outstanding.join(' ')).not.toMatch(/upload/i);
  });

  it('refuses the pharmacy profile to an account that is not a pharmacy', async () => {
    const adminCookies = await signInAdmin();
    await applyAndSignIn();

    const response = await request('/pharmacy/profile', { cookies: adminCookies });
    expect(response.status).toBe(403);
  });
});

/**
 * Doctor compensation through the admin route (spec §26, decision D28).
 *
 * The formula was undecided from Phase 0 until 2026-09-01, so nothing computed
 * pay and the fields sat nullable. These cover the part that matters: an admin
 * sets terms, and the amount is derived rather than typed.
 */
describe('doctor compensation', () => {
  async function applicant() {
    await request('/onboarding/doctor', { method: 'POST', payload: validDoctor() });
    return getPrisma().doctor.findFirstOrThrow();
  }

  it('derives full-time pay from the configured baseline', async () => {
    const cookies = await signInAdmin();
    const doctor = await applicant();

    const response = await request<{ compensation: { monthlyMinor: number; isFullTime: boolean } }>(
      `/admin/doctors/${doctor.publicId}/compensation`,
      {
        method: 'PATCH',
        cookies,
        payload: { employmentType: 'FULL_TIME', contractedHoursPerWeek: 40 },
      },
    );

    expect(response.status).toBe(200);
    // GH₵ 8,000.00 in pesewas.
    expect(response.body.data!.compensation.monthlyMinor).toBe(800_000);
    expect(response.body.data!.compensation.isFullTime).toBe(true);
  });

  it('scales part-time pay by contracted hours', async () => {
    const cookies = await signInAdmin();
    const doctor = await applicant();

    const response = await request<{ compensation: { monthlyMinor: number } }>(
      `/admin/doctors/${doctor.publicId}/compensation`,
      {
        method: 'PATCH',
        cookies,
        payload: { employmentType: 'PART_TIME', contractedHoursPerWeek: 20 },
      },
    );

    expect(response.body.data!.compensation.monthlyMinor).toBe(400_000);

    // And it is stored, so payroll reads the derived figure rather than
    // recomputing it from terms that may since have changed.
    const stored = await getPrisma().doctor.findUniqueOrThrow({ where: { id: doctor.id } });
    expect(stored.monthlySalaryMinor).toBe(400_000);
    expect(stored.contractedHoursPerWeek).toBe(20);
  });

  it('offers no way to type a salary directly', async () => {
    const cookies = await signInAdmin();
    const doctor = await applicant();

    // Pay is derived (D28). A typed figure must not override the formula, or
    // two doctors on identical terms could be paid differently.
    await request(`/admin/doctors/${doctor.publicId}/compensation`, {
      method: 'PATCH',
      cookies,
      payload: {
        employmentType: 'PART_TIME',
        contractedHoursPerWeek: 20,
        monthlySalaryMinor: 999_999,
      },
    });

    const stored = await getPrisma().doctor.findUniqueOrThrow({ where: { id: doctor.id } });
    expect(stored.monthlySalaryMinor).toBe(400_000);
  });

  it('refuses hours above the weekly ceiling', async () => {
    const cookies = await signInAdmin();
    const doctor = await applicant();

    const response = await request(`/admin/doctors/${doctor.publicId}/compensation`, {
      method: 'PATCH',
      cookies,
      payload: { employmentType: 'FULL_TIME', contractedHoursPerWeek: 45 },
    });

    expect(response.status).toBe(422);
    expect(response.body.error?.message).toMatch(/40-hour weekly limit/i);
  });

  it('records the change in the audit log', async () => {
    const cookies = await signInAdmin();
    const doctor = await applicant();

    await request(`/admin/doctors/${doctor.publicId}/compensation`, {
      method: 'PATCH',
      cookies,
      payload: { employmentType: 'PART_TIME', contractedHoursPerWeek: 16 },
    });

    const entry = await getPrisma().auditLog.findFirstOrThrow({
      where: { action: 'doctor.compensation.changed', entityId: doctor.id },
    });

    expect(JSON.stringify(entry)).toContain('320000');
  });

  it('refuses a doctor account, however senior', async () => {
    const doctor = await applicant();
    const cookies = await signIn('newdoctor@test.local', 'DoctorPassword123!');

    const response = await request(`/admin/doctors/${doctor.publicId}/compensation`, {
      method: 'PATCH',
      cookies,
      payload: { employmentType: 'FULL_TIME', contractedHoursPerWeek: 40 },
    });

    expect(response.status).toBe(403);
  });
});
