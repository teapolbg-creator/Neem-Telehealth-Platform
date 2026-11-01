import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import type { StationPairing, SystemMonitoring } from '@neem/contracts';
import { disconnectPrisma, getPrisma } from '../../src/db/prisma.ts';
import { closeTestApp, request, signIn } from '../helpers/app.ts';
import { encryptTotpSecret } from '../../src/modules/auth/totp.service.ts';
import { createTestUser, resetDatabase } from '../helpers/database.ts';
import { generatePublicId } from '../../src/lib/crypto.ts';

/** System monitoring (CHPS slice 3d, D87). */

afterAll(async () => {
  await closeTestApp();
  await disconnectPrisma();
});

async function adminCookies(role: 'ADMIN' | 'OPS_ADMIN') {
  const email = `${generatePublicId('x').slice(-8).toLowerCase()}@admin.test`;
  const secret = authenticator.generateSecret(20);
  const user = await createTestUser({
    email,
    password: 'AdminPassword123!',
    role,
    twoFactorSecretEnc: encryptTotpSecret(secret),
    twoFactorEnabled: true,
  });
  await getPrisma().admin.create({ data: { userId: user.id, fullName: `Test ${role}` } });
  const login = await request<{ challengeId: string }>('/auth/login', {
    method: 'POST',
    payload: { email, password: 'AdminPassword123!' },
  });
  const verify = await request('/auth/2fa/verify', {
    method: 'POST',
    payload: { challengeId: login.body.data!.challengeId, code: authenticator.generate(secret) },
  });
  return verify.cookies;
}

async function facilityWithCho() {
  const prisma = getPrisma();
  const district = await prisma.district.findFirstOrThrow({ where: { region: { name: 'Volta' } } });
  const facility = await prisma.facility.create({
    data: {
      publicId: generatePublicId('fac'),
      code: 'CHPS-ALPHA',
      name: 'Alpha CHPS',
      type: 'CHPS',
      districtId: district.id,
      community: 'Alpha',
      status: 'ACTIVE',
      createdByUserId: 'test',
      isDemo: true,
    },
  });
  const user = await createTestUser({
    email: 'cho@chps.test',
    password: 'ChoPassword123!',
    role: 'FACILITY',
  });
  await prisma.facilityUser.create({
    data: { facilityId: facility.id, userId: user.id, fullName: 'Alpha CHO' },
  });
  return signIn('cho@chps.test', 'ChoPassword123!');
}

async function pairStation(cookies: Record<string, string>, label: string) {
  const created = await request<StationPairing>('/facility/stations', {
    method: 'POST',
    cookies,
    payload: { label },
  });
  const paired = await request('/station/pair', {
    method: 'POST',
    payload: { code: created.body.data!.pairingCode },
  });
  expect(paired.status).toBe(200);
  return created.body.data!.station.publicId;
}

describe('system monitoring (D87)', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('counts sessions, stations and security events, and lists events for the super administrator only', async () => {
    const cho = await facilityWithCho();
    await pairStation(cho, 'Room 1');
    const silent = await pairStation(cho, 'Room 2');
    await getPrisma().facilityStation.update({
      where: { publicId: silent },
      data: { lastSeenAt: new Date(Date.now() - 2 * 3_600_000) },
    });

    const wrongCode = await request('/station/pair', {
      method: 'POST',
      payload: { code: 'ZZZZZZZZ' },
    });
    expect(wrongCode.status).toBe(401);
    const wrongPassword = await request('/auth/login', {
      method: 'POST',
      payload: { email: 'cho@chps.test', password: 'NotThePassword1!' },
    });
    expect(wrongPassword.status).toBe(401);

    const admin = await adminCookies('ADMIN');
    const ops = await adminCookies('OPS_ADMIN');

    const asAdmin = await request<SystemMonitoring>('/admin/monitoring', { cookies: admin });
    expect(asAdmin.status).toBe(200);
    const data = asAdmin.body.data!;
    expect(data.windowHours).toBe(24);
    expect(data.sessions.byRole).toMatchObject({ FACILITY: 1, ADMIN: 1, OPS_ADMIN: 1 });
    expect(data.stations).toMatchObject({ paired: 2, online: 1 });
    expect(data.stations.offline).toEqual([
      expect.objectContaining({ publicId: silent, label: 'Room 2', facilityName: 'Alpha CHPS' }),
    ]);
    expect(data.security).toMatchObject({ loginFailures: 1, pairingRefusals: 1 });
    expect(data.security.recent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'Sign-in failed',
          account: { email: 'cho@chps.test', role: 'FACILITY' },
        }),
        expect.objectContaining({
          label: 'Station pairing refused',
          account: null,
          reason: 'unknown_code',
        }),
      ]),
    );
    // The guessed code is never written down.
    expect(JSON.stringify(data)).not.toContain('ZZZZZZZZ');

    const asOps = await request<SystemMonitoring>('/admin/monitoring?hours=168', { cookies: ops });
    expect(asOps.body.data!.windowHours).toBe(168);
    expect(asOps.body.data!.security.loginFailures).toBe(1);
    expect(asOps.body.data!.security.recent).toBeNull();
  });

  it('is the administrators’ alone, over 24 or 168 hours', async () => {
    const cho = await facilityWithCho();
    const ops = await adminCookies('OPS_ADMIN');
    expect((await request('/admin/monitoring?hours=5', { cookies: ops })).status).toBe(400);
    expect((await request('/admin/monitoring', { cookies: cho })).status).toBe(403);
  });
});
