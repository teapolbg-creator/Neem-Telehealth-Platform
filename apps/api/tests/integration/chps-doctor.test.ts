import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { DoctorHistory, PatientRecord } from '@neem/contracts';
import { disconnectPrisma, getPrisma } from '../../src/db/prisma.ts';
import { closeTestApp, request, signIn } from '../helpers/app.ts';
import { createTestUser, resetDatabase } from '../helpers/database.ts';
import { generatePublicId } from '../../src/lib/crypto.ts';
import { goOnline } from '../../src/modules/queue/presence.service.ts';
import {
  enforceResponseWindow,
  processWaitingQueue,
} from '../../src/modules/queue/allocation.service.ts';
import { fixedClock } from '../../src/lib/clock.ts';

/** Busy, declining, priority and history (CHPS slice 5a, D91). */

afterAll(async () => {
  await closeTestApp();
  await disconnectPrisma();
});

async function facilityWithCho(label = 'Alpha') {
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

async function doctorOnDuty(name: string, online = true) {
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
      fullName: name,
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
  if (online) await goOnline(doctor.id);
  return { doctor, cookies: await signIn(email, 'DoctorPassword123!') };
}

/** Registered, triaged and asked for. Returns the consultation's reference. */
async function requested(cookies: Record<string, string>, fullName: string, priority?: string) {
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
        presentingComplaint: 'Fever for three days',
      },
    },
  );
  const { patientNumber, visitPublicId } = registered.body.data!;
  await request(`/facility/visits/${visitPublicId}/triage`, {
    method: 'POST',
    cookies,
    payload: { category: 'YELLOW', vitals: { temperatureC: 38.4 } },
  });
  const asked = await request(`/facility/visits/${visitPublicId}/consultation`, {
    method: 'POST',
    cookies,
    payload: { languageCode: 'en', type: 'VIDEO', ...(priority ? { priority } : {}) },
  });
  expect(asked.status).toBe(201);
  const row = await getPrisma().consultation.findFirstOrThrow({
    where: { visit: { publicId: visitPublicId } },
  });
  return { publicId: row.publicId, patientNumber, visitPublicId };
}

interface Offer {
  offer: {
    consultationPublicId: string;
    chps: { vitals: { temperatureC?: number } | null; priority: string } | null;
  } | null;
}
const offerFor = async (cookies: Record<string, string>) =>
  (await request<Offer>('/doctor/queue', { cookies })).body.data!.offer;

describe('doctor availability (D91)', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('offers nothing to a doctor who says they are busy, until they say otherwise', async () => {
    const cho = await facilityWithCho();
    const doctor = await doctorOnDuty('Dr. Busy');

    const busy = await request('/doctor/presence/busy', {
      method: 'POST',
      cookies: doctor.cookies,
    });
    expect(busy.status).toBe(200);
    const presence = await request<{ busy: boolean; online: boolean; blockedBy: string }>(
      '/doctor/presence',
      { cookies: doctor.cookies },
    );
    expect(presence.body.data).toMatchObject({ busy: true, online: true });
    expect(presence.body.data!.blockedBy).toMatch(/busy/);

    await requested(cho.cookies, 'Efua Asante');
    expect(await offerFor(doctor.cookies)).toBeNull();

    await request('/doctor/presence/online', {
      method: 'POST',
      cookies: doctor.cookies,
      payload: {},
    });
    await processWaitingQueue();
    expect(await offerFor(doctor.cookies)).not.toBeNull();
  });

  it('will not make somebody on a break busy', async () => {
    const doctor = await doctorOnDuty('Dr. Away', false);
    const refused = await request('/doctor/presence/busy', {
      method: 'POST',
      cookies: doctor.cookies,
    });
    expect(refused.status).toBe(422);
  });
});

describe('declining a CHPS offer (D91)', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('goes to another doctor, never back to this one, and is not held against them', async () => {
    const cho = await facilityWithCho();
    const first = await doctorOnDuty('Dr. First');
    const second = await doctorOnDuty('Dr. Second');
    const { publicId } = await requested(cho.cookies, 'Efua Asante');

    const firstOffer = await offerFor(first.cookies);
    const holder = firstOffer ? first : second;
    const other = firstOffer ? second : first;
    expect((await offerFor(holder.cookies))!.chps!.vitals).toEqual({ temperatureC: 38.4 });

    const declined = await request(`/doctor/consultations/${publicId}/decline`, {
      method: 'POST',
      cookies: holder.cookies,
    });
    expect(declined.status).toBe(200);

    expect(await offerFor(holder.cookies)).toBeNull();
    expect((await offerFor(other.cookies))!.consultationPublicId).toBe(publicId);

    await processWaitingQueue();
    expect(await offerFor(holder.cookies)).toBeNull();

    const prisma = getPrisma();
    expect(await prisma.doctorPerformanceEvent.count()).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'queue.doctor.declined-offer' } })).toBe(
      1,
    );

    // Nothing to decline any more.
    const again = await request(`/doctor/consultations/${publicId}/decline`, {
      method: 'POST',
      cookies: holder.cookies,
    });
    expect(again.status).toBe(404);
  });

  it('keeps a patient who has paid out of it, and the CHO is told nobody accepted', async () => {
    const cho = await facilityWithCho();
    const doctor = await doctorOnDuty('Dr. Only');
    const { publicId, patientNumber } = await requested(cho.cookies, 'Efua Asante');

    await getPrisma().consultation.update({
      where: { publicId },
      data: { channel: 'COUNTER' },
    });
    const refused = await request(`/doctor/consultations/${publicId}/decline`, {
      method: 'POST',
      cookies: doctor.cookies,
    });
    expect(refused.status).toBe(422);

    await getPrisma().consultation.update({ where: { publicId }, data: { channel: 'CHPS' } });
    await request(`/doctor/consultations/${publicId}/decline`, {
      method: 'POST',
      cookies: doctor.cookies,
    });
    const record = await request<PatientRecord>(`/facility/patients/${patientNumber}`, {
      cookies: cho.cookies,
    });
    const consultation = record.body.data!.visits[0]!.consultation!;
    expect(consultation.doctorName).toBeNull();
    expect(['REASSIGNING', 'WAITING_FOR_DOCTOR']).toContain(consultation.state);
  });
});

describe('a request withdrawn while on offer (D91)', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('frees the doctor at once, and is never recorded as a missed response', async () => {
    const cho = await facilityWithCho();
    const doctor = await doctorOnDuty('Dr. Offered');
    const { visitPublicId, publicId } = await requested(cho.cookies, 'Efua Asante');
    expect((await offerFor(doctor.cookies))!.consultationPublicId).toBe(publicId);

    const withdrawn = await request(`/facility/visits/${visitPublicId}/consultation/cancel`, {
      method: 'POST',
      cookies: cho.cookies,
      payload: { reason: 'Patient went home' },
    });
    expect(withdrawn.status).toBe(200);
    expect(await offerFor(doctor.cookies)).toBeNull();

    // The next patient reaches them now, not when the old window runs out.
    const next = await requested(cho.cookies, 'Akua Mensah');
    expect((await offerFor(doctor.cookies))!.consultationPublicId).toBe(next.publicId);

    await enforceResponseWindow(getPrisma(), fixedClock(Date.now() + 120_000));
    const prisma = getPrisma();
    const old = await prisma.consultationAssignment.findFirstOrThrow({
      where: { consultation: { publicId } },
    });
    expect(old.result).toBe('WITHDRAWN');
    // Only the next patient's offer, which really did go unanswered, counts against them.
    expect(
      await prisma.doctorPerformanceEvent.count({ where: { consultationId: old.consultationId } }),
    ).toBe(0);
  });
});

describe('consultation priority (D91)', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('offers an urgent request first when a doctor comes free, whatever arrived first', async () => {
    const cho = await facilityWithCho();
    const doctor = await doctorOnDuty('Dr. Scarce', false);

    const routine = await requested(cho.cookies, 'Routine Patient');
    const urgent = await requested(cho.cookies, 'Urgent Patient', 'URGENT');

    await request('/doctor/presence/online', {
      method: 'POST',
      cookies: doctor.cookies,
      payload: {},
    });
    await processWaitingQueue();

    const offer = await offerFor(doctor.cookies);
    expect(offer!.consultationPublicId).toBe(urgent.publicId);
    expect(offer!.chps!.priority).toBe('URGENT');

    // One offer at a time: the other patient is not sent to a doctor who cannot
    // see them, to lapse and be recorded as missed.
    expect(
      await getPrisma().consultationAssignment.count({
        where: { consultation: { publicId: routine.publicId } },
      }),
    ).toBe(0);

    const record = await request<PatientRecord>(`/facility/patients/${urgent.patientNumber}`, {
      cookies: cho.cookies,
    });
    expect(record.body.data!.visits[0]!.consultation!.priority).toBe('URGENT');
  });

  it('refuses a priority that does not exist', async () => {
    const cho = await facilityWithCho();
    await doctorOnDuty('Dr. Any');
    const registered = await request<{ visitPublicId: string }>('/facility/patients', {
      method: 'POST',
      cookies: cho.cookies,
      payload: {
        fullName: 'Efua Asante',
        sex: 'FEMALE',
        ageYears: 28,
        community: 'Avenorpeme',
        consentGivenBy: 'PATIENT',
        presentingComplaint: 'Fever',
      },
    });
    const visit = registered.body.data!.visitPublicId;
    await request(`/facility/visits/${visit}/triage`, {
      method: 'POST',
      cookies: cho.cookies,
      payload: { category: 'GREEN' },
    });
    const refused = await request(`/facility/visits/${visit}/consultation`, {
      method: 'POST',
      cookies: cho.cookies,
      payload: { languageCode: 'en', type: 'VIDEO', priority: 'EMERGENCY' },
    });
    expect(refused.status).toBe(400);
  });
});

describe('doctor history (D91)', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  const accept = async (cookies: Record<string, string>) => {
    const offer = await offerFor(cookies);
    await request(`/doctor/consultations/${offer!.consultationPublicId}/accept`, {
      method: 'POST',
      cookies,
    });
    return offer!.consultationPublicId;
  };
  const history = async (cookies: Record<string, string>, query = '') =>
    (await request<DoctorHistory>(`/doctor/consultations/history${query}`, { cookies })).body.data!;

  it("lists only this doctor's consultations, by patient, facility and date", async () => {
    const alpha = await facilityWithCho('Alpha');
    const beta = await facilityWithCho('Beta');
    const doctor = await doctorOnDuty('Dr. Mine');

    const first = await requested(alpha.cookies, 'Efua Asante');
    await accept(doctor.cookies);

    const everything = await history(doctor.cookies);
    expect(everything.rows).toHaveLength(1);
    expect(everything.rows[0]).toMatchObject({
      publicId: first.publicId,
      patientName: 'Efua Asante',
      patientNumber: first.patientNumber,
      origin: 'Alpha CHPS',
    });
    expect(everything.workload).toMatchObject({ pending: 0, active: 1, completedTotal: 0 });
    expect(everything.facilities).toEqual([
      { publicId: alpha.facility.publicId, name: 'Alpha CHPS' },
    ]);

    expect((await history(doctor.cookies, '?patient=Efua')).rows).toHaveLength(1);
    expect((await history(doctor.cookies, '?patient=Kofi')).rows).toHaveLength(0);
    expect((await history(doctor.cookies, `?patient=${first.patientNumber}`)).rows).toHaveLength(1);
    expect(
      (await history(doctor.cookies, `?facility=${alpha.facility.publicId}`)).rows,
    ).toHaveLength(1);
    expect(
      (await history(doctor.cookies, `?facility=${beta.facility.publicId}`)).rows,
    ).toHaveLength(0);
    expect((await history(doctor.cookies, '?to=2020-01-01')).rows).toHaveLength(0);
    expect((await history(doctor.cookies, '?from=2020-01-01')).rows).toHaveLength(1);

    // A colleague sees none of it, and neither does anyone who is not a doctor.
    const colleague = await doctorOnDuty('Dr. Other', false);
    expect((await history(colleague.cookies)).rows).toHaveLength(0);
    expect(
      (await request('/doctor/consultations/history', { cookies: alpha.cookies })).status,
    ).toBe(403);
  });

  it('does not count an offer as theirs until they accept it', async () => {
    const cho = await facilityWithCho();
    const doctor = await doctorOnDuty('Dr. Offered');
    await requested(cho.cookies, 'Efua Asante');

    const before = await history(doctor.cookies);
    expect(before.rows).toHaveLength(0);
    expect(before.workload.pending).toBe(1);
    expect(before.workload.active).toBe(0);
  });
});
