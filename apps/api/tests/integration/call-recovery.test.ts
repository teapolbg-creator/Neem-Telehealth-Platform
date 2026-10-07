import { PRIVACY_NOTICE_VERSION } from '@neem/contracts';
import { createHmac } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getPrisma, disconnectPrisma } from '../../src/db/prisma.ts';
import { closeTestApp, getTestApp, request, signIn } from '../helpers/app.ts';
import { createTestPharmacy, createTestUser, resetDatabase } from '../helpers/database.ts';
import {
  MediaProviderError,
  MockVideoProvider,
  MockVoiceProvider,
  setMediaProvidersForTesting,
} from '../../src/adapters/media/index.ts';
import { acceptOffer, offerNextDoctor } from '../../src/modules/queue/allocation.service.ts';
import {
  goOnline,
  reconcileDoctorLoad,
  reconcileOnlineDoctorLoads,
} from '../../src/modules/queue/presence.service.ts';
import { generatePublicId, hashPassword, encryptField } from '../../src/lib/crypto.ts';
import {
  interruptConsultation,
  joinMediaSession,
  leaveMediaSession,
} from '../../src/modules/media/media.service.ts';
import { completeConsultation } from '../../src/modules/clinical/clinical.service.ts';
import { issueSummary } from '../../src/modules/documents/document.service.ts';
import { transition } from '../../src/modules/consultation/consultation.service.ts';

/**
 * A consultation survives its call (D57).
 *
 * Every test here is a way a call can break — a hang-up, a dead phone, a
 * closed browser, a restarted server, two tabs at once — and the thing being
 * asserted is always the same: the patient keeps what they paid for, nobody is
 * charged twice, and nothing completes a consultation except a doctor.
 */

const DOCTOR_PASSWORD = 'DoctorPassword123!';
const PHARMACY_PASSWORD = 'PharmacyPassword123!';

interface Fixture {
  consultationId: string;
  consultationPublicId: string;
  doctorId: string;
  doctorCookies: Record<string, string>;
  patientCookies: Record<string, string>;
}

/** An active doctor, on shift and online, so the queue may reach them. */
async function onlineDoctor(): Promise<{ doctorId: string; email: string }> {
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
      fullName: 'Dr. Recovery',
      mdcNumber: `MDC-R-${suffix}`,
      // What s.103 of Act 857 requires on a prescription (D60).
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

/**
 * A consultation that is actually under way: paid at the counter, scanned by
 * the patient, accepted by the doctor, with the doctor in the room.
 *
 * Driven through the real routes rather than written into the database, so
 * these tests break if the journey they describe stops working.
 */
async function liveConsultation(options: { doctorJoins?: boolean } = {}): Promise<Fixture> {
  const prisma = getPrisma();
  const doctor = await onlineDoctor();

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
  await acceptOffer(publicId, doctor.doctorId);

  /*
   * The doctor joining is what starts it — and `doctorJoins: false` is the
   * state a consultation sits in before that: accepted, with no room open yet.
   * That is where the patient arrives first, and where a provider refusing to
   * create a room is actually felt.
   */
  if (options.doctorJoins !== false) {
    await joinMediaSession(consultation.id, 'DOCTOR');
  }

  return {
    consultationId: consultation.id,
    consultationPublicId: publicId,
    doctorId: doctor.doctorId,
    doctorCookies: await signIn(doctor.email, DOCTOR_PASSWORD),
    patientCookies: exchange.cookies,
  };
}

function currentLoad(doctorId: string) {
  return getPrisma()
    .doctorPresence.findUniqueOrThrow({ where: { doctorId } })
    .then((presence) => presence.currentLoad);
}

beforeEach(async () => {
  await resetDatabase();
  setMediaProvidersForTesting({ video: new MockVideoProvider(), voice: new MockVoiceProvider() });
});

afterAll(async () => {
  setMediaProvidersForTesting(undefined);
  await closeTestApp();
  await disconnectPrisma();
});

describe('a call that breaks', () => {
  it('leaves the consultation in progress when the patient hangs up', async () => {
    const fixture = await liveConsultation();

    await leaveMediaSession(fixture.consultationId, 'PATIENT');

    const consultation = await getPrisma().consultation.findUniqueOrThrow({
      where: { id: fixture.consultationId },
    });
    // Leaving a call is attendance, not an outcome.
    expect(consultation.state).toBe('IN_PROGRESS');
    expect(consultation.completedAt).toBeNull();

    const attendance = await getPrisma().callAttendanceEvent.findMany({
      where: { consultationId: fixture.consultationId },
    });
    expect(attendance.map((row) => row.event)).toContain('LEFT');
  });

  it('lets the patient rejoin the same room, and charges nothing', async () => {
    const fixture = await liveConsultation();

    const first = await joinMediaSession(fixture.consultationId, 'PATIENT');
    await leaveMediaSession(fixture.consultationId, 'PATIENT');
    const second = await joinMediaSession(fixture.consultationId, 'PATIENT');

    expect(second.providerRoomRef).toBe(first.providerRoomRef);

    const payments = await getPrisma().payment.count({
      where: { consultationId: fixture.consultationId },
    });
    expect(payments).toBe(1);
  });

  it('gives the doctor their slot back when they say the call broke', async () => {
    const fixture = await liveConsultation();
    expect(await currentLoad(fixture.doctorId)).toBe(1);

    const result = await interruptConsultation(fixture.consultationId, {
      type: 'DOCTOR',
      id: fixture.doctorId,
    });

    expect(result.state).toBe('INTERRUPTED');
    // Free to see other patients, while this one stays unfinished.
    expect(await currentLoad(fixture.doctorId)).toBe(0);

    const consultation = await getPrisma().consultation.findUniqueOrThrow({
      where: { id: fixture.consultationId },
    });
    expect(consultation.state).toBe('INTERRUPTED');
    expect(consultation.rejoinableUntil).not.toBeNull();
    expect(consultation.completedAt).toBeNull();
  });

  /*
   * This asserted the opposite until D61, and the opposite was the bug.
   *
   * A patient tapping "rejoin" moved the consultation back to IN_PROGRESS and
   * cleared its deadline: the clock restarted, the doctor was neither present
   * nor told, no sweep could see the consultation again, and the patient sat
   * alone in a video room watching a timer run. That is the state the reported
   * incident was found in, a week after the call had stopped.
   */
  it('does not resume when only the patient comes back', async () => {
    const fixture = await liveConsultation();
    await interruptConsultation(fixture.consultationId, { type: 'DOCTOR', id: fixture.doctorId });

    const before = await getPrisma().consultation.findUniqueOrThrow({
      where: { id: fixture.consultationId },
    });

    await joinMediaSession(fixture.consultationId, 'PATIENT');

    const consultation = await getPrisma().consultation.findUniqueOrThrow({
      where: { id: fixture.consultationId },
    });

    // They are in the room, which is all they can be. Being in a room is not
    // being seen.
    expect(consultation.state).toBe('INTERRUPTED');
    // And the deadline keeps running, so an unanswered return still ends.
    expect(consultation.rejoinableUntil?.getTime()).toBe(before.rejoinableUntil?.getTime());
    // The doctor is free for other patients until they actually return.
    expect(await currentLoad(fixture.doctorId)).toBe(0);
  });

  it('resumes, and takes the slot back, when the professional comes back', async () => {
    const fixture = await liveConsultation();
    await interruptConsultation(fixture.consultationId, { type: 'DOCTOR', id: fixture.doctorId });

    await joinMediaSession(fixture.consultationId, 'DOCTOR');

    const consultation = await getPrisma().consultation.findUniqueOrThrow({
      where: { id: fixture.consultationId },
    });
    expect(consultation.state).toBe('IN_PROGRESS');
    expect(await currentLoad(fixture.doctorId)).toBe(1);
    /*
     * The break is over, so its deadline goes with it (D67).
     *
     * This asserted the opposite until then, because clearing the deadline was
     * once how a rejoin removed the only bound on the consultation's life.
     * That is no longer the only bound: `firstInterruptedAt` carries the
     * recovery budget across every break, and the inactivity thresholds and
     * unserved deadline reach the consultation regardless.
     *
     * Leaving it set put an expired deadline on a live consultation, and the
     * patient's own "Unfinished" card takes the earliest deadline it can see —
     * so the card hid itself on a consultation that was still running.
     */
    expect(consultation.rejoinableUntil).toBeNull();
    expect(consultation.interruptedAt).toBeNull();
    expect(consultation.firstInterruptedAt).not.toBeNull();
  });

  it('replaces a room the provider has forgotten, under the same consultation', async () => {
    const fixture = await liveConsultation();
    const first = await joinMediaSession(fixture.consultationId, 'PATIENT');

    // A restarted server, a deleted room, a room swept after its end date:
    // from Neem's side they are the same thing.
    const video = new MockVideoProvider();
    setMediaProvidersForTesting({ video, voice: new MockVoiceProvider() });

    const second = await joinMediaSession(fixture.consultationId, 'PATIENT');

    expect(second.providerRoomRef).not.toBe(first.providerRoomRef);

    const sessions = await getPrisma().mediaSession.findMany({
      where: { consultationId: fixture.consultationId },
      orderBy: { attempt: 'asc' },
    });
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.endReason).toBe('room_replaced');
    expect(sessions[1]!.attempt).toBe(2);
    // One open session, always.
    expect(sessions.filter((session) => session.endedAt === null)).toHaveLength(1);

    const payments = await getPrisma().payment.count({
      where: { consultationId: fixture.consultationId },
    });
    expect(payments).toBe(1);
  });

  it('opens one room, not two, when both parties rejoin at the same moment', async () => {
    const fixture = await liveConsultation();

    const video = new MockVideoProvider();
    setMediaProvidersForTesting({ video, voice: new MockVoiceProvider() });

    const [a, b] = await Promise.all([
      joinMediaSession(fixture.consultationId, 'PATIENT'),
      joinMediaSession(fixture.consultationId, 'DOCTOR'),
    ]);

    expect(a.providerRoomRef).toBe(b.providerRoomRef);

    const open = await getPrisma().mediaSession.count({
      where: { consultationId: fixture.consultationId, endedAt: null },
    });
    expect(open).toBe(1);
  });

  it('refuses a rejoin once the window has passed, without taking money', async () => {
    const fixture = await liveConsultation();
    await interruptConsultation(fixture.consultationId, { type: 'DOCTOR', id: fixture.doctorId });

    await getPrisma().consultation.update({
      where: { id: fixture.consultationId },
      data: { rejoinableUntil: new Date(Date.now() - 1000) },
    });

    await expect(joinMediaSession(fixture.consultationId, 'PATIENT')).rejects.toThrow(
      /window for rejoining/i,
    );

    const consultation = await getPrisma().consultation.findUniqueOrThrow({
      where: { id: fixture.consultationId },
    });
    // Still unfinished, still theirs. Expiry of the window is not forfeiture.
    expect(consultation.state).toBe('INTERRUPTED');
    expect(
      await getPrisma().payment.count({ where: { consultationId: fixture.consultationId } }),
    ).toBe(1);
  });

  it('can be completed by the doctor from interrupted, with the usual rules', async () => {
    const fixture = await liveConsultation();
    await interruptConsultation(fixture.consultationId, { type: 'DOCTOR', id: fixture.doctorId });

    await issueSummary(fixture.consultationId, fixture.doctorId, {
      presentingComplaint: 'Cough for three days.',
      assessment: 'Seen and assessed before the call dropped.',
      advice: 'Rest and fluids.',
      safetyNetting: 'Return if there is difficulty breathing.',
    });

    const result = await completeConsultation(fixture.consultationId, fixture.doctorId, {
      outcomes: ['ADVICE_ONLY'],
    });

    expect(result.state).toBe('COMPLETED');
    const consultation = await getPrisma().consultation.findUniqueOrThrow({
      where: { id: fixture.consultationId },
    });
    expect(consultation.clinicalSealedAt).not.toBeNull();
  });

  it('refuses a rejoin once the consultation is finished', async () => {
    const fixture = await liveConsultation();
    await issueSummary(fixture.consultationId, fixture.doctorId, {
      presentingComplaint: 'Cough.',
      assessment: 'Assessed.',
      advice: 'Rest.',
      safetyNetting: 'Return if worse.',
    });
    await completeConsultation(fixture.consultationId, fixture.doctorId, {
      outcomes: ['ADVICE_ONLY'],
    });

    await expect(joinMediaSession(fixture.consultationId, 'PATIENT')).rejects.toThrow(
      /cannot be joined/i,
    );
  });

  it('tears the room down when a consultation is cancelled, not only when it completes', async () => {
    const fixture = await liveConsultation();
    await joinMediaSession(fixture.consultationId, 'PATIENT');
    await interruptConsultation(fixture.consultationId, { type: 'DOCTOR', id: fixture.doctorId });

    await transition(fixture.consultationId, 'CANCELLED', {
      actorType: 'ADMIN',
      reason: 'test',
    });

    // The teardown is deliberately not awaited by the transition, so give the
    // microtask queue a turn before asserting.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const open = await getPrisma().mediaSession.count({
      where: { consultationId: fixture.consultationId, endedAt: null },
    });
    expect(open).toBe(0);
  });

  /*
   * The provider's webhook (D57).
   *
   * Signed the way the payment webhook is, and carrying strictly less
   * authority: attendance, and nothing that could end, pay for or refund a
   * consultation. Both halves are asserted — that a forgery is refused, and
   * that a genuine delivery cannot complete anything.
   */
  it('refuses a Whereby webhook whose signature does not verify', async () => {
    const app = await getTestApp();
    const body = JSON.stringify({ id: 'evt_forged', type: 'room.client.left', data: {} });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/whereby',
      headers: {
        'content-type': 'application/json',
        'whereby-signature': `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}`,
      },
      payload: body,
    });

    expect(response.statusCode).toBe(401);
    expect(await getPrisma().mediaWebhookEvent.count()).toBe(0);
  });

  it('records attendance from a signed webhook, and completes nothing', async () => {
    const fixture = await liveConsultation();
    const room = await getPrisma().mediaSession.findFirstOrThrow({
      where: { consultationId: fixture.consultationId },
      orderBy: { startedAt: 'desc' },
    });

    const app = await getTestApp();
    const body = JSON.stringify({
      id: 'evt_left_1',
      type: 'room.client.left',
      data: { meetingId: room.providerRoomRef, roleName: 'visitor' },
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac('sha256', process.env.WHEREBY_WEBHOOK_SECRET!)
      .update(`${timestamp}.${body}`)
      .digest('hex');

    const send = () =>
      app.inject({
        method: 'POST',
        url: '/api/v1/webhooks/whereby',
        headers: {
          'content-type': 'application/json',
          'whereby-signature': `t=${timestamp},v1=${signature}`,
        },
        payload: body,
      });

    const first = await send();
    const replayed = await send();

    expect(first.statusCode).toBe(200);
    expect(first.json().data.reason).toBe('left');
    // A retry is acknowledged rather than handled twice; erroring would only
    // make the provider send it again.
    expect(replayed.statusCode).toBe(200);
    expect(replayed.json().data.processed).toBe(false);

    const events = await getPrisma().callAttendanceEvent.count({
      where: { consultationId: fixture.consultationId, event: 'LEFT', source: 'WEBHOOK' },
    });
    expect(events).toBe(1);

    // The whole point: the room emptying is not the consultation ending.
    const consultation = await getPrisma().consultation.findUniqueOrThrow({
      where: { id: fixture.consultationId },
    });
    expect(consultation.state).toBe('IN_PROGRESS');
    expect(consultation.clinicalSealedAt).toBeNull();
  });

  /*
   * A doctor is never retired from the queue by a number (D59).
   *
   * `currentLoad` is incremented on accept and decremented on release, so it can
   * drift, and upward drift is silent and total: at a limit of one concurrent
   * consultation, one stray increment means every allocation skips that doctor
   * as AT_CAPACITY for ever. No screen says so. This is the fault that took a
   * doctor out of the live queue, found by a report of "the doctor does not see
   * the consultation".
   */
  it('puts a drifted slot count back to what the consultations say', async () => {
    const fixture = await liveConsultation();

    // The leak, reproduced: a count that says the doctor is busier than they
    // are. Before D57 a reassignment after acceptance left exactly this.
    await getPrisma().doctorPresence.updateMany({
      where: { doctorId: fixture.doctorId },
      data: { currentLoad: 3 },
    });

    const result = await reconcileDoctorLoad(fixture.doctorId);

    // One consultation is genuinely in progress, so the honest answer is one.
    expect(result.currentLoad).toBe(1);
    expect(result.corrected).toBe(true);
    expect(await currentLoad(fixture.doctorId)).toBe(1);
  });

  it('frees a doctor stranded at capacity when they come back online', async () => {
    const fixture = await liveConsultation();

    // Finish the consultation the honest way, then strand the count.
    await interruptConsultation(fixture.consultationId, { type: 'DOCTOR', id: fixture.doctorId });
    await transition(fixture.consultationId, 'ABANDONED', {
      actorType: 'ADMIN',
      reason: 'test',
    });
    await getPrisma().doctorPresence.updateMany({
      where: { doctorId: fixture.doctorId },
      data: { currentLoad: 1 },
    });

    // The one thing a doctor would try from their own dashboard.
    await goOnline(fixture.doctorId);

    // Nothing occupies them, so they are free, and the queue can reach them.
    expect(await currentLoad(fixture.doctorId)).toBe(0);
  });

  it('leaves an honest count alone, and reports no correction', async () => {
    const fixture = await liveConsultation();

    // One in progress, count says one: nothing to do.
    expect(await currentLoad(fixture.doctorId)).toBe(1);
    expect(await reconcileOnlineDoctorLoads()).toBe(0);
    expect(await currentLoad(fixture.doctorId)).toBe(1);
  });

  it('records an interruption once, without restarting the patient window', async () => {
    const fixture = await liveConsultation();

    const first = await interruptConsultation(fixture.consultationId, {
      type: 'DOCTOR',
      id: fixture.doctorId,
    });
    const second = await interruptConsultation(fixture.consultationId, {
      type: 'DOCTOR',
      id: fixture.doctorId,
    });

    expect(second.rejoinableUntil).toBe(first.rejoinableUntil);
    // And the slot is released once, not twice.
    expect(await currentLoad(fixture.doctorId)).toBe(0);
  });
});

describe('when the video provider will not cooperate', () => {
  /**
   * A provider that refuses everything, the way Whereby does with a key it no
   * longer recognises.
   */
  function refusingProvider() {
    const video = new MockVideoProvider();
    video.createRoom = async () => {
      throw new MediaProviderError('Whereby returned 401 for /meetings');
    };
    return video;
  }

  it('says the service is unavailable, not that something went wrong on our side', async () => {
    const fixture = await liveConsultation({ doctorJoins: false });
    setMediaProvidersForTesting({ video: refusingProvider(), voice: new MockVoiceProvider() });

    const response = await request('/patient/consultation/media/join', {
      method: 'POST',
      cookies: fixture.patientCookies,
    });

    /*
     * Unmapped, this was a 500 reading "Something went wrong on our side" —
     * the same sentence a null dereference produces. A patient was told the
     * fault was ours and that waiting would fix it, and an operator could not
     * tell an outage from a bug without a stack trace.
     */
    expect(response.status).toBe(503);
    expect(response.body.error?.code).toBe('PROVIDER_UNAVAILABLE');
    expect(response.body.error?.message).not.toMatch(/went wrong on our side/i);
  });

  it('tells the patient nothing about the provider', async () => {
    const fixture = await liveConsultation({ doctorJoins: false });
    const video = new MockVideoProvider();
    video.createRoom = async () => {
      throw new MediaProviderError('Whereby returned 401 for /meetings', 'room-ref-abc');
    };
    setMediaProvidersForTesting({ video, voice: new MockVoiceProvider() });

    const response = await request('/patient/consultation/media/join', {
      method: 'POST',
      cookies: fixture.patientCookies,
    });

    // Rule 1 of the error handler: never a provider payload. A room URL is a
    // bearer credential, and the safe habit is to send none of it.
    const body = JSON.stringify(response.body);
    expect(body).not.toMatch(/whereby/i);
    expect(body).not.toMatch(/room-ref-abc/);
    expect(body).not.toMatch(/401/);
  });

  it('opens no room and leaves the consultation where it was', async () => {
    const fixture = await liveConsultation({ doctorJoins: false });
    setMediaProvidersForTesting({ video: refusingProvider(), voice: new MockVoiceProvider() });

    await request('/patient/consultation/media/join', {
      method: 'POST',
      cookies: fixture.patientCookies,
    });

    /*
     * The failure that prompted this left a consultation with no media session
     * at all, which is how it was finally diagnosed. Worth asserting: a failed
     * join must not leave a half-made room behind.
     */
    const sessions = await getPrisma().mediaSession.count({
      where: { consultationId: fixture.consultationId },
    });
    expect(sessions).toBe(0);

    const consultation = await getPrisma().consultation.findUniqueOrThrow({
      where: { id: fixture.consultationId },
    });
    expect(consultation.state).toBe('DOCTOR_ACCEPTED');
  });
});
