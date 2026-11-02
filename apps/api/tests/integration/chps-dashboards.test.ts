import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import type {
  ChpsOperationsOverview,
  FacilityDaySummary,
  StationPairing,
  StationSummary,
  SystemMonitoring,
} from '@neem/contracts';
import { disconnectPrisma, getPrisma } from '../../src/db/prisma.ts';
import { closeTestApp, request, signIn } from '../helpers/app.ts';
import { encryptTotpSecret } from '../../src/modules/auth/totp.service.ts';
import { createTestUser, resetDatabase } from '../helpers/database.ts';
import { generatePublicId } from '../../src/lib/crypto.ts';

/** The remaining dashboard figures and station devices (CHPS slice 5d, D94). */

afterAll(async () => {
  await closeTestApp();
  await disconnectPrisma();
});

async function adminCookies() {
  const email = `${generatePublicId('x').slice(-8).toLowerCase()}@admin.test`;
  const secret = authenticator.generateSecret(20);
  const user = await createTestUser({
    email,
    password: 'AdminPassword123!',
    role: 'ADMIN',
    twoFactorSecretEnc: encryptTotpSecret(secret),
    twoFactorEnabled: true,
  });
  await getPrisma().admin.create({ data: { userId: user.id, fullName: 'Test admin' } });
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

async function chocookies() {
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

describe('dashboards (D94)', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('shows the CHO referrals awaiting news, and says when there is nothing to average', async () => {
    const cho = await chocookies();
    const registered = await request<{ visitPublicId: string }>('/facility/patients', {
      method: 'POST',
      cookies: cho,
      payload: {
        fullName: 'Kofi Boateng',
        sex: 'MALE',
        ageYears: 40,
        community: 'Alpha',
        consentGivenBy: 'PATIENT',
        presentingComplaint: 'Chest pain',
      },
    });
    await request(`/facility/visits/${registered.body.data!.visitPublicId}/referrals`, {
      method: 'POST',
      cookies: cho,
      payload: {
        destinationName: 'Ho Teaching Hospital',
        urgency: 'URGENT',
        reason: 'Needs an ECG',
      },
    });

    const day = (await request<FacilityDaySummary>('/facility/today', { cookies: cho })).body.data!;
    expect(day).toMatchObject({
      awaitingReferral: 1,
      consultationsCompletedToday: 0,
      averageWaitMinutes: null,
    });
  });

  it("gives operations all-time totals and every station's device as reported", async () => {
    const cho = await chocookies();
    const admin = await adminCookies();
    await request('/facility/patients', {
      method: 'POST',
      cookies: cho,
      payload: {
        fullName: 'Kofi Boateng',
        sex: 'MALE',
        ageYears: 40,
        community: 'Alpha',
        consentGivenBy: 'PATIENT',
        presentingComplaint: 'Chest pain',
      },
    });

    const overview = await request<ChpsOperationsOverview>('/admin/chps/overview', {
      cookies: admin,
    });
    expect(overview.body.data!.totals).toMatchObject({
      patientsRegistered: 1,
      consultations: 0,
      consultationsInterrupted: 0,
      referralsIssued: 0,
    });

    const created = await request<StationPairing>('/facility/stations', {
      method: 'POST',
      cookies: cho,
      payload: { label: 'Room 1' },
    });
    const paired = await request('/station/pair', {
      method: 'POST',
      payload: { code: created.body.data!.pairingCode },
    });

    const quiet = await request<SystemMonitoring>('/admin/monitoring', { cookies: admin });
    expect(quiet.body.data!.stations.all[0]).toMatchObject({ link: null, device: null });
    expect(quiet.body.data!.activeVideoSessions).toBe(0);

    const reported = await request('/station/connection-check', {
      method: 'POST',
      cookies: paired.cookies,
      headers: { 'x-neem-station': '1' },
      payload: {
        downKbps: 800,
        upKbps: 200,
        rttMs: 300,
        device: {
          batteryPercent: null,
          charging: null,
          hasCamera: true,
          hasMicrophone: false,
          browser: 'Chrome 120',
        },
      },
    });
    expect(reported.status).toBe(200);

    const after = await request<SystemMonitoring>('/admin/monitoring', { cookies: admin });
    expect(after.body.data!.stations.all[0]).toMatchObject({
      label: 'Room 1',
      facilityName: 'Alpha CHPS',
      link: { downKbps: 800 },
      // A browser that will not give its battery is not reported as empty.
      device: {
        batteryPercent: null,
        hasCamera: true,
        hasMicrophone: false,
        browser: 'Chrome 120',
      },
    });

    const mine = await request<StationSummary[]>('/facility/stations', { cookies: cho });
    expect(mine.body.data![0]!.device).toMatchObject({ hasMicrophone: false });
  });
});
