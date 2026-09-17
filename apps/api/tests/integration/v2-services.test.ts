import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import { getPrisma, disconnectPrisma } from '../../src/db/prisma.ts';
import { closeTestApp, request, signIn } from '../helpers/app.ts';
import {
  createTestPharmacy,
  createTestUser,
  resetDatabase,
  setDirectChannelEnabled,
} from '../helpers/database.ts';
import { encryptTotpSecret } from '../../src/modules/auth/totp.service.ts';
import { getBookableService } from '../../src/modules/service/service.service.ts';

/**
 * The service catalogue and its prices (v2, plan phase 2).
 *
 * The counter sells one thing at one price from a setting. V2 sells several at
 * prices that move apart, and the patient must see the full charge before
 * paying — so the catalogue is the thing being proved here: what it shows a
 * patient, who may change it, and that a change is recorded.
 *
 * Nothing books anything yet. The public list stays empty until the
 * patient-direct service is switched on, which is what the first test covers.
 */

const ADMIN = { email: 'admin@services.test', password: 'AdminPassword123!' };
const PHARMACY = { email: 'pharmacy@services.test', password: 'PharmacyPassword123!' };

interface PublicCatalogue {
  enabled: boolean;
  services: Array<{ code: string; price: { amountMinor: number; currency: string } }>;
}

beforeEach(resetDatabase);

afterAll(async () => {
  await closeTestApp();
  await disconnectPrisma();
});

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

async function pharmacyCookies() {
  const prisma = getPrisma();
  const pharmacy = await createTestPharmacy('Catalogue Pharmacy', 'ACTIVE');
  const user = await createTestUser({ ...PHARMACY, role: 'PHARMACY' });
  await prisma.pharmacyUser.create({ data: { pharmacyId: pharmacy.id, userId: user.id } });

  return signIn(PHARMACY.email, PHARMACY.password);
}

describe('what a patient is shown', () => {
  it('is nothing at all while the patient-direct service is switched off', async () => {
    const response = await request<PublicCatalogue>('/patient/services');

    expect(response.status).toBe(200);
    expect(response.body.data?.enabled).toBe(false);
    expect(response.body.data?.services).toEqual([]);
  });

  it('is the seeded catalogue, with the price of each, once it is on', async () => {
    await setDirectChannelEnabled(true);

    const response = await request<PublicCatalogue>('/patient/services');
    const byCode = new Map(response.body.data!.services.map((s) => [s.code, s]));

    expect(response.body.data?.enabled).toBe(true);
    // GHS 50 and GHS 100, in pesewas, as agreed for launch.
    expect(byCode.get('GENERAL_CONSULTATION')?.price).toEqual({
      amountMinor: 5000,
      currency: 'GHS',
    });
    expect(byCode.get('WEIGHT_LOSS_DOCTOR')?.price.amountMinor).toBe(10000);
    expect(byCode.get('WEIGHT_LOSS_DIETITIAN')?.price.amountMinor).toBe(10000);
    expect(byCode.get('WEIGHT_LOSS_TRAINER')?.price.amountMinor).toBe(10000);
  });

  it('never includes a service an administrator has withdrawn', async () => {
    await setDirectChannelEnabled(true);
    const cookies = await adminCookies();

    const withdrawn = await request('/admin/services/WEIGHT_LOSS_TRAINER', {
      method: 'PATCH',
      cookies,
      payload: { isActive: false },
    });
    expect(withdrawn.status).toBe(200);

    const listed = await request<PublicCatalogue>('/patient/services');
    expect(listed.body.data?.services.map((s) => s.code)).not.toContain('WEIGHT_LOSS_TRAINER');

    // And it cannot be booked by naming it directly.
    await expect(getBookableService('WEIGHT_LOSS_TRAINER')).rejects.toThrow(
      /not currently offered/,
    );
  });
});

describe('administering the catalogue', () => {
  it('adds a service, and refuses a second one with the same code', async () => {
    const cookies = await adminCookies();

    const created = await request<{ code: string }>('/admin/services', {
      method: 'POST',
      cookies,
      payload: {
        code: 'WEIGHT_LOSS_REVIEW',
        name: 'Weight-loss review',
        clinic: 'WEIGHT_LOSS',
        discipline: 'DOCTOR',
        priceMinor: 7500,
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.data?.code).toBe('WEIGHT_LOSS_REVIEW');

    const duplicate = await request('/admin/services', {
      method: 'POST',
      cookies,
      payload: {
        code: 'WEIGHT_LOSS_REVIEW',
        name: 'Another one',
        clinic: 'WEIGHT_LOSS',
        discipline: 'DOCTOR',
        priceMinor: 9000,
      },
    });
    expect(duplicate.status).toBe(409);
  });

  it('records what a price was and what it became', async () => {
    const cookies = await adminCookies();

    const updated = await request<{ price: { amountMinor: number } }>(
      '/admin/services/GENERAL_CONSULTATION',
      { method: 'PATCH', cookies, payload: { priceMinor: 6000 } },
    );
    expect(updated.status).toBe(200);
    expect(updated.body.data?.price.amountMinor).toBe(6000);

    const audit = await getPrisma().auditLog.findFirst({
      where: { action: 'service.updated' },
      orderBy: { occurredAt: 'desc' },
    });
    expect(audit?.metadata).toMatchObject({
      code: 'GENERAL_CONSULTATION',
      priceMinorBefore: 5000,
      priceMinorAfter: 6000,
    });
  });

  it('is closed to a pharmacy', async () => {
    const cookies = await pharmacyCookies();

    expect((await request('/admin/services', { cookies })).status).toBe(403);
    expect(
      (
        await request('/admin/services', {
          method: 'POST',
          cookies,
          payload: {
            code: 'SNEAKY',
            name: 'Not allowed',
            clinic: 'GENERAL',
            discipline: 'DOCTOR',
            priceMinor: 100,
          },
        })
      ).status,
    ).toBe(403);
  });
});
