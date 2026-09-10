import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getPrisma, disconnectPrisma } from '../../src/db/prisma.ts';
import { closeTestApp, request, signIn } from '../helpers/app.ts';
import { createTestPharmacy, createTestUser, resetDatabase } from '../helpers/database.ts';
import {
  MockPaymentProvider,
  setPaymentProviderForTesting,
} from '../../src/adapters/payment/index.ts';
import {
  acceptOffer,
  enforceResponseWindow,
  offerNextDoctor,
  processWaitingQueue,
} from '../../src/modules/queue/allocation.service.ts';
import { goOnline } from '../../src/modules/queue/presence.service.ts';
import { transition } from '../../src/modules/consultation/consultation.service.ts';
import { fixedClock } from '../../src/lib/clock.ts';
import { generatePublicId, hashPassword } from '../../src/lib/crypto.ts';

/**
 * The allocation engine against a real database (spec §29, §30, §37).
 *
 * Covers required end-to-end scenarios 3 (paid, no doctor available), 4
 * (missed 90-second window) and 5 (no language match).
 */

const PHARMACY = { email: 'pharmacy@test.local', password: 'PharmacyPassword123!' };

/** An ACTIVE doctor, on a confirmed shift covering now, online and eligible. */
async function createEligibleDoctor(options: {
  name: string;
  languageCodes: string[];
}): Promise<{ doctorId: string; email: string; password: string }> {
  const prisma = getPrisma();
  const suffix = generatePublicId('x').slice(-8).toLowerCase();
  const email = `${suffix}@doctor.test`;
  const password = 'DoctorPassword123!';

  const user = await prisma.user.create({
    data: {
      publicId: generatePublicId('usr'),
      email,
      passwordHash: await hashPassword(password),
      role: 'DOCTOR',
      status: 'ACTIVE',
      isDemo: true,
    },
  });

  const languages = await prisma.language.findMany({
    where: { code: { in: options.languageCodes } },
  });

  const expiry = new Date();
  expiry.setFullYear(expiry.getFullYear() + 1);

  const doctor = await prisma.doctor.create({
    data: {
      publicId: generatePublicId('doc'),
      userId: user.id,
      fullName: options.name,
      mdcNumber: `MDC-Q-${suffix}`,
      mdcExpiresAt: expiry,
      status: 'ACTIVE',
      isDemo: true,
      languages: {
        create: languages.map((language, index) => ({
          languageId: language.id,
          isPrimary: index === 0,
        })),
      },
    },
  });

  // A confirmed shift covering the whole day, so the test is not sensitive to
  // the hour at which it runs.
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

  return { doctorId: doctor.id, email, password };
}

/** Drives a consultation to WAITING_FOR_DOCTOR in the given language. */
async function queuedConsultation(languageCode: string): Promise<{ id: string; publicId: string }> {
  const prisma = getPrisma();
  const pharmacy = await createTestPharmacy(
    `Pharmacy ${generatePublicId('x').slice(-6)}`,
    'ACTIVE',
  );
  const user = await createTestUser({
    email: `${generatePublicId('x').slice(-8)}@pharmacy.test`,
    password: PHARMACY.password,
    role: 'PHARMACY',
  });
  await prisma.pharmacyUser.create({ data: { pharmacyId: pharmacy.id, userId: user.id } });

  const cookies = await signIn(user.email, PHARMACY.password);

  const created = await request<{ publicId: string }>('/pharmacy/consultations', {
    method: 'POST',
    cookies,
    payload: {},
  });
  const publicId = created.body.data!.publicId;

  await request(`/pharmacy/consultations/${publicId}/payment`, {
    method: 'POST',
    cookies,
    payload: {},
  });
  await request(`/pharmacy/consultations/${publicId}/payment/simulate`, {
    method: 'POST',
    cookies,
    payload: { outcome: 'SUCCESS' },
  });

  const qr = await request<{ url: string }>(`/pharmacy/consultations/${publicId}/qr`, {
    method: 'POST',
    cookies,
    payload: {},
  });
  const token = qr.body.data!.url.split('/s/')[1]!;
  const exchange = await request('/s/exchange', { method: 'POST', payload: { token } });

  await request('/patient/session/identity', {
    method: 'POST',
    cookies: exchange.cookies,
    payload: { fullName: 'Efua Mensah', age: 34, sex: 'FEMALE', phone: '0240000000' },
  });
  await request('/patient/session/language', {
    method: 'POST',
    cookies: exchange.cookies,
    payload: { languageCode },
  });
  await request('/patient/session/mode', {
    method: 'POST',
    cookies: exchange.cookies,
    payload: { type: 'VIDEO' },
  });

  const consultation = await prisma.consultation.findUniqueOrThrow({ where: { publicId } });
  return { id: consultation.id, publicId };
}

beforeEach(async () => {
  await resetDatabase();
  setPaymentProviderForTesting(new MockPaymentProvider());
});

afterAll(async () => {
  setPaymentProviderForTesting(undefined);
  await closeTestApp();
  await disconnectPrisma();
});

describe('offering a consultation', () => {
  it('offers it to an eligible doctor and records the score breakdown', async () => {
    const doctor = await createEligibleDoctor({
      name: 'Dr. Available',
      languageCodes: ['en', 'tw'],
    });
    const consultation = await queuedConsultation('tw');

    const result = await offerNextDoctor(consultation.id);

    expect(result.offered).toBe(true);
    expect(result.doctorId).toBe(doctor.doctorId);

    const assignment = await getPrisma().consultationAssignment.findFirstOrThrow({
      where: { consultationId: consultation.id },
    });
    expect(assignment.result).toBe('PENDING');
    // Stored so the allocation can be explained afterwards (spec §28).
    expect(assignment.scoreBreakdown).toMatchObject({ language: expect.any(Number) });
    expect(Number(assignment.score)).toBeGreaterThan(0);
  });

  it('moves the consultation to ASSIGNED', async () => {
    await createEligibleDoctor({ name: 'Dr. Available', languageCodes: ['en'] });
    const consultation = await queuedConsultation('en');

    await offerNextDoctor(consultation.id);

    const fresh = await getPrisma().consultation.findUniqueOrThrow({
      where: { id: consultation.id },
    });
    expect(fresh.state).toBe('ASSIGNED');
    expect(fresh.doctorId).not.toBeNull();
  });

  it('never offers to a doctor who does not speak the language (spec §29)', async () => {
    // A doctor who is perfect on every other axis but speaks only English.
    await createEligibleDoctor({ name: 'Dr. English Only', languageCodes: ['en'] });
    const consultation = await queuedConsultation('ga');

    const result = await offerNextDoctor(consultation.id);

    expect(result.offered).toBe(false);
    expect(result.reason).toBe('NO_ELIGIBLE_DOCTOR');
    expect(await getPrisma().consultationAssignment.count()).toBe(0);
  });

  it('never offers to a doctor who is offline', async () => {
    const doctor = await createEligibleDoctor({ name: 'Dr. Gone', languageCodes: ['en'] });
    await getPrisma().doctorPresence.updateMany({
      where: { doctorId: doctor.doctorId },
      data: { lastHeartbeatAt: new Date(Date.now() - 10 * 60_000) },
    });

    const consultation = await queuedConsultation('en');
    expect((await offerNextDoctor(consultation.id)).offered).toBe(false);
  });

  it('never offers to a suspended doctor', async () => {
    const doctor = await createEligibleDoctor({ name: 'Dr. Suspended', languageCodes: ['en'] });
    await getPrisma().doctor.update({
      where: { id: doctor.doctorId },
      data: { status: 'SUSPENDED' },
    });

    const consultation = await queuedConsultation('en');
    expect((await offerNextDoctor(consultation.id)).offered).toBe(false);
  });
});

/** Required scenario 5 — no language match raises an admin alert. */
describe('scenario 5 — no language match', () => {
  it('keeps the patient queued and raises an admin alert', async () => {
    await createEligibleDoctor({ name: 'Dr. English Only', languageCodes: ['en'] });
    const consultation = await queuedConsultation('ga');

    const result = await offerNextDoctor(consultation.id);

    expect(result.languageStarved).toBe(true);

    // The patient waits; the consultation is never failed or discarded.
    const fresh = await getPrisma().consultation.findUniqueOrThrow({
      where: { id: consultation.id },
    });
    expect(fresh.state).toBe('WAITING_FOR_DOCTOR');

    const entry = await getPrisma().consultationQueueEntry.findUniqueOrThrow({
      where: { consultationId: consultation.id },
    });
    expect(entry.state).toBe('WAITING');
    expect(entry.noMatchAlertedAt).not.toBeNull();

    const alerts = await getPrisma().auditLog.findMany({
      where: { action: 'queue.no-language-match' },
    });
    expect(alerts).toHaveLength(1);
  });

  it('alerts once, not on every sweep', async () => {
    await createEligibleDoctor({ name: 'Dr. English Only', languageCodes: ['en'] });
    const consultation = await queuedConsultation('ga');

    await offerNextDoctor(consultation.id);
    await offerNextDoctor(consultation.id);
    await offerNextDoctor(consultation.id);

    // Repeating the alert every few seconds would bury an admin in duplicates
    // of one problem.
    const alerts = await getPrisma().auditLog.findMany({
      where: { action: 'queue.no-language-match' },
    });
    expect(alerts).toHaveLength(1);
  });

  it('assigns as soon as a doctor who speaks the language comes online', async () => {
    await createEligibleDoctor({ name: 'Dr. English Only', languageCodes: ['en'] });
    const consultation = await queuedConsultation('ga');

    expect((await offerNextDoctor(consultation.id)).offered).toBe(false);

    const gaSpeaker = await createEligibleDoctor({ name: 'Dr. Ga', languageCodes: ['ga', 'en'] });
    const offered = await processWaitingQueue();

    expect(offered).toBe(1);
    const assignment = await getPrisma().consultationAssignment.findFirstOrThrow({
      where: { consultationId: consultation.id },
    });
    expect(assignment.doctorId).toBe(gaSpeaker.doctorId);
  });
});

/** Required scenario 3 — paid, but no doctor available. */
describe('scenario 3 — paid with no doctor available', () => {
  it('keeps a paid consultation waiting rather than discarding it (spec §37)', async () => {
    // Nobody online at all.
    const consultation = await queuedConsultation('en');

    const result = await offerNextDoctor(consultation.id);
    expect(result.offered).toBe(false);

    const fresh = await getPrisma().consultation.findUniqueOrThrow({
      where: { id: consultation.id },
    });
    expect(fresh.state).toBe('WAITING_FOR_DOCTOR');

    // And the payment stands — a paid consultation is never quietly dropped.
    const payment = await getPrisma().payment.findFirstOrThrow({
      where: { consultationId: consultation.id },
    });
    expect(payment.status).toBe('SUCCESS');
  });
});

/** Required scenario 4 — the doctor misses the 90-second window. */
describe('scenario 4 — missed response window', () => {
  it('records a missed response and reassigns to another doctor', async () => {
    const first = await createEligibleDoctor({ name: 'Dr. Distracted', languageCodes: ['en'] });
    const consultation = await queuedConsultation('en');

    const offer = await offerNextDoctor(consultation.id);
    expect(offer.offered).toBe(true);

    // A second doctor becomes available while the first ignores the offer.
    const second = await createEligibleDoctor({ name: 'Dr. Attentive', languageCodes: ['en'] });

    // 91 seconds later — past the seeded 90-second window.
    const sweptAt = new Date(Date.now() + 91_000);

    // A doctor who is genuinely present keeps heartbeating, so their last
    // heartbeat tracks the clock. Without this the advanced clock would make
    // both doctors look stale and the reassignment would have nowhere to go —
    // an artefact of moving time in the test, not of the engine.
    await getPrisma().doctorPresence.updateMany({
      where: { doctorId: second.doctorId },
      data: { lastHeartbeatAt: sweptAt },
    });

    const swept = await enforceResponseWindow(getPrisma(), fixedClock(sweptAt));

    expect(swept.missed).toBe(1);
    expect(swept.reoffered).toBe(1);

    const assignments = await getPrisma().consultationAssignment.findMany({
      where: { consultationId: consultation.id },
      orderBy: { attemptNumber: 'asc' },
    });
    expect(assignments).toHaveLength(2);
    expect(assignments[0]).toMatchObject({ doctorId: first.doctorId, result: 'MISSED' });
    expect(assignments[1]).toMatchObject({ doctorId: second.doctorId, result: 'PENDING' });
  });

  it('records the miss against the doctor’s performance data (spec §30)', async () => {
    const doctor = await createEligibleDoctor({ name: 'Dr. Distracted', languageCodes: ['en'] });
    const consultation = await queuedConsultation('en');
    await offerNextDoctor(consultation.id);

    await enforceResponseWindow(getPrisma(), fixedClock(new Date(Date.now() + 91_000)));

    const events = await getPrisma().doctorPerformanceEvent.findMany({
      where: { doctorId: doctor.doctorId, type: 'MISSED_RESPONSE' },
    });
    expect(events).toHaveLength(1);
  });

  it('never re-offers to the doctor who just missed it', async () => {
    // Only one doctor exists, so the reassignment has nobody to go to — and it
    // must not loop back to the same doctor (spec §30).
    await createEligibleDoctor({ name: 'Dr. Only', languageCodes: ['en'] });
    const consultation = await queuedConsultation('en');
    await offerNextDoctor(consultation.id);

    const swept = await enforceResponseWindow(
      getPrisma(),
      fixedClock(new Date(Date.now() + 91_000)),
    );

    expect(swept.missed).toBe(1);
    expect(swept.reoffered).toBe(0);

    const fresh = await getPrisma().consultation.findUniqueOrThrow({
      where: { id: consultation.id },
    });
    expect(fresh.state).toBe('REASSIGNING');
    expect(await getPrisma().consultationAssignment.count()).toBe(1);
  });

  it('does not touch an offer that is still within its window', async () => {
    await createEligibleDoctor({ name: 'Dr. Thinking', languageCodes: ['en'] });
    const consultation = await queuedConsultation('en');
    await offerNextDoctor(consultation.id);

    // 30 seconds in — well inside 90.
    const swept = await enforceResponseWindow(
      getPrisma(),
      fixedClock(new Date(Date.now() + 30_000)),
    );

    expect(swept.missed).toBe(0);
  });
});

describe('accepting an offer', () => {
  it('lets the offered doctor accept, and moves to DOCTOR_ACCEPTED', async () => {
    const doctor = await createEligibleDoctor({ name: 'Dr. Ready', languageCodes: ['en'] });
    const consultation = await queuedConsultation('en');
    await offerNextDoctor(consultation.id);

    const cookies = await signIn(doctor.email, doctor.password);
    const response = await request(`/doctor/consultations/${consultation.publicId}/accept`, {
      method: 'POST',
      cookies,
    });

    expect(response.status).toBe(200);

    const fresh = await getPrisma().consultation.findUniqueOrThrow({
      where: { id: consultation.id },
    });
    expect(fresh.state).toBe('DOCTOR_ACCEPTED');

    // Their capacity is consumed, so they are not offered a second case.
    const presence = await getPrisma().doctorPresence.findUniqueOrThrow({
      where: { doctorId: doctor.doctorId },
    });
    expect(presence.currentLoad).toBe(1);
  });

  it('refuses acceptance from a doctor who was not offered it', async () => {
    await createEligibleDoctor({ name: 'Dr. Offered', languageCodes: ['en'] });
    const other = await createEligibleDoctor({ name: 'Dr. Uninvolved', languageCodes: ['en'] });
    const consultation = await queuedConsultation('en');
    await offerNextDoctor(consultation.id);

    const cookies = await signIn(other.email, other.password);
    const response = await request(`/doctor/consultations/${consultation.publicId}/accept`, {
      method: 'POST',
      cookies,
    });

    expect(response.status).toBe(404);
  });

  it('refuses acceptance after the window has lapsed', async () => {
    const doctor = await createEligibleDoctor({ name: 'Dr. Late', languageCodes: ['en'] });
    const consultation = await queuedConsultation('en');
    await offerNextDoctor(consultation.id);

    await getPrisma().consultationAssignment.updateMany({
      data: { respondByAt: new Date(Date.now() - 1000) },
    });

    const cookies = await signIn(doctor.email, doctor.password);
    const response = await request(`/doctor/consultations/${consultation.publicId}/accept`, {
      method: 'POST',
      cookies,
    });

    expect(response.status).toBe(409);
  });

  it('offers no way to decline (spec §30)', async () => {
    const doctor = await createEligibleDoctor({ name: 'Dr. Reluctant', languageCodes: ['en'] });
    const consultation = await queuedConsultation('en');
    await offerNextDoctor(consultation.id);

    const cookies = await signIn(doctor.email, doctor.password);

    // Doctors cannot reject an assigned consultation. No such route exists.
    for (const path of [
      `/doctor/consultations/${consultation.publicId}/decline`,
      `/doctor/consultations/${consultation.publicId}/reject`,
    ]) {
      const response = await request(path, { method: 'POST', cookies });
      expect(response.status, path).toBe(404);
    }
  });
});

describe('what the doctor is shown', () => {
  it('shows the offer with a countdown, but never a score or rating', async () => {
    const doctor = await createEligibleDoctor({ name: 'Dr. Ready', languageCodes: ['en'] });
    const consultation = await queuedConsultation('en');
    await offerNextDoctor(consultation.id);

    const cookies = await signIn(doctor.email, doctor.password);
    const response = await request<{
      offer: { secondsRemaining: number; consultationPublicId: string };
      windowSeconds: number;
    }>('/doctor/queue', { cookies });

    expect(response.body.data?.windowSeconds).toBe(90);
    expect(response.body.data?.offer?.secondsRemaining).toBeGreaterThan(0);

    // Spec §24 and §52 — no ratings, no quality score, no routing internals.
    const serialised = JSON.stringify(response.body.data);
    expect(serialised).not.toMatch(/score|rating|breakdown|quality/i);
  });

  it('tells a doctor plainly why they are not receiving consultations', async () => {
    const doctor = await createEligibleDoctor({ name: 'Dr. Idle', languageCodes: ['en'] });
    await getPrisma().doctorShiftAssignment.deleteMany({ where: { doctorId: doctor.doctorId } });

    const cookies = await signIn(doctor.email, doctor.password);
    const response = await request<{ blockedBy: string | null }>('/doctor/presence', { cookies });

    expect(response.body.data?.blockedBy).toMatch(/no confirmed shift/i);
  });
});

/**
 * Capacity accounting (spec §30).
 *
 * A doctor takes one consultation at a time. Acceptance increments their load;
 * nothing released it until this was fixed, so every doctor silently stopped
 * receiving work after their first consultation and the queue stalled with no
 * error anywhere.
 */
describe('doctor capacity', () => {
  it('is taken on acceptance and returned when the consultation ends', async () => {
    const doctor = await createEligibleDoctor({ name: 'Dr. Load', languageCodes: ['en'] });
    const first = await queuedConsultation('en');

    await offerNextDoctor(first.id);
    await acceptOffer(first.publicId, doctor.doctorId);

    const busy = await getPrisma().doctorPresence.findUniqueOrThrow({
      where: { doctorId: doctor.doctorId },
    });
    expect(busy.currentLoad).toBe(1);

    // A doctor at capacity is not offered a second consultation.
    const second = await queuedConsultation('en');
    const blocked = await offerNextDoctor(second.id);
    expect(blocked.offered).toBe(false);

    await transition(first.id, 'ABANDONED', { actorType: 'ADMIN', reason: 'test' });

    const free = await getPrisma().doctorPresence.findUniqueOrThrow({
      where: { doctorId: doctor.doctorId },
    });
    expect(free.currentLoad).toBe(0);

    // And the queue starts routing to them again.
    const resumed = await offerNextDoctor(second.id);
    expect(resumed.offered).toBe(true);
    expect(resumed.doctorId).toBe(doctor.doctorId);
  });

  it('never drops below zero, however many terminal transitions arrive', async () => {
    const doctor = await createEligibleDoctor({ name: 'Dr. Zero', languageCodes: ['en'] });
    const consultation = await queuedConsultation('en');

    await offerNextDoctor(consultation.id);
    await acceptOffer(consultation.publicId, doctor.doctorId);

    await transition(consultation.id, 'ABANDONED', { actorType: 'ADMIN', reason: 'test' });

    // A second attempt is refused by the state machine — ABANDONED is terminal
    // — so no second release happens; the SQL floors at zero regardless.
    await expect(
      transition(consultation.id, 'ABANDONED', { actorType: 'ADMIN', reason: 'again' }),
    ).rejects.toThrow();

    const presence = await getPrisma().doctorPresence.findUniqueOrThrow({
      where: { doctorId: doctor.doctorId },
    });
    expect(presence.currentLoad).toBe(0);
  });
});
