import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import type { ChpsOperationsOverview } from '@neem/contracts';
import { disconnectPrisma, getPrisma } from '../../src/db/prisma.ts';
import { closeTestApp, request, signIn } from '../helpers/app.ts';
import { encryptTotpSecret } from '../../src/modules/auth/totp.service.ts';
import { createTestUser, resetDatabase } from '../helpers/database.ts';
import { generatePublicId } from '../../src/lib/crypto.ts';
import { goOnline } from '../../src/modules/queue/presence.service.ts';

/** Neem operations' live view of CHPS (CHPS slice 3c, D86). */

afterAll(async () => {
  await closeTestApp();
  await disconnectPrisma();
});

async function opsCookies() {
  const email = `${generatePublicId('x').slice(-8).toLowerCase()}@ops.test`;
  const secret = authenticator.generateSecret(20);
  const user = await createTestUser({
    email,
    password: 'OpsPassword123!',
    role: 'OPS_ADMIN',
    twoFactorSecretEnc: encryptTotpSecret(secret),
    twoFactorEnabled: true,
  });
  await getPrisma().admin.create({ data: { userId: user.id, fullName: 'Kofi Ops' } });
  const login = await request<{ challengeId: string }>('/auth/login', {
    method: 'POST',
    payload: { email, password: 'OpsPassword123!' },
  });
  const verify = await request('/auth/2fa/verify', {
    method: 'POST',
    payload: { challengeId: login.body.data!.challengeId, code: authenticator.generate(secret) },
  });
  return verify.cookies;
}

async function facilityWithCho(label: string) {
  const prisma = getPrisma();
  const district = await prisma.district.findFirstOrThrow({ where: { region: { name: 'Volta' } } });
  const facility = await prisma.facility.create({
    data: {
      publicId: generatePublicId('fac'),
      code: `CHPS-${label}`,
      name: `${label} CHPS`,
      type: 'CHPS',
      districtId: district.id,
      community: label,
      status: 'ACTIVE',
      createdByUserId: 'test',
      isDemo: true,
    },
  });
  const email = `cho-${label.toLowerCase()}@chps.test`;
  const user = await createTestUser({ email, password: 'ChoPassword123!', role: 'FACILITY' });
  await prisma.facilityUser.create({
    data: { facilityId: facility.id, userId: user.id, fullName: `${label} CHO` },
  });
  return { facility, cookies: await signIn(email, 'ChoPassword123!') };
}

async function onlineDoctor() {
  const prisma = getPrisma();
  const suffix = generatePublicId('x').slice(-8).toLowerCase();
  const email = `${suffix}@doctor.test`;
  const user = await createTestUser({ email, password: 'DoctorPassword123!', role: 'DOCTOR' });
  const english = await prisma.language.findUniqueOrThrow({ where: { code: 'en' } });
  const expiry = new Date();
  expiry.setFullYear(expiry.getFullYear() + 1);
  const doctor = await prisma.doctor.create({
    data: {
      publicId: generatePublicId('doc'),
      userId: user.id,
      fullName: 'Dr. Abena Sarpong',
      mdcNumber: `MDC-O-${suffix}`,
      qualification: 'MB ChB',
      practiceAddress: 'Ridge Clinic, Accra',
      mdcExpiresAt: expiry,
      status: 'ACTIVE',
      isDemo: true,
      languages: { create: [{ languageId: english.id, isPrimary: true }] },
    },
  });
  const allDay = await prisma.shiftDefinition.upsert({
    where: { code: 'TEST_ALL_DAY' },
    update: { isActive: true },
    create: {
      code: 'TEST_ALL_DAY',
      label: 'Test all-day shift',
      startsAt: '00:00',
      endsAt: '23:59',
      isActive: true,
    },
  });
  const now = new Date();
  await prisma.doctorShiftAssignment.create({
    data: {
      doctorId: doctor.id,
      shiftDefinitionId: allDay.id,
      serviceDate: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())),
      status: 'CONFIRMED',
      minutesPlanned: 1439,
    },
  });
  await goOnline(doctor.id);
  return signIn(email, 'DoctorPassword123!');
}

async function walkIn(cookies: Record<string, string>, category: string) {
  const created = await request<{ visitPublicId: string }>('/facility/patients', {
    method: 'POST',
    cookies,
    payload: {
      fullName: `Patient ${category}`,
      sex: 'FEMALE',
      ageYears: 30,
      community: 'Somewhere',
      consentGivenBy: 'PATIENT',
      presentingComplaint: 'Unwell',
    },
  });
  const { visitPublicId } = created.body.data!;
  await request(`/facility/visits/${visitPublicId}/triage`, {
    method: 'POST',
    cookies,
    payload: { category },
  });
  return visitPublicId;
}

describe('CHPS operations overview (D86)', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('shows each compound’s live state, emergencies first, and who is with a doctor', async () => {
    const alpha = await facilityWithCho('Alpha');
    const beta = await facilityWithCho('Beta');
    const doctor = await onlineDoctor();
    const ops = await opsCookies();

    await walkIn(alpha.cookies, 'RED');
    const yellow = await walkIn(beta.cookies, 'YELLOW');
    await request(`/facility/visits/${yellow}/consultation`, {
      method: 'POST',
      cookies: beta.cookies,
      payload: { languageCode: 'en', type: 'AUDIO' },
    });

    const first = await request<ChpsOperationsOverview>('/admin/chps/overview', { cookies: ops });
    expect(first.status).toBe(200);
    const data = first.body.data!;
    expect(data.totals).toMatchObject({
      facilities: 2,
      activeFacilities: 2,
      visitsToday: 2,
      openEmergencies: 1,
      waitingForDoctor: 1,
      withDoctor: 0,
      doctorsOnline: 1,
    });
    expect(data.facilities.map((f) => f.name)).toEqual(['Alpha CHPS', 'Beta CHPS']);
    expect(data.facilities[1]).toMatchObject({ waitingForDoctor: 1, longestWaitMinutes: 0 });
    expect(data.facilities[0]!.staffLastActiveAt).not.toBeNull();
    expect(data.facilities[0]!.stations).toEqual({ paired: 0, online: 0, lastSeenAt: null });
    expect(data.doctors).toEqual([
      expect.objectContaining({
        name: 'Dr. Abena Sarpong',
        online: true,
        completed: { COUNTER: 0, DIRECT: 0, CHPS: 0 },
      }),
    ]);

    const consultation = await getPrisma().consultation.findFirstOrThrow();
    await request(`/doctor/consultations/${consultation.publicId}/accept`, {
      method: 'POST',
      cookies: doctor,
    });
    const after = await request<ChpsOperationsOverview>('/admin/chps/overview?days=7', {
      cookies: ops,
    });
    expect(after.body.data!.utilisationDays).toBe(7);
    expect(after.body.data!.totals).toMatchObject({ waitingForDoctor: 0, withDoctor: 1 });
  });

  it('is operations’ alone, over 1, 7 or 30 days', async () => {
    const alpha = await facilityWithCho('Alpha');
    const ops = await opsCookies();
    expect((await request('/admin/chps/overview?days=5', { cookies: ops })).status).toBe(400);
    expect((await request('/admin/chps/overview', { cookies: alpha.cookies })).status).toBe(403);
  });
});
