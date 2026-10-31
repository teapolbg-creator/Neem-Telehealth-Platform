import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FacilityDaySummary, PatientRecord, PatientSummary } from '@neem/contracts';
import { disconnectPrisma, getPrisma } from '../../src/db/prisma.ts';
import { closeTestApp, request, signIn } from '../helpers/app.ts';
import { createTestUser, resetDatabase } from '../helpers/database.ts';
import { generatePublicId } from '../../src/lib/crypto.ts';

/**
 * Walk-in registration, the patient record and triage (CHPS slice 1b, D75).
 */

afterAll(async () => {
  await closeTestApp();
  await disconnectPrisma();
});

const PASSWORD = 'ChoPassword123!';

/** A facility with one CHO, made directly: slice 1a's routes are tested elsewhere. */
async function facilityWithCho(label: string, status: 'ACTIVE' | 'INACTIVE' = 'ACTIVE') {
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
      status,
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

function walkIn(overrides: Record<string, unknown> = {}) {
  return {
    fullName: 'Ama Serwaa Boateng',
    sex: 'FEMALE',
    ageYears: 34,
    community: 'Avenorpeme',
    phone: '024 123 4567',
    nhisStatus: 'ACTIVE',
    nhisNumber: '1234 5678',
    allergies: 'Penicillin',
    consentGivenBy: 'PATIENT',
    presentingComplaint: 'Fever and headache for three days',
    ...overrides,
  };
}

async function register(cookies: Record<string, string>, overrides: Record<string, unknown> = {}) {
  return request<{ patientNumber: string; visitPublicId: string }>('/facility/patients', {
    method: 'POST',
    cookies,
    payload: walkIn(overrides),
  });
}

describe('CHPS patients', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('registers a walk-in with an estimated age and opens their visit', async () => {
    const { cookies } = await facilityWithCho('Alpha');
    const created = await register(cookies);

    expect(created.status).toBe(201);
    expect(created.body.data!.patientNumber).toMatch(/^NM-[0-9A-Z]{4}-[0-9A-Z]{4}$/);

    const record = await request<PatientRecord>(
      `/facility/patients/${created.body.data!.patientNumber}`,
      { cookies },
    );
    expect(record.status).toBe(200);
    expect(record.body.data).toMatchObject({
      fullName: 'Ama Serwaa Boateng',
      dobIsEstimated: true,
      phone: '+233241234567',
      nhisNumber: '12345678',
      allergies: 'Penicillin',
      consent: { givenBy: 'PATIENT', version: 'chps-2026-10' },
      hasOpenVisit: true,
    });
    expect(record.body.data!.visits[0]).toMatchObject({
      status: 'AWAITING_TRIAGE',
      presentingComplaint: 'Fever and headache for three days',
    });
  });

  it('stores the name and clinical text encrypted, and logs every record opened', async () => {
    const { cookies } = await facilityWithCho('Alpha');
    const created = await register(cookies);
    await request(`/facility/patients/${created.body.data!.patientNumber}`, { cookies });

    const prisma = getPrisma();
    const row = await prisma.patient.findFirstOrThrow();
    expect(row.fullNameEnc).not.toContain('Ama');
    expect(row.allergiesEnc).not.toContain('Penicillin');
    expect(row.nameTokens.join()).not.toContain('ama');

    expect(await prisma.patientRecordAccess.count({ where: { patientId: row.id } })).toBe(1);
  });

  it('finds a patient by any word of their name, phone, NHIS or card number', async () => {
    const { cookies } = await facilityWithCho('Alpha');
    const created = await register(cookies);
    const number = created.body.data!.patientNumber;

    const searches = [
      'name=serwaa',
      'name=Boateng%20ama',
      'phone=%2B233241234567',
      'nhisNumber=1234-5678',
      `patientNumber=${number.replace(/-/g, '').toLowerCase()}`,
    ];
    for (const query of searches) {
      const found = await request<PatientSummary[]>(`/facility/patients?${query}`, { cookies });
      expect(
        found.body.data!.map((patient) => patient.patientNumber),
        query,
      ).toEqual([number]);
    }

    const none = await request<PatientSummary[]>('/facility/patients?name=kwame', { cookies });
    expect(none.body.data).toEqual([]);
  });

  it('does not create a second patient when a registration is resubmitted', async () => {
    const { cookies } = await facilityWithCho('Alpha');
    const clientRequestId = randomUUID();

    const first = await register(cookies, { clientRequestId });
    const again = await register(cookies, { clientRequestId });

    expect(again.body.data).toEqual(first.body.data);
    expect(await getPrisma().patient.count()).toBe(1);
  });

  it('requires consent, a guardian when the guardian consents, and an age', async () => {
    const { cookies } = await facilityWithCho('Alpha');

    expect((await register(cookies, { consentGivenBy: undefined })).status).toBe(400);
    expect((await register(cookies, { consentGivenBy: 'GUARDIAN' })).status).toBe(400);
    expect((await register(cookies, { ageYears: undefined })).status).toBe(400);

    const child = await register(cookies, {
      fullName: 'Kofi Mensah',
      ageYears: 4,
      consentGivenBy: 'GUARDIAN',
      representative: { name: 'Efua Mensah', relationship: 'Mother' },
    });
    expect(child.status).toBe(201);
  });

  it('keeps one facility’s patients from another facility’s staff', async () => {
    const alpha = await facilityWithCho('Alpha');
    const beta = await facilityWithCho('Beta');
    const created = await register(alpha.cookies);
    const number = created.body.data!.patientNumber;

    expect((await request(`/facility/patients/${number}`, { cookies: beta.cookies })).status).toBe(
      404,
    );
    const search = await request<PatientSummary[]>('/facility/patients?name=serwaa', {
      cookies: beta.cookies,
    });
    expect(search.body.data).toEqual([]);
    expect(
      (
        await request(`/facility/visits/${created.body.data!.visitPublicId}/triage`, {
          method: 'POST',
          cookies: beta.cookies,
          payload: { category: 'GREEN' },
        })
      ).status,
    ).toBe(404);
  });

  it('records triage and vital signs, and keeps every assessment', async () => {
    const { cookies } = await facilityWithCho('Alpha');
    const created = await register(cookies);
    const visit = created.body.data!.visitPublicId;

    const first = await request(`/facility/visits/${visit}/triage`, {
      method: 'POST',
      cookies,
      payload: {
        category: 'YELLOW',
        vitals: { bpSystolic: 128, bpDiastolic: 84, temperatureC: 38.4, pulseBpm: 96 },
        symptoms: 'Headache, chills',
      },
    });
    expect(first.status).toBe(201);
    expect(first.body.data).toEqual({ status: 'TRIAGED', category: 'YELLOW' });

    await request(`/facility/visits/${visit}/triage`, {
      method: 'POST',
      cookies,
      payload: { category: 'ORANGE', vitals: { temperatureC: 39.2 } },
    });

    const record = await request<PatientRecord>(
      `/facility/patients/${created.body.data!.patientNumber}`,
      { cookies },
    );
    const current = record.body.data!.visits[0]!;
    expect(current.triage).toMatchObject({ category: 'ORANGE', recordedBy: 'Alpha CHO' });
    expect(current.triageHistory.map((triage) => triage.category)).toEqual(['ORANGE', 'YELLOW']);
    expect(current.triageHistory[1]!.vitals).toMatchObject({ bpSystolic: 128, temperatureC: 38.4 });
  });

  it('refuses implausible readings and half a blood pressure', async () => {
    const { cookies } = await facilityWithCho('Alpha');
    const visit = (await register(cookies)).body.data!.visitPublicId;
    const triage = (vitals: Record<string, number>) =>
      request(`/facility/visits/${visit}/triage`, {
        method: 'POST',
        cookies,
        payload: { category: 'GREEN', vitals },
      });

    expect((await triage({ temperatureC: 370 })).status).toBe(400);
    expect((await triage({ bpSystolic: 120 })).status).toBe(400);
    expect((await triage({ temperatureC: 37 })).status).toBe(201);
  });

  it('sends a red patient straight to the emergency path', async () => {
    const { cookies } = await facilityWithCho('Alpha');
    const visit = (await register(cookies)).body.data!.visitPublicId;

    const red = await request(`/facility/visits/${visit}/triage`, {
      method: 'POST',
      cookies,
      payload: { category: 'RED', vitals: { spo2Percent: 82 } },
    });
    expect(red.body.data).toEqual({ status: 'ESCALATED', category: 'RED' });

    // A later, milder assessment does not quietly take them off it.
    const after = await request(`/facility/visits/${visit}/triage`, {
      method: 'POST',
      cookies,
      payload: { category: 'YELLOW' },
    });
    expect(after.body.data).toEqual({ status: 'ESCALATED', category: 'YELLOW' });

    const day = await request<FacilityDaySummary>('/facility/today', { cookies });
    expect(day.body.data).toMatchObject({ seenToday: 1, waiting: 0, escalatedToday: 1 });
  });

  it('escalates without triage, closes visits, and allows one open visit per patient', async () => {
    const { cookies } = await facilityWithCho('Alpha');
    const created = await register(cookies);
    const { patientNumber, visitPublicId } = created.body.data!;

    const escalated = await request(`/facility/visits/${visitPublicId}/escalate`, {
      method: 'POST',
      cookies,
      payload: { note: 'Ambulance called; referred to district hospital' },
    });
    expect(escalated.body.data).toEqual({ status: 'ESCALATED' });

    const second = await request(`/facility/patients/${patientNumber}/visits`, {
      method: 'POST',
      cookies,
      payload: { presentingComplaint: 'Follow-up' },
    });
    expect(second.status).toBe(409);

    const closed = await request(`/facility/visits/${visitPublicId}/close`, {
      method: 'POST',
      cookies,
      payload: { outcome: 'CLOSED', note: 'Transferred by ambulance' },
    });
    expect(closed.body.data).toEqual({ status: 'CLOSED' });

    const reopened = await request(`/facility/visits/${visitPublicId}/triage`, {
      method: 'POST',
      cookies,
      payload: { category: 'GREEN' },
    });
    expect(reopened.status).toBe(422);

    const next = await request(`/facility/patients/${patientNumber}/visits`, {
      method: 'POST',
      cookies,
      payload: { presentingComplaint: 'Follow-up' },
    });
    expect(next.status).toBe(201);
  });

  it('lets an inactive facility read but not register', async () => {
    const { cookies } = await facilityWithCho('Gamma', 'INACTIVE');

    expect((await register(cookies)).status).toBe(422);
    expect((await request('/facility/today', { cookies })).status).toBe(200);
  });

  it('keeps patient routes from anybody who is not facility staff', async () => {
    await facilityWithCho('Alpha');
    const email = 'counter@pharmacy.test';
    await createTestUser({ email, password: PASSWORD, role: 'PHARMACY' });
    const pharmacy = await signIn(email, PASSWORD);

    expect((await request('/facility/today', { cookies: pharmacy })).status).toBe(403);
    expect((await register(pharmacy)).status).toBe(403);
  });
});
