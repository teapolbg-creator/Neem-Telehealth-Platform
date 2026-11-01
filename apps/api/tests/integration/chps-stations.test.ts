import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StationPairing, StationState, StationSummary } from '@neem/contracts';
import { disconnectPrisma, getPrisma } from '../../src/db/prisma.ts';
import { closeTestApp, request, signIn } from '../helpers/app.ts';
import { createTestUser, resetDatabase } from '../helpers/database.ts';
import { generatePublicId } from '../../src/lib/crypto.ts';
import { goOnline } from '../../src/modules/queue/presence.service.ts';
import { getVideoProvider } from '../../src/adapters/media/index.ts';

/**
 * Consultation stations (CHPS slice 1d, D77).
 */

afterAll(async () => {
  await closeTestApp();
  await disconnectPrisma();
});

const PASSWORD = 'ChoPassword123!';
const STATION = { 'x-neem-station': '1' };

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
      fullName: 'Dr. Yaa Asantewaa',
      mdcNumber: `MDC-S-${suffix}`,
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

/** Registered, triaged and with a doctor requested. */
async function requestedVisit(cookies: Record<string, string>) {
  const created = await request<{ visitPublicId: string }>('/facility/patients', {
    method: 'POST',
    cookies,
    payload: {
      fullName: 'Abena Konadu Mensah',
      sex: 'FEMALE',
      ageYears: 41,
      community: 'Avenorpeme',
      consentGivenBy: 'PATIENT',
      presentingComplaint: 'Headache',
    },
  });
  const visit = created.body.data!.visitPublicId;
  await request(`/facility/visits/${visit}/triage`, {
    method: 'POST',
    cookies,
    payload: { category: 'GREEN' },
  });
  await request(`/facility/visits/${visit}/consultation`, {
    method: 'POST',
    cookies,
    payload: { languageCode: 'en', type: 'VIDEO' },
  });
  return visit;
}

/** Adds a station and pairs it, returning the station's own cookies. */
async function pairedStation(cookies: Record<string, string>, label = 'Consulting room tablet') {
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
  return {
    publicId: created.body.data!.station.publicId,
    code: created.body.data!.pairingCode,
    station: { neem_station: paired.cookies.neem_station! },
  };
}

const stateOf = (station: Record<string, string>) =>
  request<StationState>('/station/state', { cookies: station });

describe('consultation stations', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('pairs once with a code, and then shows only a welcome', async () => {
    const { cookies } = await facilityWithCho('Alpha');
    const { code, station } = await pairedStation(cookies);

    // The code is spent.
    expect((await request('/station/pair', { method: 'POST', payload: { code } })).status).toBe(
      401,
    );

    const state = await stateOf(station);
    expect(state.body.data).toEqual({
      station: { label: 'Consulting room tablet' },
      facility: { name: 'Alpha CHPS' },
      mode: 'IDLE',
      sessionKey: null,
      patientFirstName: null,
      doctorName: null,
      kind: null,
    });

    const list = await request<StationSummary[]>('/facility/stations', { cookies });
    expect(list.body.data![0]).toMatchObject({ status: 'PAIRED', online: true, current: null });
  });

  it('refuses an expired pairing code', async () => {
    const { cookies } = await facilityWithCho('Alpha');
    const created = await request<StationPairing>('/facility/stations', {
      method: 'POST',
      cookies,
      payload: { label: 'Tablet' },
    });
    await getPrisma().facilityStation.updateMany({
      data: { pairingExpiresAt: new Date(Date.now() - 1000) },
    });

    const paired = await request('/station/pair', {
      method: 'POST',
      payload: { code: created.body.data!.pairingCode },
    });
    expect(paired.status).toBe(401);
  });

  it('greets the patient by first name only, then joins the call once a doctor accepts', async () => {
    const { cookies } = await facilityWithCho('Alpha');
    const { cookies: doctorCookies } = await onlineDoctor();
    const visit = await requestedVisit(cookies);
    const { publicId, station } = await pairedStation(cookies);

    const sent = await request<StationSummary>(`/facility/visits/${visit}/station`, {
      method: 'POST',
      cookies,
      payload: { stationPublicId: publicId },
    });
    expect(sent.body.data!.current).toMatchObject({ patientName: 'Abena Konadu Mensah' });

    const waiting = await stateOf(station);
    expect(waiting.body.data).toMatchObject({
      mode: 'WAITING_FOR_DOCTOR',
      patientFirstName: 'Abena',
      doctorName: null,
    });
    // Nothing more of the patient reaches the shared screen.
    expect(JSON.stringify(waiting.body.data)).not.toMatch(/Konadu|Mensah|Headache/);

    // Not yet joinable: no doctor has accepted.
    expect(
      (await request('/station/join', { method: 'POST', cookies: station, headers: STATION }))
        .status,
    ).toBe(422);

    const consultation = await getPrisma().consultation.findFirstOrThrow();
    await request(`/doctor/consultations/${consultation.publicId}/accept`, {
      method: 'POST',
      cookies: doctorCookies,
    });

    const ready = await stateOf(station);
    expect(ready.body.data).toMatchObject({ mode: 'READY', doctorName: 'Dr. Yaa Asantewaa' });

    // The facility chose lower video quality: the join asks the provider for it (D89).
    await getPrisma().facility.updateMany({ data: { lowDataVideo: true } });
    const issue = vi.spyOn(getVideoProvider(), 'issueJoinToken');

    const joined = await request<{ kind: string }>('/station/join', {
      method: 'POST',
      cookies: station,
      headers: STATION,
    });
    expect(joined.status).toBe(200);
    expect(joined.body.data!.kind).toBe('VIDEO');
    expect(issue).toHaveBeenCalledWith(expect.objectContaining({ lowData: true }));
    issue.mockRestore();

    const attendance = await getPrisma().callAttendanceEvent.findFirst({
      where: { consultationId: consultation.id, participant: 'PATIENT', event: 'JOINED' },
    });
    expect(attendance).not.toBeNull();
  });

  it('forgets a consultation once it ends, so the next patient sees a welcome', async () => {
    const { cookies } = await facilityWithCho('Alpha');
    await onlineDoctor(false);
    const visit = await requestedVisit(cookies);
    const { publicId, station } = await pairedStation(cookies);
    await request(`/facility/visits/${visit}/station`, {
      method: 'POST',
      cookies,
      payload: { stationPublicId: publicId },
    });

    await request(`/facility/visits/${visit}/consultation/cancel`, {
      method: 'POST',
      cookies,
      payload: { reason: 'Patient went home' },
    });

    const state = await stateOf(station);
    expect(state.body.data).toMatchObject({ mode: 'IDLE', patientFirstName: null });
    const row = await getPrisma().facilityStation.findFirstOrThrow();
    expect(row.consultationId).toBeNull();
  });

  it('needs the station header to change anything, and a credential to read anything', async () => {
    const { cookies } = await facilityWithCho('Alpha');
    const { station } = await pairedStation(cookies);

    expect((await request('/station/state')).status).toBe(401);
    expect((await request('/station/join', { method: 'POST', cookies: station })).status).toBe(403);
  });

  it('cannot reach patient records or facility routes with a station credential', async () => {
    const { cookies } = await facilityWithCho('Alpha');
    const { station } = await pairedStation(cookies);

    for (const path of ['/facility/today', '/facility/patients?name=abena', '/facility/stations']) {
      const response = await request(path, { cookies: station });
      expect([401, 403], path).toContain(response.status);
    }
  });

  it('stops a revoked or re-paired station at once', async () => {
    const { cookies } = await facilityWithCho('Alpha');
    const first = await pairedStation(cookies);

    await request(`/facility/stations/${first.publicId}/pairing-code`, {
      method: 'POST',
      cookies,
      payload: {},
    });
    expect((await stateOf(first.station)).status).toBe(401);

    const second = await pairedStation(cookies, 'Second tablet');
    await request(`/facility/stations/${second.publicId}/revoke`, {
      method: 'POST',
      cookies,
      payload: {},
    });
    expect((await stateOf(second.station)).status).toBe(401);
  });

  it('will not swap out a patient mid-consultation, nor take another facility’s', async () => {
    const alpha = await facilityWithCho('Alpha');
    const beta = await facilityWithCho('Beta');
    await onlineDoctor(false);
    const first = await requestedVisit(alpha.cookies);
    const { publicId } = await pairedStation(alpha.cookies);
    await request(`/facility/visits/${first}/station`, {
      method: 'POST',
      cookies: alpha.cookies,
      payload: { stationPublicId: publicId },
    });

    const second = await requestedVisit(alpha.cookies);
    const busy = await request(`/facility/visits/${second}/station`, {
      method: 'POST',
      cookies: alpha.cookies,
      payload: { stationPublicId: publicId },
    });
    expect(busy.status).toBe(409);

    // Cleared, it can take the next one.
    await request(`/facility/stations/${publicId}/clear`, {
      method: 'POST',
      cookies: alpha.cookies,
      payload: {},
    });
    const next = await request(`/facility/visits/${second}/station`, {
      method: 'POST',
      cookies: alpha.cookies,
      payload: { stationPublicId: publicId },
    });
    expect(next.status).toBe(200);

    const foreign = await request(`/facility/visits/${second}/station`, {
      method: 'POST',
      cookies: beta.cookies,
      payload: { stationPublicId: publicId },
    });
    expect(foreign.status).toBe(404);
  });
});
