import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { disconnectPrisma, getPrisma } from '../../src/db/prisma.ts';
import { authenticator } from 'otplib';
import { closeTestApp, request } from '../helpers/app.ts';
import { encryptTotpSecret } from '../../src/modules/auth/totp.service.ts';
import { createTestUser, resetDatabase } from '../helpers/database.ts';
import { generatePublicId } from '../../src/lib/crypto.ts';
import {
  OFFERED_PROFESSIONAL_DISCIPLINES,
  PROFESSIONAL_DISCIPLINES,
  permissionsForProfessional,
  disciplineMayPrescribe,
} from '@neem/contracts';

/**
 * Dietitians, personal trainers and the weight-loss clinic are withdrawn (D69).
 *
 * This replaces `v2-disciplines.test.ts` and `v2-weight-loss-clinic.test.ts`,
 * which asserted that the three professions divided the work correctly. That
 * division no longer exists, so those assertions could only be deleted — but
 * deleting them without putting anything back would leave the *withdrawal*
 * untested, and a withdrawal that nothing checks is one a later change can
 * quietly undo.
 *
 * So: none of them can be created, and what the data already says about them is
 * still read correctly.
 */
/**
 * An admin session. 2FA is mandatory for ADMIN, so a plain sign-in only gets
 * as far as the challenge.
 */
async function adminCookies() {
  const email = `${generatePublicId('x').slice(-8)}@admin.test`;
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

describe('the withdrawn professions', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeTestApp();
    await disconnectPrisma();
  });

  it('offers only one profession, while still knowing the others existed', () => {
    expect([...OFFERED_PROFESSIONAL_DISCIPLINES]).toEqual(['DOCTOR']);

    /*
     * The full list stays. `ProfessionalEarning.discipline` is a historical
     * snapshot, and a statement read years from now has to say what the
     * professional was — so this is what the data may contain, and the list
     * above is what Neem offers.
     */
    expect([...PROFESSIONAL_DISCIPLINES]).toContain('DIETITIAN');
    expect([...PROFESSIONAL_DISCIPLINES]).toContain('TRAINER');
  });

  it('still withholds prescribing from a record that says dietitian', () => {
    // Not reachable through the product any more; asserted because the rule
    // must not quietly soften if one of these records is ever read again.
    expect(disciplineMayPrescribe('DIETITIAN')).toBe(false);
    expect(disciplineMayPrescribe('TRAINER')).toBe(false);
    expect(disciplineMayPrescribe('DOCTOR')).toBe(true);

    const dietitian = permissionsForProfessional('DOCTOR', 'DIETITIAN');
    expect(dietitian).not.toContain('prescription:create');
    expect(dietitian).not.toContain('referral:create');
  });

  it('refuses an application to practise as anything but a doctor', async () => {
    const response = await request('/onboarding/doctor', {
      method: 'POST',
      payload: {
        email: `${generatePublicId('x').slice(-8)}@applicant.test`,
        password: 'ApplicantPassword123!',
        fullName: 'Adjoa Nkrumah',
        discipline: 'DIETITIAN',
        qualifiedAt: '2015-06-01',
        yearsExperience: 8,
        phone: '0240000111',
        languageCodes: ['en'],
      },
    });

    expect(response.status).toBe(400);
  });

  it('refuses to make an existing professional a dietitian', async () => {
    const cookies = await adminCookies();
    const suffix = generatePublicId('x').slice(-8);

    // The reset seeds reference data, not people, so this makes its own.
    const user = await createTestUser({
      email: `${suffix}@doctor.test`,
      password: 'DoctorPassword123!',
      role: 'DOCTOR',
    });
    const doctor = await getPrisma().doctor.create({
      data: {
        publicId: generatePublicId('doc'),
        userId: user.id,
        fullName: 'Kofi Mensah',
        discipline: 'DOCTOR',
        mdcNumber: `MDC-${suffix}`,
        status: 'ACTIVE',
      },
      select: { publicId: true },
    });

    const response = await request(`/admin/doctors/${doctor.publicId}/profession`, {
      method: 'PATCH',
      cookies,
      payload: { discipline: 'TRAINER' },
    });

    expect(response.status).toBe(400);

    // And they are still a doctor.
    const after = await getPrisma().doctor.findUniqueOrThrow({
      where: { publicId: doctor.publicId },
      select: { discipline: true },
    });
    expect(after.discipline).toBe('DOCTOR');
  });

  it('seeds no weight-loss service, so none can be booked', async () => {
    const services = await getPrisma().service.findMany({ select: { code: true, clinic: true } });

    expect(services.map((service) => service.code)).not.toContain('WEIGHT_LOSS_DOCTOR');
    expect(services.every((service) => service.clinic === 'GENERAL')).toBe(true);
  });

  it('refuses to create a service in the withdrawn clinic', async () => {
    const cookies = await adminCookies();

    const response = await request('/admin/services', {
      method: 'POST',
      cookies,
      payload: {
        code: 'WEIGHT_LOSS_RETURN',
        name: 'Weight-loss clinic',
        clinic: 'WEIGHT_LOSS',
        discipline: 'DIETITIAN',
        priceMinor: 10000,
      },
    });

    expect(response.status).toBe(400);
  });
});
