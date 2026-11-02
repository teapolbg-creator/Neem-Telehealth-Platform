import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Feed } from '@neem/contracts';
import { disconnectPrisma, getPrisma } from '../../src/db/prisma.ts';
import { closeTestApp, request, signIn } from '../helpers/app.ts';
import { createTestUser, resetDatabase } from '../helpers/database.ts';
import { generatePublicId } from '../../src/lib/crypto.ts';
import { goOnline } from '../../src/modules/queue/presence.service.ts';
import { purgeOldFeedEvents } from '../../src/modules/notification/feed.service.ts';

/** The in-app notification feed (CHPS slice 5b, D92). */

afterAll(async () => {
  await closeTestApp();
  await disconnectPrisma();
});

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

async function doctorOnDuty() {
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
      fullName: 'Dr. Feed',
      mdcNumber: `MDC-E-${suffix}`,
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
  return { doctor, cookies: await signIn(email, 'DoctorPassword123!') };
}

const feedOf = async (cookies: Record<string, string>) =>
  (await request<Feed>('/notifications/feed', { cookies })).body.data!;

async function requested(cookies: Record<string, string>, fullName: string) {
  const registered = await request<{ patientNumber: string; visitPublicId: string }>(
    '/facility/patients',
    {
      method: 'POST',
      cookies,
      payload: {
        fullName,
        sex: 'FEMALE',
        ageYears: 28,
        community: 'Avenorpeme',
        consentGivenBy: 'PATIENT',
        presentingComplaint: 'A complaint that must never be copied',
      },
    },
  );
  const { patientNumber, visitPublicId } = registered.body.data!;
  await request(`/facility/visits/${visitPublicId}/triage`, {
    method: 'POST',
    cookies,
    payload: { category: 'YELLOW' },
  });
  await request(`/facility/visits/${visitPublicId}/consultation`, {
    method: 'POST',
    cookies,
    payload: { languageCode: 'en', type: 'VIDEO' },
  });
  return { patientNumber, visitPublicId };
}

describe('the notification feed (D92)', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('tells each person only what concerns them, from live records, storing no text', async () => {
    const alpha = await facilityWithCho('Alpha');
    const beta = await facilityWithCho('Beta');
    const doctor = await doctorOnDuty();

    const { patientNumber } = await requested(alpha.cookies, 'Efua Asante');

    const offered = await feedOf(doctor.cookies);
    expect(offered.unread).toBe(1);
    expect(offered.items[0]).toMatchObject({
      type: 'CONSULTATION_OFFERED',
      label: 'New consultation request',
      detail: 'Alpha CHPS',
      href: '/doctor/queue',
    });
    // A doctor who has not accepted is not told who the patient is here.
    expect(JSON.stringify(offered)).not.toContain('Efua');

    const consultation = await getPrisma().consultation.findFirstOrThrow();
    await request(`/doctor/consultations/${consultation.publicId}/accept`, {
      method: 'POST',
      cookies: doctor.cookies,
    });

    const told = await feedOf(alpha.cookies);
    expect(told.items[0]).toMatchObject({
      type: 'DOCTOR_ACCEPTED',
      detail: 'Efua Asante',
      href: `/facility/patients/${patientNumber}`,
    });

    // Another compound hears nothing of it.
    expect((await feedOf(beta.cookies)).items).toHaveLength(0);

    // Nothing stored says anything about the patient but their card number.
    const stored = JSON.stringify(await getPrisma().feedEvent.findMany());
    expect(stored).not.toContain('Efua');
    expect(stored).not.toContain('complaint');
  });

  it('counts what is new until it has been opened', async () => {
    const alpha = await facilityWithCho('Alpha');
    const doctor = await doctorOnDuty();
    await requested(alpha.cookies, 'Efua Asante');
    const consultation = await getPrisma().consultation.findFirstOrThrow();
    await request(`/doctor/consultations/${consultation.publicId}/accept`, {
      method: 'POST',
      cookies: doctor.cookies,
    });

    expect((await feedOf(alpha.cookies)).unread).toBe(1);
    await request('/notifications/feed/read', { method: 'POST', cookies: alpha.cookies });
    const after = await feedOf(alpha.cookies);
    expect(after.unread).toBe(0);
    expect(after.items).toHaveLength(1);
  });

  it('tells the compound of its own referrals and follow-ups', async () => {
    const alpha = await facilityWithCho('Alpha');
    const registered = await request<{ visitPublicId: string }>('/facility/patients', {
      method: 'POST',
      cookies: alpha.cookies,
      payload: {
        fullName: 'Kofi Boateng',
        sex: 'MALE',
        ageYears: 40,
        community: 'Alpha',
        consentGivenBy: 'PATIENT',
        presentingComplaint: 'Chest pain',
      },
    });
    const visit = registered.body.data!.visitPublicId;
    const referral = await request(`/facility/visits/${visit}/referrals`, {
      method: 'POST',
      cookies: alpha.cookies,
      payload: {
        destinationName: 'Ho Teaching Hospital',
        urgency: 'URGENT',
        reason: 'Needs an ECG',
      },
    });
    expect(referral.status).toBe(201);

    const { items } = await feedOf(alpha.cookies);
    expect(items.map((item) => item.type)).toContain('REFERRAL_ISSUED');
    expect(items.find((item) => item.type === 'REFERRAL_ISSUED')!.detail).toBe('Kofi Boateng');
  });

  it('forgets old entries, and is closed to anyone without a feed', async () => {
    const prisma = getPrisma();
    await prisma.feedEvent.createMany({
      data: [
        {
          audience: 'ADMINS',
          type: 'DOCTOR_BUSY',
          reference: 'x',
          occurredAt: new Date(Date.now() - 100 * 86_400_000),
        },
        { audience: 'ADMINS', type: 'DOCTOR_BUSY', reference: 'y' },
      ],
    });
    expect(await purgeOldFeedEvents()).toBe(1);
    expect(await prisma.feedEvent.count()).toBe(1);

    expect((await request('/notifications/feed')).status).toBe(401);
  });
});
