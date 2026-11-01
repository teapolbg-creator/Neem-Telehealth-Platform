import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FacilityReport, FollowUpView } from '@neem/contracts';
import { disconnectPrisma, getPrisma } from '../../src/db/prisma.ts';
import { closeTestApp, request, signIn } from '../helpers/app.ts';
import { createTestUser, resetDatabase } from '../helpers/database.ts';
import { generatePublicId } from '../../src/lib/crypto.ts';
import { goOnline } from '../../src/modules/queue/presence.service.ts';

/**
 * A CHPS facility's report (CHPS slice 2c, D82).
 */

afterAll(async () => {
  await closeTestApp();
  await disconnectPrisma();
});

const PASSWORD = 'ChoPassword123!';

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
  const user = await createTestUser({ email, password: PASSWORD, role: 'FACILITY' });
  await prisma.facilityUser.create({
    data: { facilityId: facility.id, userId: user.id, fullName: `${label} CHO` },
  });
  return { facility, cookies: await signIn(email, PASSWORD) };
}

async function onlineDoctor(online = true) {
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
      fullName: 'Dr. Kwame Boadu',
      mdcNumber: `MDC-P-${suffix}`,
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
  if (online) await goOnline(doctor.id);
  return signIn(email, 'DoctorPassword123!');
}

async function walkIn(cookies: Record<string, string>, name: string, complaint: string) {
  const created = await request<{ patientNumber: string; visitPublicId: string }>(
    '/facility/patients',
    {
      method: 'POST',
      cookies,
      payload: {
        fullName: name,
        sex: 'FEMALE',
        ageYears: 30,
        community: 'Avenorpeme',
        consentGivenBy: 'PATIENT',
        presentingComplaint: complaint,
      },
    },
  );
  return created.body.data!;
}

const triage = (cookies: Record<string, string>, visit: string, category: string) =>
  request(`/facility/visits/${visit}/triage`, {
    method: 'POST',
    cookies,
    payload: { category },
  });

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - n);
  return date.toISOString().slice(0, 10);
};

const report = (cookies: Record<string, string>, from: string, to: string) =>
  request<FacilityReport>(`/facility/report?from=${from}&to=${to}`, { cookies });

describe('the facility report', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('counts a day’s attendance, consultations, referrals and follow-ups', async () => {
    const cho = await facilityWithCho('Alpha');
    const doctor = await onlineDoctor();

    const ama = await walkIn(cho.cookies, 'Ama Owusu', 'Fever for two days');
    const esi = await walkIn(cho.cookies, 'Esi Darko', 'Fell from a tree');
    const kofi = await walkIn(cho.cookies, 'Kofi Asare', 'Cough');
    await triage(cho.cookies, ama.visitPublicId, 'YELLOW');
    await triage(cho.cookies, esi.visitPublicId, 'RED');
    await triage(cho.cookies, kofi.visitPublicId, 'GREEN');

    // Ama sees a doctor to the end.
    await request(`/facility/visits/${ama.visitPublicId}/consultation`, {
      method: 'POST',
      cookies: cho.cookies,
      payload: { languageCode: 'en', type: 'AUDIO' },
    });
    const consultation = await getPrisma().consultation.findFirstOrThrow();
    const path = `/doctor/consultations/${consultation.publicId}`;
    await request(`${path}/accept`, { method: 'POST', cookies: doctor });
    await request(`${path}/media/join`, { method: 'POST', cookies: doctor });
    await request(`${path}/encounter`, {
      method: 'PUT',
      cookies: doctor,
      payload: { content: { clinicalAssessment: 'Malaria likely', treatmentPlan: 'RDT, treat' } },
    });
    await request(`${path}/complete`, {
      method: 'POST',
      cookies: doctor,
      payload: { outcomes: ['ADVICE_ONLY'] },
    });

    // Kofi's request is withdrawn.
    await request(`/facility/visits/${kofi.visitPublicId}/consultation`, {
      method: 'POST',
      cookies: cho.cookies,
      payload: { languageCode: 'en', type: 'AUDIO' },
    });
    await request(`/facility/visits/${kofi.visitPublicId}/consultation/cancel`, {
      method: 'POST',
      cookies: cho.cookies,
      payload: { reason: 'Felt better, went home' },
    });
    await request(`/facility/visits/${kofi.visitPublicId}/close`, {
      method: 'POST',
      cookies: cho.cookies,
      payload: { outcome: 'CLOSED', note: 'Advised' },
    });

    // Esi goes to hospital as an emergency.
    await request(`/facility/visits/${esi.visitPublicId}/referrals`, {
      method: 'POST',
      cookies: cho.cookies,
      payload: {
        urgency: 'EMERGENCY',
        destinationName: 'Hohoe Municipal Hospital',
        reason: 'Suspected fracture',
      },
    });
    await request(`/facility/visits/${esi.visitPublicId}/close`, {
      method: 'POST',
      cookies: cho.cookies,
      payload: { outcome: 'REFERRED', note: 'Ambulance' },
    });

    // Two follow-ups due today: one seen, one still due.
    const first = await request<FollowUpView>(`/facility/visits/${ama.visitPublicId}/follow-ups`, {
      method: 'POST',
      cookies: cho.cookies,
      payload: { dueDate: today(), instructions: 'RDT result' },
    });
    await request(`/facility/visits/${kofi.visitPublicId}/follow-ups`, {
      method: 'POST',
      cookies: cho.cookies,
      payload: { dueDate: today(), instructions: 'Cough check' },
    });
    await request(`/facility/follow-ups/${first.body.data!.publicId}/complete`, {
      method: 'POST',
      cookies: cho.cookies,
      payload: {},
    });

    const result = await report(cho.cookies, today(), today());
    expect(result.status).toBe(200);
    const data = result.body.data!;

    expect(data.attendance).toMatchObject({
      visits: 3,
      newPatients: 3,
      patientsSeen: 3,
      byTriage: { RED: 1, ORANGE: 0, YELLOW: 1, GREEN: 1, NOT_TRIAGED: 0 },
      emergencies: 1,
      outcomes: { CLOSED: 1, REFERRED: 1, CANCELLED: 0, OPEN: 1 },
    });
    expect(data.consultations).toMatchObject({
      requested: 2,
      completed: 1,
      withdrawn: 1,
      noDoctorAvailable: 0,
      inProgress: 0,
    });
    expect(data.consultations.waitMinutes.median).not.toBeNull();
    expect(data.doctors).toEqual([
      expect.objectContaining({ name: 'Dr. Kwame Boadu', completed: 1 }),
    ]);
    expect(data.referrals).toMatchObject({
      issued: 1,
      byUrgency: { EMERGENCY: 1, URGENT: 0, ROUTINE: 0 },
      byStatus: { ISSUED: 1 },
      destinations: [{ name: 'Hohoe Municipal Hospital', count: 1 }],
    });
    expect(data.followUps).toMatchObject({ due: 2, done: 1, missed: 0, stillDue: 1 });
    // Listed as written, not counted by type (D79).
    expect(data.complaints.map((c) => c.text).sort()).toEqual([
      'Cough',
      'Fell from a tree',
      'Fever for two days',
    ]);
    expect(data.days).toEqual([
      expect.objectContaining({
        date: today(),
        visits: 3,
        newPatients: 3,
        consultationsRequested: 2,
        consultationsCompleted: 1,
        referrals: 1,
      }),
    ]);
  });

  it('puts each record on the day it started', async () => {
    const cho = await facilityWithCho('Alpha');
    await walkIn(cho.cookies, 'Ama Owusu', 'Fever');
    await walkIn(cho.cookies, 'Esi Darko', 'Headache');
    const prisma = getPrisma();
    const visit = await prisma.patientVisit.findFirstOrThrow({ orderBy: { arrivedAt: 'asc' } });
    await prisma.patientVisit.update({
      where: { id: visit.id },
      data: { arrivedAt: new Date(`${daysAgo(1)}T09:00:00Z`) },
    });

    const yesterday = (await report(cho.cookies, daysAgo(1), daysAgo(1))).body.data!;
    const now = (await report(cho.cookies, today(), today())).body.data!;
    expect(yesterday.attendance.visits).toBe(1);
    expect(now.attendance.visits).toBe(1);

    const both = (await report(cho.cookies, daysAgo(1), today())).body.data!;
    expect(both.days.map((day) => day.visits)).toEqual([1, 1]);
  });

  it('refuses a backwards or overlong range', async () => {
    const cho = await facilityWithCho('Alpha');
    expect((await report(cho.cookies, today(), daysAgo(1))).status).toBe(400);
    expect((await report(cho.cookies, daysAgo(100), today())).status).toBe(400);
  });

  it('reports only the facility’s own records', async () => {
    const alpha = await facilityWithCho('Alpha');
    const beta = await facilityWithCho('Beta');
    await walkIn(alpha.cookies, 'Ama Owusu', 'Fever');

    const theirs = (await report(beta.cookies, today(), today())).body.data!;
    expect(theirs.attendance.visits).toBe(0);
    expect(theirs.complaints).toEqual([]);
    expect(theirs.facility.name).toBe('Beta CHPS');
  });
});
