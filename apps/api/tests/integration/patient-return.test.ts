import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getPrisma, disconnectPrisma } from '../../src/db/prisma.ts';
import { closeTestApp, request, signIn } from '../helpers/app.ts';
import { createTestPharmacy, createTestUser, resetDatabase } from '../helpers/database.ts';
import {
  MockVideoProvider,
  MockVoiceProvider,
  setMediaProvidersForTesting,
} from '../../src/adapters/media/index.ts';
import {
  MockNotificationProvider,
  resetNotificationProviders,
  setNotificationProviderForTesting,
} from '../../src/adapters/notification/index.ts';
import { acceptOffer, offerNextDoctor } from '../../src/modules/queue/allocation.service.ts';
import { goOnline } from '../../src/modules/queue/presence.service.ts';
import { generatePublicId, encryptField } from '../../src/lib/crypto.ts';
import { interruptConsultation, joinMediaSession } from '../../src/modules/media/media.service.ts';
import { transition } from '../../src/modules/consultation/consultation.service.ts';
import { expireRecoveryWindows } from '../../src/modules/consultation/unserved.service.ts';
import { PRIVACY_NOTICE_VERSION } from '@neem/contracts';

/**
 * A patient who comes back before their professional does (D64).
 *
 * The fault these cover: a patient's return cannot move the consultation's
 * state — only a professional resumes it — and the patient's screen is chosen
 * by that state. So tapping Rejoin re-rendered the identical screen and read as
 * a dead button, while the only thing telling the doctor was a socket event
 * that nothing in the application listened for.
 *
 * What a return must now do: be recorded, be visible to the patient, reach the
 * professional durably, and change none of the things that protect the
 * consultation — its deadline, its clock, or the money.
 */

const DOCTOR_PASSWORD = 'DoctorPassword123!';
const PHARMACY_PASSWORD = 'PharmacyPassword123!';

const sms = new MockNotificationProvider('SMS');
const email = new MockNotificationProvider('EMAIL');

beforeEach(async () => {
  await resetDatabase();
  setMediaProvidersForTesting({ video: new MockVideoProvider(), voice: new MockVoiceProvider() });

  resetNotificationProviders();
  sms.clear();
  email.clear();
  setNotificationProviderForTesting('SMS', sms);
  setNotificationProviderForTesting('EMAIL', email);
});

afterAll(async () => {
  resetNotificationProviders();
  await closeTestApp();
  await disconnectPrisma();
});

interface Fixture {
  consultationId: string;
  consultationPublicId: string;
  doctorId: string;
  doctorEmail: string;
  patientCookies: Record<string, string>;
}

async function onlineDoctor(name = 'Dr. Return') {
  const prisma = getPrisma();
  const suffix = generatePublicId('x').slice(-8).toLowerCase();
  const email = `${suffix}@doctor.test`;

  const user = await createTestUser({ email, password: DOCTOR_PASSWORD, role: 'DOCTOR' });
  const languages = await prisma.language.findMany({ where: { code: { in: ['en'] } } });
  const expiry = new Date();
  expiry.setFullYear(expiry.getFullYear() + 1);

  const doctor = await prisma.doctor.create({
    data: {
      publicId: generatePublicId('doc'),
      userId: user.id,
      fullName: name,
      mdcNumber: `MDC-R-${suffix}`,
      qualification: 'MB ChB',
      practiceAddress: 'Ridge Clinic, Accra',
      mdcExpiresAt: expiry,
      status: 'ACTIVE',
      isDemo: true,
      phoneEnc: encryptField('+233240000111'),
      languages: {
        create: languages.map((language) => ({ languageId: language.id, isPrimary: true })),
      },
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
  return { doctorId: doctor.id, email };
}

/** A consultation under way, driven through the real routes. */
async function liveConsultation(doctor?: { doctorId: string; email: string }): Promise<Fixture> {
  const prisma = getPrisma();
  const professional = doctor ?? (await onlineDoctor());

  const pharmacy = await createTestPharmacy(
    `Pharmacy ${generatePublicId('x').slice(-6)}`,
    'ACTIVE',
  );
  const pharmacyUser = await createTestUser({
    email: `${generatePublicId('x').slice(-8)}@pharmacy.test`,
    password: PHARMACY_PASSWORD,
    role: 'PHARMACY',
  });
  await prisma.pharmacyUser.create({ data: { pharmacyId: pharmacy.id, userId: pharmacyUser.id } });

  const pharmacyCookies = await signIn(pharmacyUser.email, PHARMACY_PASSWORD);
  const created = await request<{ publicId: string }>('/pharmacy/consultations', {
    method: 'POST',
    cookies: pharmacyCookies,
    payload: {},
  });
  const publicId = created.body.data!.publicId;

  await request(`/pharmacy/consultations/${publicId}/payment`, {
    method: 'POST',
    cookies: pharmacyCookies,
    payload: {},
  });
  await request(`/pharmacy/consultations/${publicId}/payment/simulate`, {
    method: 'POST',
    cookies: pharmacyCookies,
    payload: { outcome: 'SUCCESS' },
  });

  const qr = await request<{ url: string }>(`/pharmacy/consultations/${publicId}/qr`, {
    method: 'POST',
    cookies: pharmacyCookies,
    payload: {},
  });
  const token = qr.body.data!.url.split('/s/')[1]!;
  const exchange = await request('/s/exchange', { method: 'POST', payload: { token } });

  await request('/patient/session/identity', {
    method: 'POST',
    cookies: exchange.cookies,
    payload: {
      fullName: 'Ama Mensah',
      age: 31,
      sex: 'FEMALE',
      phone: '0240000222',
      address: 'Dansoman, Accra',
      acceptsDataProcessing: true,
      privacyNoticeVersion: PRIVACY_NOTICE_VERSION,
    },
  });
  await request('/patient/session/language', {
    method: 'POST',
    cookies: exchange.cookies,
    payload: { languageCode: 'en' },
  });
  await request('/patient/session/mode', {
    method: 'POST',
    cookies: exchange.cookies,
    payload: { type: 'VIDEO' },
  });

  const consultation = await prisma.consultation.findUniqueOrThrow({ where: { publicId } });
  await offerNextDoctor(consultation.id);
  await acceptOffer(publicId, professional.doctorId);
  await joinMediaSession(consultation.id, 'DOCTOR');

  return {
    consultationId: consultation.id,
    consultationPublicId: publicId,
    doctorId: professional.doctorId,
    doctorEmail: professional.email,
    patientCookies: exchange.cookies,
  };
}

/** The consultation as the patient's own screen sees it. */
async function patientView(fixture: Fixture) {
  const response = await request<{
    step: string;
    state: string;
    awaitingProfessionalReturn: boolean;
    waitingForProfessionalSeconds: number | null;
    professionalPresent: boolean;
  }>('/patient/session', { cookies: fixture.patientCookies });

  return response.body.data!;
}

describe('a patient who comes back', () => {
  it('rejoins while the professional is still there, and the consultation runs', async () => {
    const fixture = await liveConsultation();

    // Never interrupted: the doctor is in the room throughout.
    await joinMediaSession(fixture.consultationId, 'PATIENT');

    const view = await patientView(fixture);
    expect(view.state).toBe('IN_PROGRESS');
    expect(view.step).toBe('IN_CONSULTATION');
    expect(view.awaitingProfessionalReturn).toBe(false);
  });

  it('rejoins before the professional, and is told they are waiting', async () => {
    const fixture = await liveConsultation();
    await interruptConsultation(fixture.consultationId, { type: 'DOCTOR', id: fixture.doctorId });

    await joinMediaSession(fixture.consultationId, 'PATIENT');

    const view = await patientView(fixture);
    /*
     * The bug: the state cannot move, so the screen could not change and the
     * button looked dead. It changes now because the return is recorded.
     */
    expect(view.state).toBe('INTERRUPTED');
    expect(view.awaitingProfessionalReturn).toBe(true);
    expect(view.waitingForProfessionalSeconds).not.toBeNull();
    expect(view.professionalPresent).toBe(false);

    const consultation = await getPrisma().consultation.findUniqueOrThrow({
      where: { id: fixture.consultationId },
    });
    expect(consultation.patientReturnedAt).not.toBeNull();
  });

  it('reaches the professional on a channel they will see, with nothing clinical in it', async () => {
    const fixture = await liveConsultation();
    await interruptConsultation(fixture.consultationId, { type: 'DOCTOR', id: fixture.doctorId });

    await joinMediaSession(fixture.consultationId, 'PATIENT');

    const sent = [...sms.sent(), ...email.sent()];
    expect(sent.length).toBeGreaterThan(0);

    const body = sent.map((message) => message.body).join(' ');
    expect(body).toContain(fixture.consultationPublicId);
    // The patient's name is not a professional's lock-screen material.
    expect(body).not.toContain('Ama Mensah');
  });

  it('shows the professional a pending item that survives a reload', async () => {
    const fixture = await liveConsultation();
    await interruptConsultation(fixture.consultationId, { type: 'DOCTOR', id: fixture.doctorId });
    await joinMediaSession(fixture.consultationId, 'PATIENT');

    const cookies = await signIn(fixture.doctorEmail, DOCTOR_PASSWORD);
    const waiting = await request<Array<{ consultationPublicId: string; waitingSeconds: number }>>(
      '/doctor/consultations/awaiting-return',
      { cookies },
    );

    expect(waiting.status).toBe(200);
    expect(waiting.body.data).toHaveLength(1);
    expect(waiting.body.data![0]!.consultationPublicId).toBe(fixture.consultationPublicId);
    // Read from the database, so it is there whether or not any socket event
    // was ever delivered.
    expect(waiting.body.data![0]!.waitingSeconds).toBeGreaterThanOrEqual(0);
  });

  it('is not shown to a different professional', async () => {
    const fixture = await liveConsultation();
    await interruptConsultation(fixture.consultationId, { type: 'DOCTOR', id: fixture.doctorId });
    await joinMediaSession(fixture.consultationId, 'PATIENT');

    // Somebody else's dashboard shows nothing: a return belongs to the
    // professional already treating that patient, not to whoever is free.
    const other = await onlineDoctor('Dr. Elsewhere');
    const cookies = await signIn(other.email, DOCTOR_PASSWORD);
    const waiting = await request<unknown[]>('/doctor/consultations/awaiting-return', { cookies });

    expect(waiting.body.data).toHaveLength(0);
  });

  it('connects both when the professional returns, and clears the pending item', async () => {
    const fixture = await liveConsultation();
    await interruptConsultation(fixture.consultationId, { type: 'DOCTOR', id: fixture.doctorId });
    await joinMediaSession(fixture.consultationId, 'PATIENT');

    await joinMediaSession(fixture.consultationId, 'DOCTOR');

    const view = await patientView(fixture);
    expect(view.state).toBe('IN_PROGRESS');
    expect(view.step).toBe('IN_CONSULTATION');
    expect(view.awaitingProfessionalReturn).toBe(false);

    const cookies = await signIn(fixture.doctorEmail, DOCTOR_PASSWORD);
    const waiting = await request<unknown[]>('/doctor/consultations/awaiting-return', { cookies });
    expect(waiting.body.data).toHaveLength(0);
  });

  it('does not interrupt the professional’s other consultation or free their slot', async () => {
    const doctor = await onlineDoctor();

    // The one that breaks, and the one they are in now.
    const broken = await liveConsultation(doctor);
    await interruptConsultation(broken.consultationId, { type: 'DOCTOR', id: doctor.doctorId });

    const current = await liveConsultation(doctor);
    const loadBefore = await currentLoad(doctor.doctorId);

    await joinMediaSession(broken.consultationId, 'PATIENT');

    // The live consultation is untouched, and the doctor is not suddenly free.
    const live = await getPrisma().consultation.findUniqueOrThrow({
      where: { id: current.consultationId },
    });
    expect(live.state).toBe('IN_PROGRESS');
    expect(await currentLoad(doctor.doctorId)).toBe(loadBefore);

    // And the waiting patient is visible without a second consultation being
    // started for them.
    const cookies = await signIn(doctor.email, DOCTOR_PASSWORD);
    const waiting = await request<unknown[]>('/doctor/consultations/awaiting-return', { cookies });
    expect(waiting.body.data).toHaveLength(1);
  });

  it('records one return however many times the patient taps rejoin', async () => {
    const fixture = await liveConsultation();
    await interruptConsultation(fixture.consultationId, { type: 'DOCTOR', id: fixture.doctorId });

    await joinMediaSession(fixture.consultationId, 'PATIENT');
    const first = await getPrisma().consultation.findUniqueOrThrow({
      where: { id: fixture.consultationId },
    });

    const notificationsAfterFirst = sms.sent().length + email.sent().length;

    await joinMediaSession(fixture.consultationId, 'PATIENT');
    await joinMediaSession(fixture.consultationId, 'PATIENT');

    const after = await getPrisma().consultation.findUniqueOrThrow({
      where: { id: fixture.consultationId },
    });

    /*
     * One return, one notification, one waiting time. Otherwise a patient
     * refreshing could spam their doctor and reset how long they appear to
     * have been waiting.
     */
    expect(after.patientReturnedAt!.getTime()).toBe(first.patientReturnedAt!.getTime());
    expect(sms.sent().length + email.sent().length).toBe(notificationsAfterFirst);

    const rooms = await getPrisma().mediaSession.count({
      where: { consultationId: fixture.consultationId, endedAt: null },
    });
    expect(rooms).toBe(1);
  });

  it('does not extend the recovery deadline or restart the clock', async () => {
    const fixture = await liveConsultation();
    await interruptConsultation(fixture.consultationId, { type: 'DOCTOR', id: fixture.doctorId });

    const before = await getPrisma().consultation.findUniqueOrThrow({
      where: { id: fixture.consultationId },
    });

    await joinMediaSession(fixture.consultationId, 'PATIENT');

    const after = await getPrisma().consultation.findUniqueOrThrow({
      where: { id: fixture.consultationId },
    });

    // Waiting alone is not consultation time, and coming back does not buy
    // more of it.
    expect(after.rejoinableUntil!.getTime()).toBe(before.rejoinableUntil!.getTime());
    expect(after.interruptedAt!.getTime()).toBe(before.interruptedAt!.getTime());
    expect(after.firstStartedAt!.getTime()).toBe(before.firstStartedAt!.getTime());
  });

  it('expires while the patient waits, and the pending item goes with it', async () => {
    const fixture = await liveConsultation();
    await interruptConsultation(fixture.consultationId, { type: 'DOCTOR', id: fixture.doctorId });
    await joinMediaSession(fixture.consultationId, 'PATIENT');

    // The professional never came back.
    await getPrisma().consultation.update({
      where: { id: fixture.consultationId },
      data: { rejoinableUntil: new Date(Date.now() - 60_000) },
    });

    expect(await expireRecoveryWindows()).toBe(1);

    const after = await getPrisma().consultation.findUniqueOrThrow({
      where: { id: fixture.consultationId },
    });
    expect(after.state).toBe('ABANDONED');
    // A pending item never outlives the thing it is about.
    expect(after.patientReturnedAt).toBeNull();

    const cookies = await signIn(fixture.doctorEmail, DOCTOR_PASSWORD);
    const waiting = await request<unknown[]>('/doctor/consultations/awaiting-return', { cookies });
    expect(waiting.body.data).toHaveLength(0);

    // And exactly one refund request, for a person to decide.
    expect(
      await getPrisma().refund.count({ where: { consultationId: fixture.consultationId } }),
    ).toBe(1);
  });

  it('loses the race to an expiry that lands first', async () => {
    const fixture = await liveConsultation();
    await interruptConsultation(fixture.consultationId, { type: 'DOCTOR', id: fixture.doctorId });

    await getPrisma().consultation.update({
      where: { id: fixture.consultationId },
      data: { rejoinableUntil: new Date(Date.now() - 60_000) },
    });
    await expireRecoveryWindows();

    /*
     * The patient taps rejoin at the moment it closes. The refusal is the
     * right outcome: the consultation is over, and letting them in would open
     * a room on a terminal record.
     */
    await expect(joinMediaSession(fixture.consultationId, 'PATIENT')).rejects.toThrow(
      /cannot be joined/i,
    );

    const after = await getPrisma().consultation.findUniqueOrThrow({
      where: { id: fixture.consultationId },
    });
    expect(after.patientReturnedAt).toBeNull();
  });

  it('refuses a consultation that has already finished', async () => {
    const fixture = await liveConsultation();
    await transition(fixture.consultationId, 'COMPLETING', {
      actorType: 'DOCTOR',
      reason: 'test',
    });
    await transition(fixture.consultationId, 'COMPLETED', {
      actorType: 'DOCTOR',
      reason: 'test',
    });

    await expect(joinMediaSession(fixture.consultationId, 'PATIENT')).rejects.toThrow(
      /cannot be joined/i,
    );

    const after = await getPrisma().consultation.findUniqueOrThrow({
      where: { id: fixture.consultationId },
    });
    expect(after.patientReturnedAt).toBeNull();
  });
});

/** The doctor's concurrent-consultation count. */
async function currentLoad(doctorId: string): Promise<number> {
  const presence = await getPrisma().doctorPresence.findUnique({ where: { doctorId } });
  return presence?.currentLoad ?? 0;
}
