import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  OfflineKey,
  OfflineWalkInInput,
  OfflineWalkInResult,
  PatientRecord,
} from '@neem/contracts';
import { disconnectPrisma, getPrisma } from '../../src/db/prisma.ts';
import { closeTestApp, request, signIn } from '../helpers/app.ts';
import { createTestUser, resetDatabase } from '../helpers/database.ts';
import { generatePublicId } from '../../src/lib/crypto.ts';

/** Walk-ins recorded offline (CHPS slice 4a, D88). */

afterAll(async () => {
  await closeTestApp();
  await disconnectPrisma();
});

async function facilityWithCho(email = 'cho@chps.test') {
  const prisma = getPrisma();
  const district = await prisma.district.findFirstOrThrow({ where: { region: { name: 'Volta' } } });
  const facility =
    (await prisma.facility.findUnique({ where: { code: 'CHPS-ALPHA' } })) ??
    (await prisma.facility.create({
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
    }));
  const user = await createTestUser({ email, password: 'ChoPassword123!', role: 'FACILITY' });
  await prisma.facilityUser.create({
    data: { facilityId: facility.id, userId: user.id, fullName: 'Alpha CHO' },
  });
  return signIn(email, 'ChoPassword123!');
}

const registration = (fullName: string, phone?: string) => ({
  fullName,
  sex: 'FEMALE' as const,
  ageYears: 34,
  community: 'Alpha',
  nhisStatus: 'UNKNOWN' as const,
  phone,
  presentingComplaint: 'Fever for two days',
  consentGivenBy: 'PATIENT' as const,
});

function walkIn(overrides: Partial<OfflineWalkInInput> = {}): OfflineWalkInInput {
  const now = Date.now();
  return {
    clientRequestId: randomUUID(),
    capturedAt: new Date(now - 2 * 3_600_000).toISOString(),
    sentAt: new Date(now).toISOString(),
    registration: registration('Akosua Offline'),
    triage: {
      category: 'YELLOW',
      vitals: { temperatureC: 38.4 },
      triagedAt: new Date(now - 2 * 3_600_000 + 10 * 60_000).toISOString(),
    },
    ...overrides,
  };
}

const send = (cookies: Record<string, string>, payload: OfflineWalkInInput) =>
  request<OfflineWalkInResult>('/facility/offline/walk-ins', { method: 'POST', cookies, payload });

describe('offline walk-ins (D88)', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('gives each CHO one key of their own, never cached', async () => {
    const cho = await facilityWithCho();
    const first = await request<OfflineKey>('/facility/offline-key', { cookies: cho });
    expect(first.status).toBe(200);
    expect(first.raw.headers['cache-control']).toBe('no-store');
    expect(Buffer.from(first.body.data!.key, 'base64')).toHaveLength(32);
    const again = await request<OfflineKey>('/facility/offline-key', { cookies: cho });
    expect(again.body.data!.key).toBe(first.body.data!.key);

    const other = await facilityWithCho('second@chps.test');
    const theirs = await request<OfflineKey>('/facility/offline-key', { cookies: other });
    expect(theirs.body.data!.key).not.toBe(first.body.data!.key);

    // Stored encrypted, not as the key itself.
    const stored = await getPrisma().facilityUser.findMany({ select: { offlineKeyEnc: true } });
    expect(stored.map((row) => row.offlineKeyEnc)).not.toContain(first.body.data!.key);
  });

  it('registers and triages at the time on the device, corrected for a wrong clock, once', async () => {
    const cho = await facilityWithCho();
    // The tablet's clock runs an hour fast: it captured "at 3 h ago" by its clock,
    // and sends when its clock says "1 h from now".
    const now = Date.now();
    const input = walkIn({
      capturedAt: new Date(now - 2 * 3_600_000).toISOString(),
      sentAt: new Date(now + 3_600_000).toISOString(),
      triage: {
        category: 'YELLOW',
        vitals: { temperatureC: 38.4 },
        triagedAt: new Date(now - 2 * 3_600_000 + 10 * 60_000).toISOString(),
      },
    });

    const saved = await send(cho, input);
    expect(saved.status).toBe(201);
    const result = saved.body.data!;
    expect(result).toMatchObject({ outcome: 'SAVED', matchedExisting: false });
    if (result.outcome !== 'SAVED') throw new Error('not saved');

    const visit = await getPrisma().patientVisit.findUniqueOrThrow({
      where: { publicId: result.visitPublicId },
      include: { triages: true },
    });
    const hoursAgo = (date: Date) => (now - date.getTime()) / 3_600_000;
    expect(hoursAgo(visit.arrivedAt)).toBeCloseTo(3, 1);
    expect(visit.syncedAt).not.toBeNull();
    expect(visit.status).toBe('TRIAGED');
    expect(visit.triages).toHaveLength(1);
    expect(hoursAgo(visit.triages[0]!.recordedAt)).toBeCloseTo(3 - 10 / 60, 1);

    // Sent again (the reply was lost): the same patient, no second triage.
    const resent = await send(cho, input);
    expect(resent.body.data).toEqual(result);
    expect(await getPrisma().patient.count()).toBe(1);
    expect(await getPrisma().triageRecord.count()).toBe(1);

    const audit = await getPrisma().auditLog.findFirst({
      where: { action: 'visit.offline-synced' },
    });
    expect(audit?.entityId).toBe(visit.id);
  });

  it('never dates a walk-in in the future', async () => {
    const cho = await facilityWithCho();
    const now = Date.now();
    const saved = await send(
      cho,
      walkIn({
        capturedAt: new Date(now + 3_600_000).toISOString(),
        sentAt: new Date(now).toISOString(),
        triage: null,
      }),
    );
    const result = saved.body.data!;
    if (result.outcome !== 'SAVED') throw new Error('not saved');
    const visit = await getPrisma().patientVisit.findUniqueOrThrow({
      where: { publicId: result.visitPublicId },
    });
    expect(visit.arrivedAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(visit.status).toBe('AWAITING_TRIAGE');
  });

  it('asks who a walk-in is when someone on file may be them, and follows the answer', async () => {
    const cho = await facilityWithCho();
    const existing = await request<{ patientNumber: string; visitPublicId: string }>(
      '/facility/patients',
      { method: 'POST', cookies: cho, payload: registration('Ama Serwaa Mensah', '0241234567') },
    );
    await request(`/facility/visits/${existing.body.data!.visitPublicId}/close`, {
      method: 'POST',
      cookies: cho,
      payload: { outcome: 'CLOSED', note: 'Seen and sent home' },
    });

    // Fewer words of the same name.
    const byName = walkIn({ registration: registration('Ama Serwaa') });
    const asked = await send(cho, byName);
    expect(asked.status).toBe(200);
    const question = asked.body.data!;
    expect(question.outcome).toBe('POSSIBLE_DUPLICATE');
    if (question.outcome !== 'POSSIBLE_DUPLICATE') throw new Error('no question');
    expect(question.candidates.map((c) => c.patientNumber)).toEqual([
      existing.body.data!.patientNumber,
    ]);
    expect(await getPrisma().patient.count()).toBe(1);

    // The same phone under another spelling also counts.
    const byPhone = await send(
      cho,
      walkIn({ registration: registration('Amma Sarwa', '0241234567') }),
    );
    expect(byPhone.body.data!.outcome).toBe('POSSIBLE_DUPLICATE');

    // "It is them": a new visit on their record, nothing new registered.
    const same = await send(cho, {
      ...byName,
      decision: { kind: 'EXISTING', patientNumber: existing.body.data!.patientNumber },
    });
    expect(same.body.data).toMatchObject({
      outcome: 'SAVED',
      matchedExisting: true,
      patientNumber: existing.body.data!.patientNumber,
    });
    expect(await getPrisma().patient.count()).toBe(1);
    const record = await request<PatientRecord>(
      `/facility/patients/${existing.body.data!.patientNumber}`,
      { cookies: cho },
    );
    const visits = record.body.data!.visits;
    expect(visits).toHaveLength(2);
    // The offline visit keeps its earlier arrival time, so it sorts below today's closed one.
    expect(
      visits.find(
        (visit) => visit.publicId === (same.body.data as { visitPublicId: string }).visitPublicId,
      )?.triage?.category,
    ).toBe('YELLOW');

    // Resending the answered one is still the same visit.
    const resent = await send(cho, {
      ...byName,
      decision: { kind: 'EXISTING', patientNumber: existing.body.data!.patientNumber },
    });
    expect(resent.body.data).toEqual(same.body.data);

    // "Somebody else": registered as new.
    const other = await send(cho, {
      ...walkIn({ registration: registration('Amma Sarwa', '0241234567') }),
      decision: { kind: 'NEW' },
    });
    expect(other.body.data).toMatchObject({ outcome: 'SAVED', matchedExisting: false });
    expect(await getPrisma().patient.count()).toBe(2);
  });

  it('refuses a match whose patient already has a visit in progress, and stays within the facility', async () => {
    const cho = await facilityWithCho();
    const existing = await request<{ patientNumber: string }>('/facility/patients', {
      method: 'POST',
      cookies: cho,
      payload: registration('Ama Serwaa'),
    });
    const busy = await send(cho, {
      ...walkIn({ registration: registration('Ama Serwaa') }),
      decision: { kind: 'EXISTING', patientNumber: existing.body.data!.patientNumber },
    });
    expect(busy.status).toBe(409);

    // Another facility's CHO is never shown this patient as a possible match.
    const prisma = getPrisma();
    const district = await prisma.district.findFirstOrThrow({
      where: { region: { name: 'Volta' } },
    });
    const beta = await prisma.facility.create({
      data: {
        publicId: generatePublicId('fac'),
        code: 'CHPS-BETA',
        name: 'Beta CHPS',
        type: 'CHPS',
        districtId: district.id,
        community: 'Beta',
        status: 'ACTIVE',
        createdByUserId: 'test',
        isDemo: true,
      },
    });
    const user = await createTestUser({
      email: 'beta@chps.test',
      password: 'ChoPassword123!',
      role: 'FACILITY',
    });
    await prisma.facilityUser.create({
      data: { facilityId: beta.id, userId: user.id, fullName: 'Beta CHO' },
    });
    const betaCho = await signIn('beta@chps.test', 'ChoPassword123!');
    const elsewhere = await send(betaCho, walkIn({ registration: registration('Ama Serwaa') }));
    expect(elsewhere.body.data!.outcome).toBe('SAVED');
    const notTheirs = await send(betaCho, {
      ...walkIn({ registration: registration('Kofi Other') }),
      decision: { kind: 'EXISTING', patientNumber: existing.body.data!.patientNumber },
    });
    expect(notTheirs.status).toBe(404);
  });

  it('recognises a registration that reached Neem online but whose reply was lost', async () => {
    const cho = await facilityWithCho();
    const id = randomUUID();
    const online = await request<{ patientNumber: string; visitPublicId: string }>(
      '/facility/patients',
      {
        method: 'POST',
        cookies: cho,
        payload: { ...registration('Akosua Offline'), clientRequestId: id },
      },
    );
    expect(online.status).toBe(201);

    // The form never heard back, so the CHO saved the same walk-in offline.
    const queued = await send(cho, {
      ...walkIn({ clientRequestId: id }),
      registration: { ...registration('Akosua Offline'), clientRequestId: id },
    });
    expect(queued.body.data).toEqual({
      outcome: 'SAVED',
      patientNumber: online.body.data!.patientNumber,
      visitPublicId: online.body.data!.visitPublicId,
      matchedExisting: false,
    });
    expect(await getPrisma().patient.count()).toBe(1);
    // Its triage, typed offline, is kept.
    expect(await getPrisma().triageRecord.count()).toBe(1);
  });

  it('is for facility staff only', async () => {
    await facilityWithCho();
    const doctor = await createTestUser({
      email: 'doc@neem.test',
      password: 'DoctorPassword123!',
      role: 'DOCTOR',
    });
    expect(doctor).toBeTruthy();
    expect((await request('/facility/offline-key')).status).toBe(401);
  });
});
