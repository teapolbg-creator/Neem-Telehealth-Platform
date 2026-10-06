import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getPrisma, disconnectPrisma } from '../../src/db/prisma.ts';
import { closeTestApp, request } from '../helpers/app.ts';
import {
  createTestDoctor,
  resetDatabase,
  setDirectChannelEnabled,
  setDoctorOnDutyRequired,
} from '../helpers/database.ts';
import {
  MockNotificationProvider,
  resetNotificationProviders,
  setNotificationProviderForTesting,
} from '../../src/adapters/notification/index.ts';
import {
  setPaymentProviderForTesting,
  type InitializePaymentInput,
  type InitializePaymentResult,
  type PaymentProvider,
  type RefundResult,
  type VerifiedPayment,
  type VerifiedPaymentStatus,
  type WebhookEvent,
} from '../../src/adapters/payment/index.ts';
import { verifyAndSettle } from '../../src/modules/payment/payment.service.ts';
import {
  expireRecoveryWindows,
  expireUnservedConsultations,
  interruptStaleConsultations,
  professionalEverConnected,
  recordUnservedDeadline,
} from '../../src/modules/consultation/unserved.service.ts';
import { transition } from '../../src/modules/consultation/consultation.service.ts';
import {
  getTimer,
  interruptConsultation,
  joinMediaSession,
} from '../../src/modules/media/media.service.ts';
import { PRIVACY_NOTICE_VERSION } from '@neem/contracts';

/**
 * Nothing paid for stays open for ever (D61).
 *
 * The incident these come from: a patient paid, reached a video room nobody
 * else ever entered, and a week later still had a "Rejoin the consultation"
 * button and a timer reading "+9949:55 over". Three faults behind it, each with
 * its own cases below — no job could end a consultation once it left the queue,
 * a patient's own rejoin counted as the consultation resuming, and the timer
 * counted from a start that was rewritten every time it did.
 */

const PATIENT = 'ama@lifetime.test';
const email = new MockNotificationProvider('EMAIL');

class ScriptedProvider implements PaymentProvider {
  readonly name = 'scripted';
  readonly isMock = true;
  status: VerifiedPaymentStatus = 'PENDING';
  private amountMinor = 0;

  async initialize(input: InitializePaymentInput): Promise<InitializePaymentResult> {
    this.amountMinor = input.amountMinor;
    return { providerReference: `scripted_${input.reference}`, authorizationUrl: 'https://x.test' };
  }

  async verify(providerReference: string): Promise<VerifiedPayment> {
    return {
      providerReference,
      status: this.status,
      amountMinor: this.amountMinor,
      currency: 'GHS',
      channel: 'mobile_money',
      paidAt: this.status === 'SUCCESS' ? new Date() : undefined,
    };
  }

  parseWebhook(): WebhookEvent {
    throw new Error('not used');
  }

  async refund(): Promise<RefundResult> {
    throw new Error('not used');
  }
}

let provider: ScriptedProvider;

beforeEach(async () => {
  await resetDatabase();
  await setDirectChannelEnabled(true);
  await setDoctorOnDutyRequired(true);

  provider = new ScriptedProvider();
  setPaymentProviderForTesting(provider);

  resetNotificationProviders();
  email.clear();
  setNotificationProviderForTesting('EMAIL', email);
});

afterAll(async () => {
  setPaymentProviderForTesting(undefined);
  resetNotificationProviders();
  await closeTestApp();
  await disconnectPrisma();
});

/** A doctor on a confirmed shift, so a booking is allowed to exist. */
async function doctorOnDuty() {
  const prisma = getPrisma();
  const { doctor } = await createTestDoctor('Dr. Lifetime');

  const now = new Date();
  const hour = now.getUTCHours();
  const code = hour >= 8 && hour < 14 ? 'MORNING' : hour >= 14 && hour < 20 ? 'AFTERNOON' : 'NIGHT';
  const shift = await prisma.shiftDefinition.findUniqueOrThrow({ where: { code } });

  await prisma.doctorShiftAssignment.create({
    data: {
      doctorId: doctor.id,
      shiftDefinitionId: shift.id,
      serviceDate: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())),
      status: 'CONFIRMED',
      confirmedAt: now,
      minutesPlanned: 360,
    },
  });

  return doctor;
}

async function signedInPatient(contact = PATIENT): Promise<Record<string, string>> {
  await request('/patient/account/code', { method: 'POST', payload: { contact } });
  const body = email
    .sent()
    .filter((sent) => sent.to === contact)
    .at(-1)?.body;
  const code = /\b(\d{6})\b/.exec(body ?? '')?.[1];

  const verified = await request('/patient/account/verify', {
    method: 'POST',
    payload: { contact, code },
  });
  return verified.cookies;
}

const BOOKING = {
  serviceCode: 'GENERAL_CONSULTATION',
  languageCode: 'en',
  type: 'VIDEO' as const,
  fullName: 'Ama Mensah',
  age: 31,
  sex: 'FEMALE' as const,
  phone: '0244000111',
  address: 'Dansoman, Accra',
  reason: 'Persistent cough',
  acceptsRemoteConsultation: true as const,
  readEmergencyGuidance: true as const,
  acceptsDataProcessing: true as const,
  privacyNoticeVersion: PRIVACY_NOTICE_VERSION,
};

/** A booked, paid, queued consultation driven through the real routes. */
async function paidConsultation() {
  await doctorOnDuty();
  const cookies = await signedInPatient();

  const booked = await request<{ consultationReference: string }>('/patient/bookings/immediate', {
    method: 'POST',
    cookies,
    payload: BOOKING,
  });
  const reference = booked.body.data!.consultationReference;

  await request(`/patient/bookings/${reference}/payment`, { method: 'POST', cookies });
  provider.status = 'SUCCESS';

  const payment = await getPrisma().payment.findFirstOrThrow({
    where: { consultation: { publicId: reference } },
  });
  await verifyAndSettle(payment.providerReference, { actorType: 'SYSTEM' });

  const consultation = await getPrisma().consultation.findUniqueOrThrow({
    where: { publicId: reference },
  });

  return { reference, consultation, cookies };
}

/** Moves a deadline into the past without touching anything else. */
async function overdue(consultationId: string, field: 'unservedDeadlineAt' | 'rejoinableUntil') {
  await getPrisma().consultation.update({
    where: { id: consultationId },
    data: { [field]: new Date(Date.now() - 60_000) },
  });
}

describe('a paid consultation gets a deadline', () => {
  it('records one when the payment is verified, and reaches the queue', async () => {
    const { consultation } = await paidConsultation();

    expect(consultation.unservedDeadlineAt).not.toBeNull();
    expect(consultation.state).toBe('WAITING_FOR_DOCTOR');

    // Roughly a day away, which is the configured maximum.
    const hours = (consultation.unservedDeadlineAt!.getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23);
    expect(hours).toBeLessThan(25);
  });

  it('does not move the deadline when the payment is confirmed again', async () => {
    const { consultation } = await paidConsultation();
    const first = consultation.unservedDeadlineAt!;

    // A webhook arriving late, a verification re-running, a settlement replayed
    // after downtime: none of them may buy the consultation another day.
    await recordUnservedDeadline(consultation.id);
    await recordUnservedDeadline(consultation.id);

    const after = await getPrisma().consultation.findUniqueOrThrow({
      where: { id: consultation.id },
    });
    expect(after.unservedDeadlineAt!.getTime()).toBe(first.getTime());
  });

  it('gives a scheduled appointment a deadline after its own start, not after payment', async () => {
    const { consultation } = await paidConsultation();

    // The same consultation, but scheduled for next week.
    const startsAt = new Date(Date.now() + 7 * 86_400_000);
    const doctor = await getPrisma().doctor.findFirstOrThrow();
    await getPrisma().appointment.create({
      data: {
        publicId: 'apt_lifetime_1',
        consultationId: consultation.id,
        doctorId: doctor.id,
        serviceId: consultation.serviceId!,
        patientAccountId: consultation.patientAccountId!,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 900_000),
        state: 'CONFIRMED',
      },
    });

    await getPrisma().consultation.update({
      where: { id: consultation.id },
      data: { unservedDeadlineAt: null },
    });
    const deadline = await recordUnservedDeadline(consultation.id);

    // A booking days ahead is not unserved; it has not happened yet.
    expect(deadline!.getTime()).toBeGreaterThan(startsAt.getTime());
    const sweep = await expireUnservedConsultations();
    expect(sweep.expired + sweep.needingReview).toBe(0);
  });
});

describe('expiry at the deadline', () => {
  it('expires a consultation no professional ever attended, and asks for the money back', async () => {
    const { consultation } = await paidConsultation();
    await overdue(consultation.id, 'unservedDeadlineAt');

    const result = await expireUnservedConsultations();
    expect(result.expired).toBe(1);
    expect(result.needingReview).toBe(0);

    const after = await getPrisma().consultation.findUniqueOrThrow({
      where: { id: consultation.id },
    });
    // EXPIRED, and still expired: the refund does not overwrite it.
    expect(after.state).toBe('EXPIRED');

    const refund = await getPrisma().refund.findFirstOrThrow({
      where: { consultationId: consultation.id },
    });
    expect(refund.state).toBe('REQUESTED');
    expect(refund.reason).toMatch(/No professional attended/i);
  });

  it('is safe to run twice, and raises one refund', async () => {
    const { consultation } = await paidConsultation();
    await overdue(consultation.id, 'unservedDeadlineAt');

    await expireUnservedConsultations();
    const second = await expireUnservedConsultations();

    expect(second.expired).toBe(0);
    expect(await getPrisma().refund.count({ where: { consultationId: consultation.id } })).toBe(1);
  });

  it('catches up after downtime rather than missing what passed while it was down', async () => {
    const { consultation } = await paidConsultation();

    // A deadline that passed three days ago, as if nothing had run since.
    await getPrisma().consultation.update({
      where: { id: consultation.id },
      data: { unservedDeadlineAt: new Date(Date.now() - 3 * 86_400_000) },
    });

    const result = await expireUnservedConsultations();
    expect(result.expired).toBe(1);
  });

  it('loses the race to a doctor who accepts first', async () => {
    const { consultation } = await paidConsultation();
    await overdue(consultation.id, 'unservedDeadlineAt');

    // The doctor gets there between the sweep's query and its decision.
    const doctor = await getPrisma().doctor.findFirstOrThrow();
    await getPrisma().consultation.update({
      where: { id: consultation.id },
      data: { doctorId: doctor.id },
    });
    await transition(consultation.id, 'ASSIGNED', { actorType: 'SYSTEM', reason: 'test' });
    await transition(consultation.id, 'DOCTOR_ACCEPTED', { actorType: 'DOCTOR', reason: 'test' });
    await transition(consultation.id, 'IN_PROGRESS', { actorType: 'DOCTOR', reason: 'test' });
    await transition(consultation.id, 'COMPLETING', { actorType: 'DOCTOR', reason: 'test' });
    await transition(consultation.id, 'COMPLETED', { actorType: 'DOCTOR', reason: 'test' });

    const result = await expireUnservedConsultations();

    expect(result.expired).toBe(0);
    const after = await getPrisma().consultation.findUniqueOrThrow({
      where: { id: consultation.id },
    });
    // Completed care is never expired out from under the patient.
    expect(after.state).toBe('COMPLETED');
    expect(await getPrisma().refund.count({ where: { consultationId: consultation.id } })).toBe(0);
  });

  it('sends a consultation a professional attended for review, not an automatic refund', async () => {
    const { consultation } = await paidConsultation();
    const doctor = await getPrisma().doctor.findFirstOrThrow();

    await getPrisma().consultation.update({
      where: { id: consultation.id },
      data: { doctorId: doctor.id },
    });
    await transition(consultation.id, 'ASSIGNED', { actorType: 'SYSTEM', reason: 'test' });
    await transition(consultation.id, 'DOCTOR_ACCEPTED', { actorType: 'DOCTOR', reason: 'test' });
    await transition(consultation.id, 'IN_PROGRESS', { actorType: 'DOCTOR', reason: 'test' });

    /*
     * Evidence that somebody was in the room, and that it was a long time ago.
     *
     * The timestamp matters: a consultation a doctor joined moments ago is
     * live, and expiry leaves those alone on purpose. This one is the case the
     * test is about — attended, then abandoned, and never finished.
     */
    const longAgo = new Date(Date.now() - 6 * 3_600_000);
    await getPrisma().callAttendanceEvent.create({
      data: {
        consultationId: consultation.id,
        participant: 'DOCTOR',
        event: 'JOINED',
        source: 'CLIENT',
        occurredAt: longAgo,
      },
    });
    await getPrisma().consultation.update({
      where: { id: consultation.id },
      data: { startedAt: longAgo, firstStartedAt: longAgo },
    });

    await overdue(consultation.id, 'unservedDeadlineAt');
    const result = await expireUnservedConsultations();

    expect(result.needingReview).toBe(1);
    expect(result.expired).toBe(0);

    const after = await getPrisma().consultation.findUniqueOrThrow({
      where: { id: consultation.id },
    });
    // ABANDONED, not EXPIRED: somebody attended, and the word an administrator
    // reads should say so.
    expect(after.state).toBe('ABANDONED');

    const refund = await getPrisma().refund.findFirstOrThrow({
      where: { consultationId: consultation.id },
    });
    expect(refund.state).toBe('REQUESTED');
    expect(refund.reason).toMatch(/review what was delivered/i);
  });
});

describe('the recovery window', () => {
  /** An interrupted consultation with a doctor who had joined the room. */
  async function interrupted() {
    const { consultation } = await paidConsultation();
    const doctor = await getPrisma().doctor.findFirstOrThrow();

    await getPrisma().consultation.update({
      where: { id: consultation.id },
      data: { doctorId: doctor.id },
    });
    await transition(consultation.id, 'ASSIGNED', { actorType: 'SYSTEM', reason: 'test' });
    await transition(consultation.id, 'DOCTOR_ACCEPTED', { actorType: 'DOCTOR', reason: 'test' });
    await transition(consultation.id, 'IN_PROGRESS', { actorType: 'DOCTOR', reason: 'test' });
    await getPrisma().callAttendanceEvent.create({
      data: {
        consultationId: consultation.id,
        participant: 'DOCTOR',
        event: 'JOINED',
        source: 'CLIENT',
      },
    });

    await interruptConsultation(consultation.id, { type: 'DOCTOR', id: doctor.id });
    return { consultationId: consultation.id, doctorId: doctor.id };
  }

  it('is fifteen minutes from the moment the call broke', async () => {
    const { consultationId } = await interrupted();

    const after = await getPrisma().consultation.findUniqueOrThrow({
      where: { id: consultationId },
    });
    const minutes = (after.rejoinableUntil!.getTime() - after.interruptedAt!.getTime()) / 60_000;
    expect(minutes).toBeCloseTo(15, 1);
  });

  it('is not extended by a second interruption', async () => {
    const { consultationId, doctorId } = await interrupted();
    const first = await getPrisma().consultation.findUniqueOrThrow({
      where: { id: consultationId },
    });

    // Resumed by the professional, then broken again.
    await transition(consultationId, 'IN_PROGRESS', { actorType: 'DOCTOR', reason: 'resumed' });
    await interruptConsultation(consultationId, { type: 'DOCTOR', id: doctorId });

    const second = await getPrisma().consultation.findUniqueOrThrow({
      where: { id: consultationId },
    });
    // The window belongs to the first break. Otherwise a patient could hold a
    // consultation open indefinitely by rejoining and dropping out.
    expect(second.rejoinableUntil!.getTime()).toBe(first.rejoinableUntil!.getTime());
    expect(second.interruptedAt!.getTime()).toBe(first.interruptedAt!.getTime());
  });

  it('survives the professional resuming: the deadline is not cleared', async () => {
    const { consultationId } = await interrupted();
    const before = await getPrisma().consultation.findUniqueOrThrow({
      where: { id: consultationId },
    });

    await transition(consultationId, 'IN_PROGRESS', { actorType: 'DOCTOR', reason: 'resumed' });

    const after = await getPrisma().consultation.findUniqueOrThrow({
      where: { id: consultationId },
    });
    /*
     * Clearing this was how one rejoin removed the only bound on the
     * consultation's life: it went back to IN_PROGRESS with no deadline and no
     * sweep could ever see it again.
     */
    expect(after.rejoinableUntil?.getTime()).toBe(before.rejoinableUntil?.getTime());
  });

  it('ends an interrupted consultation nobody came back to', async () => {
    const { consultationId } = await interrupted();
    await overdue(consultationId, 'rejoinableUntil');

    expect(await expireRecoveryWindows()).toBe(1);

    const after = await getPrisma().consultation.findUniqueOrThrow({
      where: { id: consultationId },
    });
    expect(after.state).toBe('ABANDONED');

    const refund = await getPrisma().refund.findFirstOrThrow({
      where: { consultationId },
    });
    expect(refund.state).toBe('REQUESTED');
  });

  it('leaves one inside its window alone', async () => {
    const { consultationId } = await interrupted();

    expect(await expireRecoveryWindows()).toBe(0);
    const after = await getPrisma().consultation.findUniqueOrThrow({
      where: { id: consultationId },
    });
    expect(after.state).toBe('INTERRUPTED');
  });
});

describe('the consultation clock', () => {
  it('counts from the first start, not from a resume', async () => {
    const { consultation } = await paidConsultation();
    const doctor = await getPrisma().doctor.findFirstOrThrow();
    await getPrisma().consultation.update({
      where: { id: consultation.id },
      data: { doctorId: doctor.id },
    });

    await transition(consultation.id, 'ASSIGNED', { actorType: 'SYSTEM', reason: 'test' });
    await transition(consultation.id, 'DOCTOR_ACCEPTED', { actorType: 'DOCTOR', reason: 'test' });
    await transition(consultation.id, 'IN_PROGRESS', { actorType: 'DOCTOR', reason: 'test' });

    // Four minutes in, the call breaks.
    const fourMinutesAgo = new Date(Date.now() - 4 * 60_000);
    await getPrisma().consultation.update({
      where: { id: consultation.id },
      data: { firstStartedAt: fourMinutesAgo, startedAt: fourMinutesAgo },
    });

    await interruptConsultation(consultation.id, { type: 'DOCTOR', id: doctor.id });
    await transition(consultation.id, 'IN_PROGRESS', { actorType: 'DOCTOR', reason: 'resumed' });

    const timer = await getTimer(consultation.id);

    // It resumes at four minutes, not at zero. `startedAt` was rewritten by the
    // resume; `firstStartedAt` was not.
    expect(timer!.elapsedSeconds).toBeGreaterThanOrEqual(240);
    const fresh = await getPrisma().consultation.findUniqueOrThrow({
      where: { id: consultation.id },
    });
    expect(fresh.firstStartedAt!.getTime()).toBe(fourMinutesAgo.getTime());
    expect(fresh.startedAt!.getTime()).toBeGreaterThan(fourMinutesAgo.getTime());
  });

  it('stops counting while the consultation is interrupted', async () => {
    const { consultation } = await paidConsultation();
    const doctor = await getPrisma().doctor.findFirstOrThrow();
    await getPrisma().consultation.update({
      where: { id: consultation.id },
      data: { doctorId: doctor.id },
    });
    await transition(consultation.id, 'ASSIGNED', { actorType: 'SYSTEM', reason: 'test' });
    await transition(consultation.id, 'DOCTOR_ACCEPTED', { actorType: 'DOCTOR', reason: 'test' });
    await transition(consultation.id, 'IN_PROGRESS', { actorType: 'DOCTOR', reason: 'test' });

    const longAgo = new Date(Date.now() - 6 * 86_400_000);
    await getPrisma().consultation.update({
      where: { id: consultation.id },
      data: { firstStartedAt: longAgo, startedAt: longAgo },
    });
    await interruptConsultation(consultation.id, { type: 'DOCTOR', id: doctor.id });

    // Frozen at the interruption. A timer that kept running here is what
    // produced "+9949:55 over" on a call that stopped days earlier.
    const timer = await getTimer(consultation.id);
    const elapsedDays = timer!.elapsedSeconds / 86_400;
    expect(elapsedDays).toBeCloseTo(6, 0);

    const again = await getTimer(consultation.id);
    expect(again!.elapsedSeconds).toBe(timer!.elapsedSeconds);
  });
});

describe('a consultation nobody is in any more', () => {
  /** A consultation a doctor joined and then stopped attending. */
  async function live() {
    const { consultation } = await paidConsultation();
    const doctor = await getPrisma().doctor.findFirstOrThrow();
    await getPrisma().consultation.update({
      where: { id: consultation.id },
      data: { doctorId: doctor.id },
    });
    await transition(consultation.id, 'ASSIGNED', { actorType: 'SYSTEM', reason: 'test' });
    await transition(consultation.id, 'DOCTOR_ACCEPTED', { actorType: 'DOCTOR', reason: 'test' });
    await transition(consultation.id, 'IN_PROGRESS', { actorType: 'DOCTOR', reason: 'test' });
    return { consultationId: consultation.id, doctorId: doctor.id };
  }

  /** Moves the consultation's last activity into the past. */
  async function quietFor(consultationId: string, minutes: number) {
    const when = new Date(Date.now() - minutes * 60_000);
    await getPrisma().consultation.update({
      where: { id: consultationId },
      data: { startedAt: when, firstStartedAt: when },
    });
    await getPrisma().callAttendanceEvent.updateMany({
      where: { consultationId },
      data: { occurredAt: when },
    });
  }

  it('is marked interrupted, not ended, once it has gone quiet', async () => {
    const { consultationId } = await live();
    await quietFor(consultationId, 180);

    expect(await interruptStaleConsultations()).toBe(1);

    const after = await getPrisma().consultation.findUniqueOrThrow({
      where: { id: consultationId },
    });
    /*
     * INTERRUPTED rather than terminal: whoever dropped out gets the recovery
     * window before anything is decided about them or their money.
     */
    expect(after.state).toBe('INTERRUPTED');
    expect(after.rejoinableUntil).not.toBeNull();
    expect(after.interruptedAt).not.toBeNull();
  });

  it('leaves a consultation alone while it is still being attended', async () => {
    const { consultationId } = await live();

    // Started three hours ago, but somebody was in the room a minute ago.
    await quietFor(consultationId, 180);
    await getPrisma().callAttendanceEvent.create({
      data: {
        consultationId,
        participant: 'DOCTOR',
        event: 'JOINED',
        source: 'CLIENT',
        occurredAt: new Date(Date.now() - 60_000),
      },
    });

    expect(await interruptStaleConsultations()).toBe(0);
    const after = await getPrisma().consultation.findUniqueOrThrow({
      where: { id: consultationId },
    });
    expect(after.state).toBe('IN_PROGRESS');
  });

  it('is not kept alive by the patient rejoining on their own', async () => {
    const { consultationId } = await live();
    await quietFor(consultationId, 180);

    /*
     * The shape the production record was actually in: the doctor long gone,
     * and the most recent thing in the consultation being the patient tapping
     * rejoin. Counting that as activity would let a patient hold a dead
     * consultation open indefinitely by returning every couple of hours — and
     * would contradict the premise of all this, that somebody alone in a room
     * is not in a consultation.
     */
    await getPrisma().callAttendanceEvent.create({
      data: {
        consultationId,
        participant: 'PATIENT',
        event: 'JOINED',
        source: 'CLIENT',
        occurredAt: new Date(Date.now() - 60_000),
      },
    });

    expect(await interruptStaleConsultations()).toBe(1);
    const after = await getPrisma().consultation.findUniqueOrThrow({
      where: { id: consultationId },
    });
    expect(after.state).toBe('INTERRUPTED');
  });

  it('is not expired out from under a doctor who is in the room', async () => {
    const { consultationId } = await live();

    // The unserved deadline is measured from payment, so a long-running
    // consultation can reach it while somebody is still in the call.
    await getPrisma().consultation.update({
      where: { id: consultationId },
      data: { unservedDeadlineAt: new Date(Date.now() - 60_000) },
    });
    await getPrisma().callAttendanceEvent.create({
      data: {
        consultationId,
        participant: 'DOCTOR',
        event: 'JOINED',
        source: 'CLIENT',
        occurredAt: new Date(Date.now() - 30_000),
      },
    });

    const result = await expireUnservedConsultations();

    expect(result.expired + result.needingReview).toBe(0);
    const after = await getPrisma().consultation.findUniqueOrThrow({
      where: { id: consultationId },
    });
    expect(after.state).toBe('IN_PROGRESS');
  });

  it('closes the media room when the consultation ends, and blocks a rejoin after', async () => {
    const { consultationId } = await live();

    // A real room, opened the way a real one is.
    await joinMediaSession(consultationId, 'PATIENT');
    expect(await getPrisma().mediaSession.count({ where: { consultationId, endedAt: null } })).toBe(
      1,
    );

    await quietFor(consultationId, 180);
    expect(await interruptStaleConsultations()).toBe(1);
    await overdue(consultationId, 'rejoinableUntil');
    expect(await expireRecoveryWindows()).toBe(1);

    /*
     * The room is torn down, not merely hidden.
     *
     * A Whereby room URL is a bearer credential: whoever holds the address can
     * open it. Leaving one standing on a consultation the record says is over
     * is a way back into it that no screen controls.
     */
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await getPrisma().mediaSession.count({ where: { consultationId, endedAt: null } })).toBe(
      0,
    );

    // And nobody can open a new one.
    await expect(joinMediaSession(consultationId, 'PATIENT')).rejects.toThrow(/cannot be joined/i);

    // Exactly one refund request, for a person to decide.
    expect(await getPrisma().refund.count({ where: { consultationId } })).toBe(1);
  });

  it('refuses a rejoin once the consultation is past its deadline', async () => {
    const { consultationId } = await live();
    await getPrisma().consultation.update({
      where: { id: consultationId },
      data: { unservedDeadlineAt: new Date(Date.now() - 60_000) },
    });

    const roomsBefore = await getPrisma().mediaSession.count({ where: { consultationId } });

    /*
     * The incident exactly: a consultation stuck IN_PROGRESS accepted a rejoin
     * a week later and minted a fresh Whereby room. A room URL is a bearer
     * credential, so the harm is the room existing.
     */
    await expect(joinMediaSession(consultationId, 'PATIENT')).rejects.toThrow(/has closed/i);

    expect(await getPrisma().mediaSession.count({ where: { consultationId } })).toBe(roomsBefore);
  });
});

describe('evidence that care was delivered', () => {
  it('is not inferred from a single timestamp', async () => {
    const { consultation } = await paidConsultation();

    // startedAt set, but nobody ever in the room and nothing written.
    await getPrisma().consultation.update({
      where: { id: consultation.id },
      data: { startedAt: new Date(), firstStartedAt: new Date() },
    });

    expect(await professionalEverConnected(consultation.id)).toBe(false);
  });

  it('recognises a doctor who joined before attendance events existed', async () => {
    const { consultation } = await paidConsultation();
    const doctor = await getPrisma().doctor.findFirstOrThrow();
    await getPrisma().consultation.update({
      where: { id: consultation.id },
      data: { doctorId: doctor.id },
    });
    await transition(consultation.id, 'ASSIGNED', { actorType: 'SYSTEM', reason: 'test' });
    await transition(consultation.id, 'DOCTOR_ACCEPTED', { actorType: 'DOCTOR', reason: 'test' });
    await transition(consultation.id, 'IN_PROGRESS', {
      actorType: 'DOCTOR',
      reason: 'media_session_joined',
    });

    /*
     * The shape of every consultation that ran before D57: a doctor plainly
     * joined, and there is no attendance row anywhere because the table did not
     * exist yet.
     *
     * This is the case that made the reported incident report
     * NO_EVIDENCE_OF_ATTENDANCE for a consultation a doctor had joined four
     * seconds after accepting it. Reading that silence as "nobody came" would
     * have refunded it as wholly undelivered.
     */
    await getPrisma().callAttendanceEvent.deleteMany({
      where: { consultationId: consultation.id },
    });
    expect(
      await getPrisma().callAttendanceEvent.count({ where: { consultationId: consultation.id } }),
    ).toBe(0);

    expect(await professionalEverConnected(consultation.id)).toBe(true);
  });

  it('recognises a doctor who joined after attendance events existed', async () => {
    const { consultation } = await paidConsultation();

    // The modern shape: an attendance row and no DOCTOR-led transition.
    await getPrisma().callAttendanceEvent.create({
      data: {
        consultationId: consultation.id,
        participant: 'DOCTOR',
        event: 'JOINED',
        source: 'WEBHOOK',
      },
    });

    expect(await professionalEverConnected(consultation.id)).toBe(true);
  });

  it('does not count the patient’s own arrival as a professional attending', async () => {
    const { consultation } = await paidConsultation();

    await getPrisma().callAttendanceEvent.create({
      data: {
        consultationId: consultation.id,
        participant: 'PATIENT',
        event: 'JOINED',
        source: 'CLIENT',
      },
    });

    // Being in a room alone is not being seen, and must never read as care.
    expect(await professionalEverConnected(consultation.id)).toBe(false);
  });

  it('counts a document as evidence even with no attendance record', async () => {
    const { consultation } = await paidConsultation();
    const doctor = await getPrisma().doctor.findFirstOrThrow();

    await getPrisma().prescription.create({
      data: {
        publicId: 'rx_lifetime_1',
        verificationCode: 'NEEMLIFETIME1',
        consultationId: consultation.id,
        doctorId: doctor.id,
        state: 'DRAFT',
        patientName: 'Ama Mensah',
        patientAge: 31,
        patientSex: 'FEMALE',
      },
    });

    expect(await professionalEverConnected(consultation.id)).toBe(true);
  });
});
