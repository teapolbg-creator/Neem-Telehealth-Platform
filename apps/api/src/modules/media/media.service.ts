import type { PrismaClient } from '@prisma/client';
import { getPrisma, type Db } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { decryptNullable } from '../../lib/crypto.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
import { getLogger } from '../../lib/logger.ts';
import { getIntSetting } from '../settings/settings.service.ts';
import { SETTING_KEYS } from '../settings/settings.defaults.ts';
import { transition } from '../consultation/consultation.service.ts';
import { emitToConsultation, emitToDoctor } from '../realtime/realtime.service.ts';
import { getVideoProvider, getVoiceProvider } from '../../adapters/media/index.ts';

/**
 * Consultation media sessions (spec §15, §32, §33).
 *
 * Three guarantees this module is responsible for:
 *
 *  1. **Nothing is ever recorded.** The provider interface has no recording
 *     method, `media_sessions.recordingEnabled` defaults false, and this
 *     module never writes anything else to it. A test asserts all three.
 *  2. **The timer never ends a consultation.** It produces warnings and then
 *     counts overrun. Only the doctor completes (spec §15).
 *  3. **Call Me exposes no phone number.** Both numbers are read server-side,
 *     handed to the provider, and never returned to either client (spec §33).
 */

export interface MediaSessionView {
  kind: 'VIDEO' | 'AUDIO' | 'VOICE_BRIDGE';
  providerRoomRef: string | null;
  /** Credential for the provider's SDK. Absent for a bridged voice call. */
  joinToken: string | null;
  /**
   * Where the client connects, for a provider that works by URL.
   *
   * Whereby's credential *is* the room URL — there is no SDK token — so this
   * is what the browser embeds. It is a bearer capability: whoever holds it
   * can join, and the doctor's carries a host key. So it is returned only to
   * the authenticated participant it was minted for, and never logged or
   * audited (spec §60).
   *
   * Null for a token-based provider and for the mock, neither of which needs
   * it.
   */
  joinUrl: string | null;
  tokenExpiresAt: string | null;
  /** True when no real media can flow — surfaced in the UI, never hidden. */
  isMockProvider: boolean;
  startedAt: string;
  endedAt: string | null;
  /** Always false. There is no path that can make it true (spec §32). */
  recordingEnabled: false;
}

/**
 * Starts, or rejoins, the media session for a consultation.
 *
 * Idempotent: a participant who reloads gets a fresh join credential for the
 * same room rather than a second room. A dropped connection mid-consultation
 * must not cost the patient their place.
 */
export async function joinMediaSession(
  consultationId: string,
  participant: 'PATIENT' | 'DOCTOR',
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<MediaSessionView> {
  const consultation = await db.consultation.findUnique({
    where: { id: consultationId },
    include: {
      mediaSessions: { where: { endedAt: null }, orderBy: { startedAt: 'desc' }, take: 1 },
    },
  });
  if (!consultation) throw errors.notFound('Consultation not found.');

  if (consultation.state !== 'DOCTOR_ACCEPTED' && consultation.state !== 'IN_PROGRESS') {
    throw errors.businessRule(`This consultation is ${consultation.state} and cannot be joined.`);
  }
  if (!consultation.type) {
    throw errors.businessRule('No consultation type has been chosen.');
  }

  // Call Me is a telephone bridge, not a room — it has its own path.
  if (consultation.type === 'CALL_ME') {
    throw errors.businessRule(
      'This is a Call Me consultation. The doctor places the call from their dashboard.',
    );
  }

  const durationSeconds = await getIntSetting(SETTING_KEYS.CONSULTATION_DURATION_SECONDS, db);
  // Generous relative to the 5-minute target: the room must outlive an
  // overrunning consultation, because the timer must never end one (spec §15).
  const roomLifetimeSeconds = durationSeconds * 6;

  const provider = getVideoProvider();
  let session = consultation.mediaSessions[0];

  if (!session) {
    const room = await provider.createRoom({
      consultationPublicId: consultation.publicId,
      kind: consultation.type === 'VIDEO' ? 'VIDEO' : 'AUDIO',
      maxDurationSeconds: roomLifetimeSeconds,
    });

    session = await db.mediaSession.create({
      data: {
        consultationId: consultation.id,
        provider: provider.name,
        kind: consultation.type === 'VIDEO' ? 'VIDEO' : 'AUDIO',
        providerRoomRef: room.providerRoomRef,
        startedAt: clock.now(),
        // Never set from a parameter. There is no code path that sets it true.
        recordingEnabled: false,
      },
    });
  }

  const token = await provider.issueJoinToken({
    providerRoomRef: session.providerRoomRef!,
    participant,
    // A generic label. The doctor learns who the patient is from the clinical
    // record, not from a video tile — and the patient never sees an identifier
    // for the doctor beyond their professional name.
    displayName: participant === 'PATIENT' ? 'Patient' : 'Doctor',
    ttlSeconds: roomLifetimeSeconds,
  });

  // The doctor arriving is what starts the clinical interaction.
  if (participant === 'DOCTOR' && consultation.state === 'DOCTOR_ACCEPTED') {
    await transition(
      consultation.id,
      'IN_PROGRESS',
      { actorType: 'DOCTOR', reason: 'media_session_joined' },
      db,
      clock,
    );
    emitToConsultation(consultation.publicId, 'consultation.state_changed', {
      state: 'IN_PROGRESS',
    });
  }

  emitToConsultation(consultation.publicId, 'consultation.participant_joined', { participant });

  return {
    kind: session.kind,
    providerRoomRef: session.providerRoomRef,
    joinToken: token.token,
    joinUrl: token.endpoint ?? null,
    tokenExpiresAt: token.expiresAt.toISOString(),
    isMockProvider: provider.isMock,
    startedAt: session.startedAt.toISOString(),
    endedAt: null,
    recordingEnabled: false,
  };
}

/** A participant leaving. Does not end the consultation — only the doctor does. */
export async function leaveMediaSession(
  consultationId: string,
  participant: 'PATIENT' | 'DOCTOR',
  db: Db = getPrisma(),
): Promise<void> {
  const consultation = await db.consultation.findUnique({
    where: { id: consultationId },
    select: { publicId: true },
  });
  if (!consultation) return;

  emitToConsultation(consultation.publicId, 'consultation.participant_left', { participant });
}

/**
 * Tears down the media session.
 *
 * Called from the completion transaction in Phase 6. Failure to reach the
 * provider is logged but does not block completion: the clinical record and
 * the purge matter more than a room that will expire on its own.
 */
export async function endMediaSession(
  consultationId: string,
  reason: string,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<void> {
  const sessions = await db.mediaSession.findMany({
    where: { consultationId, endedAt: null },
  });

  for (const session of sessions) {
    try {
      if (session.kind === 'VOICE_BRIDGE' && session.providerCallRef) {
        await getVoiceProvider().endCall(session.providerCallRef);
      } else if (session.providerRoomRef) {
        await getVideoProvider().endRoom(session.providerRoomRef);
      }
    } catch (error) {
      getLogger().warn(
        { err: error, sessionId: session.id },
        'could not tear down the media session with the provider',
      );
    }

    await db.mediaSession.update({
      where: { id: session.id },
      data: { endedAt: clock.now(), endReason: reason.slice(0, 120) },
    });
  }
}

export interface CallMeResult {
  providerCallRef: string;
  status: string;
  /** What the patient's handset will display — never the doctor's number. */
  callerIdShown: string;
  isMockProvider: boolean;
}

/**
 * How many Call Me bridges are live right now.
 *
 * Counted from our own records rather than asked of the provider: the answer
 * is needed on the path that is about to dial, a provider round-trip there is
 * latency at a pharmacy counter, and a provider that is briefly unreachable
 * must not read as "no calls in progress" and let us exceed the subscription.
 *
 * A session with no `endedAt` is live. `endMediaSession` is what closes them,
 * on completion, cancellation and expiry alike, so this cannot drift as long
 * as that stays the single exit.
 */
export async function liveBridgedCallCount(db: Db = getPrisma()): Promise<number> {
  return db.mediaSession.count({ where: { kind: 'VOICE_BRIDGE', endedAt: null } });
}

/**
 * Refuses a call the subscription cannot carry.
 *
 * The pilot's first month buys **one** simultaneous call. Dialling a second
 * would fail somewhere inside the provider, at a counter, with a patient
 * waiting — and the doctor would see whatever the provider chose to say. This
 * turns that into a refusal Neem controls and a pharmacy can act on.
 *
 * `excludeConsultationId` is what makes retrying safe: a consultation that
 * already holds a live session is not competing for capacity with itself, so a
 * doctor pressing the button twice gets the existing call rather than a
 * capacity error.
 */
async function assertCallCapacity(
  excludeConsultationId: string,
  db: Db = getPrisma(),
): Promise<void> {
  const limit = await getIntSetting(SETTING_KEYS.MEDIA_MAX_CONCURRENT_CALLS, db);

  const inFlight = await db.mediaSession.count({
    where: {
      kind: 'VOICE_BRIDGE',
      endedAt: null,
      consultationId: { not: excludeConsultationId },
    },
  });

  if (inFlight >= limit) {
    throw errors.businessRule(
      limit === 1
        ? 'Another Call Me consultation is on the line right now, and the current plan allows one at a time. Try again in a few minutes, or switch this consultation to audio or video.'
        : `All ${limit} Call Me lines are in use right now. Try again in a few minutes, or switch this consultation to audio or video.`,
    );
  }
}

/**
 * Places the Call Me bridge (spec §33).
 *
 * Both numbers are read here and passed straight to the provider. Neither is
 * returned to either client, and the patient's number is not persisted beyond
 * the consultation — it lives in the temporary session and is deleted with it.
 */
export async function placeCallMe(
  consultationId: string,
  doctorId: string,
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<CallMeResult> {
  const consultation = await db.consultation.findUnique({
    where: { id: consultationId },
    include: {
      patientSession: true,
      doctor: { select: { id: true, phoneEnc: true } },
      mediaSessions: { where: { endedAt: null }, take: 1 },
    },
  });
  if (!consultation) throw errors.notFound('Consultation not found.');

  if (consultation.doctorId !== doctorId) throw errors.notFound('Consultation not found.');
  if (consultation.type !== 'CALL_ME') {
    throw errors.businessRule('This consultation is not a Call Me consultation.');
  }
  if (consultation.state !== 'DOCTOR_ACCEPTED' && consultation.state !== 'IN_PROGRESS') {
    throw errors.businessRule(`This consultation is ${consultation.state}.`);
  }

  const patientPhone = decryptNullable(consultation.patientSession?.phoneEnc ?? null);
  if (!patientPhone) {
    throw errors.businessRule('No phone number is on file for this patient.');
  }

  // The doctor's own number, held encrypted on their account. It is decrypted
  // here, handed to the provider, and never disclosed to the patient.
  const doctorPhone = decryptNullable(consultation.doctor?.phoneEnc ?? null);
  if (!doctorPhone) {
    throw errors.businessRule(
      'No contact number is on file for this doctor, so the call cannot be bridged.',
    );
  }

  // Before anything is dialled. Checking after would burn a call leg we are
  // not entitled to and still have to refuse.
  await assertCallCapacity(consultation.id, db);

  const durationSeconds = await getIntSetting(SETTING_KEYS.CONSULTATION_DURATION_SECONDS, db);
  const provider = getVoiceProvider();

  const call = await provider.placeBridgedCall({
    consultationPublicId: consultation.publicId,
    patientPhone,
    doctorPhone,
    maxDurationSeconds: durationSeconds * 6,
  });

  const existing = consultation.mediaSessions[0];
  if (!existing) {
    await db.mediaSession.create({
      data: {
        consultationId: consultation.id,
        provider: provider.name,
        kind: 'VOICE_BRIDGE',
        providerCallRef: call.providerCallRef,
        startedAt: clock.now(),
        recordingEnabled: false,
      },
    });
  }

  if (consultation.state === 'DOCTOR_ACCEPTED') {
    await transition(
      consultation.id,
      'IN_PROGRESS',
      { actorType: 'DOCTOR', actorId: doctorId, reason: 'call_me_placed' },
      db,
      clock,
    );
  }

  emitToConsultation(consultation.publicId, 'consultation.call_placed', {
    callerIdShown: call.callerIdShown,
  });

  return {
    providerCallRef: call.providerCallRef,
    status: call.status,
    callerIdShown: call.callerIdShown,
    isMockProvider: provider.isMock,
  };
}

export interface ConsultationTimer {
  /** Seconds since the clinical interaction began. */
  elapsedSeconds: number;
  /** The configured target length (spec §15 default: 300). */
  durationSeconds: number;
  /** Seconds left; zero once the target is passed. */
  remainingSeconds: number;
  /** True inside the warning threshold. */
  warning: boolean;
  /** True once past the target. The consultation continues regardless. */
  overrun: boolean;
  overrunSeconds: number;
}

/**
 * The consultation timer (spec §15).
 *
 * Reports elapsed time and warnings. It has **no** power to end anything:
 * there is no transition here, no scheduled job that completes a consultation
 * on time, and no client action gated on `overrun`. The doctor decides when
 * the clinical interaction is finished.
 */
export async function getTimer(
  consultationId: string,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<ConsultationTimer | null> {
  const consultation = await db.consultation.findUnique({
    where: { id: consultationId },
    select: { startedAt: true },
  });
  if (!consultation?.startedAt) return null;

  const [durationSeconds, warningSeconds] = await Promise.all([
    getIntSetting(SETTING_KEYS.CONSULTATION_DURATION_SECONDS, db),
    getIntSetting(SETTING_KEYS.CONSULTATION_WARNING_SECONDS, db),
  ]);

  const elapsedSeconds = Math.max(
    0,
    Math.floor((clock.now().getTime() - consultation.startedAt.getTime()) / 1000),
  );
  const remainingSeconds = Math.max(0, durationSeconds - elapsedSeconds);
  const overrunSeconds = Math.max(0, elapsedSeconds - durationSeconds);

  return {
    elapsedSeconds,
    durationSeconds,
    remainingSeconds,
    warning: remainingSeconds > 0 && remainingSeconds <= warningSeconds,
    overrun: overrunSeconds > 0,
    overrunSeconds,
  };
}

/**
 * Notifies participants as the target time approaches.
 *
 * Emits a warning and, later, an overrun notice. Neither ends anything — the
 * events exist so the doctor can manage their time, not so the system can
 * manage it for them.
 */
export async function emitTimerWarnings(
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<number> {
  const live = await db.consultation.findMany({
    where: { state: 'IN_PROGRESS', startedAt: { not: null } },
    select: { id: true, publicId: true, doctorId: true, startedAt: true },
  });

  let notified = 0;

  for (const consultation of live) {
    const timer = await getTimer(consultation.id, db, clock);
    if (!timer) continue;

    if (timer.warning || timer.overrun) {
      emitToConsultation(consultation.publicId, 'consultation.timer_warning', {
        remainingSeconds: timer.remainingSeconds,
        overrun: timer.overrun,
        overrunSeconds: timer.overrunSeconds,
      });

      if (consultation.doctorId) {
        emitToDoctor(consultation.doctorId, 'consultation.timer_warning', {
          consultationPublicId: consultation.publicId,
          remainingSeconds: timer.remainingSeconds,
          overrun: timer.overrun,
        });
      }
      notified += 1;
    }
  }

  return notified;
}
