import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPrisma, disconnectPrisma } from '../../src/db/prisma.ts';
import { closeTestApp, request, signIn } from '../helpers/app.ts';
import { createTestPharmacy, createTestUser, resetDatabase } from '../helpers/database.ts';
import {
  MockPaymentProvider,
  setPaymentProviderForTesting,
} from '../../src/adapters/payment/index.ts';
import {
  MockVideoProvider,
  MockVoiceProvider,
  setMediaProvidersForTesting,
} from '../../src/adapters/media/index.ts';
import { acceptOffer, offerNextDoctor } from '../../src/modules/queue/allocation.service.ts';
import { goOnline } from '../../src/modules/queue/presence.service.ts';
import { generatePublicId, hashPassword, encryptField } from '../../src/lib/crypto.ts';
import { fixedClock } from '../../src/lib/clock.ts';
import {
  getTimer,
  joinMediaSession,
  endMediaSession,
} from '../../src/modules/media/media.service.ts';
import { invalidateSettingsCache } from '../../src/modules/settings/settings.service.ts';

/**
 * The media layer against a real database (spec §15, §32, §33).
 *
 * The most important test in this file asserts a negative: that no recording
 * can be created, by any route, adapter method, or column write (decision D8).
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

async function createOnlineDoctor(
  withPhone: boolean,
): Promise<{ doctorId: string; email: string }> {
  const prisma = getPrisma();
  const suffix = generatePublicId('x').slice(-8);
  const email = `${suffix}@doctor.test`;

  const user = await prisma.user.create({
    data: {
      publicId: generatePublicId('usr'),
      email,
      passwordHash: await hashPassword(DOCTOR_PASSWORD),
      role: 'DOCTOR',
      status: 'ACTIVE',
      isDemo: true,
    },
  });

  const languages = await prisma.language.findMany({ where: { code: { in: ['en'] } } });
  const expiry = new Date();
  expiry.setFullYear(expiry.getFullYear() + 1);

  const doctor = await prisma.doctor.create({
    data: {
      publicId: generatePublicId('doc'),
      userId: user.id,
      fullName: 'Dr. Media',
      mdcNumber: `MDC-M-${suffix}`,
      mdcExpiresAt: expiry,
      status: 'ACTIVE',
      isDemo: true,
      phoneEnc: withPhone ? encryptField('+233240000111') : null,
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

/** A consultation the doctor has accepted, ready for media to start. */
/**
 * A paid consultation with a patient who has given their details and language,
 * and is at the point of choosing how to consult.
 *
 * Split out of `acceptedConsultation` so a test can stand exactly where the
 * patient stands when the mode list is built (D38).
 */
async function patientChoosingMode(options: { doctorHasPhone?: boolean } = {}) {
  const prisma = getPrisma();
  const doctor = await createOnlineDoctor(options.doctorHasPhone ?? true);

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
    payload: { fullName: 'Kofi Boateng', age: 41, sex: 'MALE', phone: '0240000222' },
  });
  await request('/patient/session/language', {
    method: 'POST',
    cookies: exchange.cookies,
    payload: { languageCode: 'en' },
  });
  return { prisma, doctor, publicId, patientCookies: exchange.cookies };
}

async function acceptedConsultation(
  type: 'VIDEO' | 'AUDIO' | 'CALL_ME',
  options: { doctorHasPhone?: boolean } = {},
): Promise<Fixture> {
  const { prisma, doctor, publicId, patientCookies } = await patientChoosingMode(options);

  await request('/patient/session/mode', {
    method: 'POST',
    cookies: patientCookies,
    payload: { type },
  });

  await offerNextDoctor((await prisma.consultation.findUniqueOrThrow({ where: { publicId } })).id);
  const accepted = await acceptOffer(publicId, doctor.doctorId);
  expect(accepted.accepted).toBe(true);

  const consultation = await prisma.consultation.findUniqueOrThrow({ where: { publicId } });

  return {
    consultationId: consultation.id,
    consultationPublicId: publicId,
    doctorId: doctor.doctorId,
    doctorCookies: await signIn(doctor.email, DOCTOR_PASSWORD),
    patientCookies,
  };
}

beforeEach(async () => {
  await resetDatabase();
  setPaymentProviderForTesting(new MockPaymentProvider());
  setMediaProvidersForTesting({ video: new MockVideoProvider(), voice: new MockVoiceProvider() });
});

afterAll(async () => {
  setPaymentProviderForTesting(undefined);
  setMediaProvidersForTesting();
  await closeTestApp();
  await disconnectPrisma();
});

// ---------------------------------------------------------------------------
// Recording — the guarantee this module exists to keep (spec §32, D8)
// ---------------------------------------------------------------------------

describe('recordings are structurally impossible', () => {
  it('never sets recordingEnabled on a session it creates', async () => {
    const fixture = await acceptedConsultation('VIDEO');

    await joinMediaSession(fixture.consultationId, 'DOCTOR');
    await joinMediaSession(fixture.consultationId, 'PATIENT');

    const sessions = await getPrisma().mediaSession.findMany({
      where: { consultationId: fixture.consultationId },
    });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.recordingEnabled).toBe(false);
  });

  it('exposes no recording capability on either provider interface', () => {
    const video = new MockVideoProvider() as unknown as Record<string, unknown>;
    const voice = new MockVoiceProvider() as unknown as Record<string, unknown>;

    // If a future adapter adds one of these, this fails before it can ship.
    for (const forbidden of [
      'startRecording',
      'stopRecording',
      'enableRecording',
      'recordingRules',
      'getRecording',
      'listRecordings',
      'downloadRecording',
    ]) {
      expect(video[forbidden]).toBeUndefined();
      expect(voice[forbidden]).toBeUndefined();
    }
  });

  it('has no source file that asks a provider to record', () => {
    /**
     * A grep, deliberately: the guarantee is about the whole codebase, not
     * about the one adapter that happens to be wired up today.
     *
     * It covers the web app as well as the API, and that became necessary in
     * Phase 11. Whereby's embed element exposes `startRecording()` to the
     * browser, so for the first time a recording could be started from client
     * code with no server route involved — the API-only scan this used to be
     * would not have seen it (D35).
     */
    const offenders: string[] = [];
    const pattern = /\b(startRecording|enableRecording|recordingRules|record(ing)?\s*:\s*true)\b/;

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
        } else if (
          (full.endsWith('.ts') || full.endsWith('.tsx')) &&
          !full.endsWith('.test.ts') &&
          !full.endsWith('.test.tsx')
        ) {
          // Comments are stripped first: the interfaces document the absence
          // of these methods by naming them, and saying so must not trip the
          // check that enforces it.
          const code = readFileSync(full, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/(^|[^:])\/\/.*$/gm, '$1');

          if (pattern.test(code)) offenders.push(full);
        }
      }
    };

    const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');
    walk(join(repoRoot, 'apps', 'api', 'src'));
    walk(join(repoRoot, 'apps', 'web', 'src'));
    walk(join(repoRoot, 'packages', 'contracts', 'src'));

    expect(
      offenders,
      'A source file asks something to record. Consultations are never ' +
        'recorded (spec §32) — if this is a false positive from wording, ' +
        'reword it rather than relaxing the pattern.',
    ).toEqual([]);
  });

  it('offers no API route that mentions recording', async () => {
    const fixture = await acceptedConsultation('VIDEO');

    for (const path of [
      '/patient/consultation/media/recording',
      '/patient/consultation/recording',
      `/doctor/consultations/${fixture.consultationPublicId}/recording`,
      `/doctor/consultations/${fixture.consultationPublicId}/media/recording`,
    ]) {
      const response = await request(path, { method: 'POST', cookies: fixture.doctorCookies });
      expect(response.status).toBe(404);
    }
  });
});

// ---------------------------------------------------------------------------
// Joining
// ---------------------------------------------------------------------------

describe('joining a media session', () => {
  it('starts the consultation when the doctor joins', async () => {
    const fixture = await acceptedConsultation('VIDEO');

    const response = await request<{ joinToken: string; isMockProvider: boolean }>(
      `/doctor/consultations/${fixture.consultationPublicId}/media/join`,
      { method: 'POST', cookies: fixture.doctorCookies },
    );

    expect(response.status).toBe(200);
    expect(response.body.data!.joinToken).toBeTruthy();
    // Surfaced, never hidden: the UI says media is simulated (decision D18).
    expect(response.body.data!.isMockProvider).toBe(true);

    const consultation = await getPrisma().consultation.findUniqueOrThrow({
      where: { id: fixture.consultationId },
    });
    expect(consultation.state).toBe('IN_PROGRESS');
    expect(consultation.startedAt).not.toBeNull();
  });

  it('reuses the same room when a participant rejoins after a drop', async () => {
    const fixture = await acceptedConsultation('VIDEO');

    const first = await joinMediaSession(fixture.consultationId, 'PATIENT');
    const second = await joinMediaSession(fixture.consultationId, 'PATIENT');

    expect(second.providerRoomRef).toBe(first.providerRoomRef);
    // A fresh credential, though — a reload must not reuse an expiring token.
    expect(second.joinToken).not.toBe(first.joinToken);

    const sessions = await getPrisma().mediaSession.count({
      where: { consultationId: fixture.consultationId },
    });
    expect(sessions).toBe(1);
  });

  it('refuses a doctor who is not assigned to the consultation', async () => {
    const fixture = await acceptedConsultation('VIDEO');
    const other = await createOnlineDoctor(true);
    const otherCookies = await signIn(other.email, DOCTOR_PASSWORD);

    const response = await request(
      `/doctor/consultations/${fixture.consultationPublicId}/media/join`,
      { method: 'POST', cookies: otherCookies },
    );

    // 404, not 403: another doctor's consultation must not be confirmed to
    // exist (spec §102).
    expect(response.status).toBe(404);
  });

  it('refuses an unauthenticated patient', async () => {
    await acceptedConsultation('VIDEO');

    const response = await request('/patient/consultation/media/join', { method: 'POST' });
    expect(response.status).toBe(401);
  });

  it('does not create a room for a Call Me consultation', async () => {
    const fixture = await acceptedConsultation('CALL_ME');

    await expect(joinMediaSession(fixture.consultationId, 'PATIENT')).rejects.toThrow(/Call Me/i);
  });
});

// ---------------------------------------------------------------------------
// The timer (spec §15)
// ---------------------------------------------------------------------------

describe('the consultation timer', () => {
  it('warns as the target approaches but never ends the consultation', async () => {
    const fixture = await acceptedConsultation('VIDEO');
    await joinMediaSession(fixture.consultationId, 'DOCTOR');

    const startedAt = (
      await getPrisma().consultation.findUniqueOrThrow({ where: { id: fixture.consultationId } })
    ).startedAt!;

    // 30 seconds left of the 5-minute default: inside the 60s warning window.
    const nearlyUp = fixedClock(new Date(startedAt.getTime() + 270_000));
    const warning = await getTimer(fixture.consultationId, getPrisma(), nearlyUp);

    expect(warning!.remainingSeconds).toBe(30);
    expect(warning!.warning).toBe(true);
    expect(warning!.overrun).toBe(false);

    // Ten minutes past the target — double the allotted time.
    const wellOver = fixedClock(new Date(startedAt.getTime() + 900_000));
    const overrun = await getTimer(fixture.consultationId, getPrisma(), wellOver);

    expect(overrun!.overrun).toBe(true);
    expect(overrun!.overrunSeconds).toBe(600);

    // The point of the whole test: the consultation is still live. Nothing
    // the timer does can end it — only the doctor completes (spec §15, §16).
    const consultation = await getPrisma().consultation.findUniqueOrThrow({
      where: { id: fixture.consultationId },
    });
    expect(consultation.state).toBe('IN_PROGRESS');
    expect(consultation.completedAt).toBeNull();
  });

  it('is readable by the patient and reports the configured duration', async () => {
    const fixture = await acceptedConsultation('VIDEO');
    await joinMediaSession(fixture.consultationId, 'DOCTOR');

    const response = await request<{ durationSeconds: number; remainingSeconds: number }>(
      '/patient/consultation/timer',
      { cookies: fixture.patientCookies },
    );

    expect(response.status).toBe(200);
    expect(response.body.data!.durationSeconds).toBe(300);
    expect(response.body.data!.remainingSeconds).toBeGreaterThan(290);
  });

  it('returns nothing before the consultation has started', async () => {
    const fixture = await acceptedConsultation('VIDEO');

    expect(await getTimer(fixture.consultationId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Call Me (spec §33)
// ---------------------------------------------------------------------------

describe('Call Me', () => {
  it('bridges the call without disclosing either phone number', async () => {
    const fixture = await acceptedConsultation('CALL_ME');

    const response = await request<Record<string, unknown>>(
      `/doctor/consultations/${fixture.consultationPublicId}/call`,
      { method: 'POST', cookies: fixture.doctorCookies },
    );

    expect(response.status).toBe(200);
    expect(response.body.data!.callerIdShown).toBe('Neem');

    // Neither number appears anywhere in the response — not in a field the
    // client ignores, not in an error, not in metadata.
    const serialised = JSON.stringify(response.body);
    expect(serialised).not.toContain('0240000222');
    expect(serialised).not.toContain('233240000222');
    expect(serialised).not.toContain('+233240000111');
    expect(serialised).not.toContain('0240000111');
  });

  it('moves the consultation to IN_PROGRESS', async () => {
    const fixture = await acceptedConsultation('CALL_ME');

    await request(`/doctor/consultations/${fixture.consultationPublicId}/call`, {
      method: 'POST',
      cookies: fixture.doctorCookies,
    });

    const consultation = await getPrisma().consultation.findUniqueOrThrow({
      where: { id: fixture.consultationId },
    });
    expect(consultation.state).toBe('IN_PROGRESS');
  });

  /*
   * The pilot's first month buys one simultaneous call, so the second is
   * refused rather than dialled. These tests exist because the failure they
   * prevent happens at a pharmacy counter with a patient waiting, and would
   * otherwise arrive as whatever the provider chose to say.
   */
  it('refuses a second call while the subscription only allows one', async () => {
    const first = await acceptedConsultation('CALL_ME');
    const second = await acceptedConsultation('CALL_ME');

    const placed = await request(`/doctor/consultations/${first.consultationPublicId}/call`, {
      method: 'POST',
      cookies: first.doctorCookies,
    });
    expect(placed.status).toBe(200);

    const refused = await request<unknown>(
      `/doctor/consultations/${second.consultationPublicId}/call`,
      { method: 'POST', cookies: second.doctorCookies },
    );

    expect(refused.status).toBe(422);
    // The doctor is told what to do instead, not just that it failed.
    expect(JSON.stringify(refused.body)).toMatch(/one at a time|audio or video/i);

    // And nothing was dialled: no second session was opened.
    const live = await getPrisma().mediaSession.count({
      where: { kind: 'VOICE_BRIDGE', endedAt: null },
    });
    expect(live).toBe(1);
  });

  it('lets the same consultation retry without competing with itself', async () => {
    const fixture = await acceptedConsultation('CALL_ME');

    const first = await request(`/doctor/consultations/${fixture.consultationPublicId}/call`, {
      method: 'POST',
      cookies: fixture.doctorCookies,
    });
    expect(first.status).toBe(200);

    // A doctor pressing the button again must not be told the line is busy by
    // their own call.
    const again = await request(`/doctor/consultations/${fixture.consultationPublicId}/call`, {
      method: 'POST',
      cookies: fixture.doctorCookies,
    });
    expect(again.status).toBe(200);
  });

  it('frees the line when the first consultation ends', async () => {
    const first = await acceptedConsultation('CALL_ME');
    const second = await acceptedConsultation('CALL_ME');

    await request(`/doctor/consultations/${first.consultationPublicId}/call`, {
      method: 'POST',
      cookies: first.doctorCookies,
    });

    // endMediaSession is the single exit for every media session, so closing
    // the consultation is what must release the capacity.
    await endMediaSession(first.consultationId, 'test_completed');

    const afterwards = await request(`/doctor/consultations/${second.consultationPublicId}/call`, {
      method: 'POST',
      cookies: second.doctorCookies,
    });

    expect(afterwards.status).toBe(200);
  });

  it('allows a second call once the plan is raised, without a deploy', async () => {
    const first = await acceptedConsultation('CALL_ME');
    const second = await acceptedConsultation('CALL_ME');

    // Month two buys more capacity. That is a settings change, which is the
    // whole reason the limit is not a constant in the code.
    await getPrisma().systemSetting.update({
      where: { key: 'media.maxConcurrentBridgedCalls' },
      data: { value: '2' },
    });
    invalidateSettingsCache();

    await request(`/doctor/consultations/${first.consultationPublicId}/call`, {
      method: 'POST',
      cookies: first.doctorCookies,
    });

    const alsoPlaced = await request(`/doctor/consultations/${second.consultationPublicId}/call`, {
      method: 'POST',
      cookies: second.doctorCookies,
    });

    expect(alsoPlaced.status).toBe(200);
  });

  it('refuses when the doctor has no contact number on file', async () => {
    const fixture = await acceptedConsultation('CALL_ME', { doctorHasPhone: false });

    const response = await request<unknown>(
      `/doctor/consultations/${fixture.consultationPublicId}/call`,
      { method: 'POST', cookies: fixture.doctorCookies },
    );

    expect(response.status).toBe(422);
    expect(JSON.stringify(response.body)).toMatch(/contact number/i);
  });

  it('refuses on a video consultation', async () => {
    const fixture = await acceptedConsultation('VIDEO');

    const response = await request(`/doctor/consultations/${fixture.consultationPublicId}/call`, {
      method: 'POST',
      cookies: fixture.doctorCookies,
    });

    expect(response.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// Ending
// ---------------------------------------------------------------------------

describe('ending a media session', () => {
  it('closes every open session and records why', async () => {
    const fixture = await acceptedConsultation('VIDEO');
    await joinMediaSession(fixture.consultationId, 'DOCTOR');

    await endMediaSession(fixture.consultationId, 'consultation_completed');

    const session = await getPrisma().mediaSession.findFirstOrThrow({
      where: { consultationId: fixture.consultationId },
    });
    expect(session.endedAt).not.toBeNull();
    expect(session.endReason).toBe('consultation_completed');
    expect(session.recordingEnabled).toBe(false);
  });

  it('does not throw when the provider is unreachable', async () => {
    const fixture = await acceptedConsultation('VIDEO');
    await joinMediaSession(fixture.consultationId, 'DOCTOR');

    const failing = new MockVideoProvider();
    failing.endRoom = async () => {
      throw new Error('provider unreachable');
    };
    setMediaProvidersForTesting({ video: failing, voice: new MockVoiceProvider() });

    // Completion must not be blocked by a provider outage — the clinical
    // record and the purge matter more than a room that will expire anyway.
    await expect(
      endMediaSession(fixture.consultationId, 'consultation_completed'),
    ).resolves.toBeUndefined();

    const session = await getPrisma().mediaSession.findFirstOrThrow({
      where: { consultationId: fixture.consultationId },
    });
    expect(session.endedAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Call Me switched off (decision D38)
// ---------------------------------------------------------------------------

describe('when Call Me is switched off', () => {
  beforeEach(() => {
    // The rest of this file injects a voice provider, which is how the Call Me
    // tests above still exercise the mode. Clearing it is what "off" means.
    setMediaProvidersForTesting({ video: new MockVideoProvider() });
  });

  afterEach(() => {
    setMediaProvidersForTesting({ video: new MockVideoProvider(), voice: new MockVoiceProvider() });
  });

  it('does not offer the mode to the patient', async () => {
    const fixture = await patientChoosingMode();

    const response = await request<{ availableTypes: string[] }>('/patient/session', {
      cookies: fixture.patientCookies,
    });

    expect(response.status).toBe(200);
    expect(response.body.data!.availableTypes).toEqual(['AUDIO', 'VIDEO']);
  });

  it('refuses it even when a client asks for it anyway', async () => {
    /**
     * The assertion that matters. Filtering the list is presentation; this is
     * the boundary. A patient's screen is not what decides whether a mode is
     * available, and a request naming CALL_ME is refused whatever the client
     * believed (spec §7 — every rule the UI applies is enforced again here).
     */
    const fixture = await patientChoosingMode();

    const response = await request('/patient/session/mode', {
      method: 'POST',
      cookies: fixture.patientCookies,
      payload: { type: 'CALL_ME' },
    });

    expect(response.status).toBe(422);
    expect(JSON.stringify(response.body)).toMatch(/not available/i);
  });

  it('still allows audio and video', async () => {
    // "Off" must switch off one mode, not the consultation.
    const fixture = await patientChoosingMode();

    const response = await request('/patient/session/mode', {
      method: 'POST',
      cookies: fixture.patientCookies,
      payload: { type: 'AUDIO' },
    });

    expect(response.status).toBe(200);
  });
});
