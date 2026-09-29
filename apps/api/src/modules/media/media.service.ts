import type { PrismaClient } from '@prisma/client';
import { getPrisma, isUniqueConstraintError, type Db } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { decryptField, decryptNullable, encryptField } from '../../lib/crypto.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
import { getLogger } from '../../lib/logger.ts';
import { getIntSetting } from '../settings/settings.service.ts';
import { SETTING_KEYS } from '../settings/settings.defaults.ts';
import { transition } from '../consultation/consultation.service.ts';
import { emitToConsultation, emitToDoctor } from '../realtime/realtime.service.ts';
import { getVideoProvider, getVoiceProvider } from '../../adapters/media/index.ts';
import { notify } from '../notification/notification.service.ts';
import { MediaProviderError } from '../../adapters/media/media.provider.ts';
import { acceptsCallJoin } from '../../domain/consultation-state.ts';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit.service.ts';

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

  /*
   * Joinable while the consultation is live, and while it is interrupted
   * (D57). The interrupted case is the whole point: the patient paid, the
   * call broke, and coming back must not cost them anything.
   */
  if (!acceptsCallJoin(consultation.state)) {
    throw errors.businessRule(`This consultation is ${consultation.state} and cannot be joined.`);
  }

  if (consultation.state === 'INTERRUPTED' && !canStillRejoin(consultation, clock)) {
    throw errors.businessRule(
      'The window for rejoining this consultation has passed. Neem will arrange for it to be ' +
        'finished; you will not be charged again.',
    );
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
  const kind = consultation.type === 'VIDEO' ? 'VIDEO' : 'AUDIO';
  let session = consultation.mediaSessions[0];

  if (!session) {
    session = await openRoom(consultation, kind, roomLifetimeSeconds, null, db, clock);
  }

  /*
   * A room that has expired is replaced before anyone tries to use it, rather
   * than after they meet an error (D57).
   */
  if (session.roomExpiresAt && session.roomExpiresAt <= clock.now()) {
    session = await openRoom(consultation, kind, roomLifetimeSeconds, session, db, clock);
  }

  let token: Awaited<ReturnType<typeof provider.issueJoinToken>>;
  try {
    token = await issueFor(session, participant, roomLifetimeSeconds);
  } catch (error) {
    /*
     * The provider no longer has this room: deleted, swept, or created by a
     * server that has since restarted. A replacement under the same
     * consultation is exactly what the patient is owed, and costs nothing.
     */
    if (!(error instanceof MediaProviderError)) throw error;

    getLogger().warn(
      { consultationId: consultation.id, sessionId: session.id },
      'room unusable; opening a replacement',
    );
    session = await openRoom(consultation, kind, roomLifetimeSeconds, session, db, clock);
    token = await issueFor(session, participant, roomLifetimeSeconds);
  }

  async function issueFor(
    current: NonNullable<typeof session>,
    who: 'PATIENT' | 'DOCTOR',
    ttlSeconds: number,
  ) {
    return provider.issueJoinToken({
      providerRoomRef: current.providerRoomRef!,
      participant: who,
      // A generic label. The doctor learns who the patient is from the
      // clinical record, not from a video tile — and the patient never sees an
      // identifier for the doctor beyond their professional name.
      displayName: who === 'PATIENT' ? 'Patient' : 'Doctor',
      ttlSeconds,
      roomUrl: current.roomUrlEnc ? decryptField(current.roomUrlEnc) : undefined,
      hostRoomUrl: current.hostRoomUrlEnc ? decryptField(current.hostRoomUrlEnc) : undefined,
      kind: current.kind === 'AUDIO' ? 'AUDIO' : 'VIDEO',
      expiresAt: current.roomExpiresAt ?? undefined,
    });
  }

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

  /*
   * Coming back to an interrupted consultation resumes it (D57).
   *
   * Either party returning is enough: the consultation is live again, and the
   * doctor's slot is taken back at the same moment so the queue does not hand
   * them a second patient mid-call.
   */
  if (consultation.state === 'INTERRUPTED') {
    await resumeInterrupted(consultation.id, participant, db, clock);
  }

  await recordAttendance(
    {
      consultationId: consultation.id,
      mediaSessionId: session.id,
      participant,
      event: 'JOINED',
      source: 'CLIENT',
    },
    db,
    clock,
  );

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
  clock: Clock = systemClock,
): Promise<void> {
  const consultation = await db.consultation.findUnique({
    where: { id: consultationId },
    select: { publicId: true, doctorId: true, state: true },
  });
  if (!consultation) return;

  const open = await db.mediaSession.findFirst({
    where: { consultationId, endedAt: null },
    orderBy: { startedAt: 'desc' },
  });

  /*
   * Recorded as attendance, and nothing more (D57).
   *
   * Leaving a call is not completing a consultation, not abandoning one, and
   * not evidence of either. The only thing that ends a consultation is a
   * doctor completing it.
   */
  await recordAttendance(
    {
      consultationId,
      mediaSessionId: open?.id ?? null,
      participant,
      event: 'LEFT',
      source: 'CLIENT',
    },
    db,
    clock,
  );

  emitToConsultation(consultation.publicId, 'consultation.participant_left', { participant });

  // The doctor is told, because they are the one who decides what happens
  // next: wait, or arrange to finish it another time.
  if (participant === 'PATIENT' && consultation.doctorId) {
    emitToDoctor(consultation.doctorId, 'consultation.patient_left', {
      consultationPublicId: consultation.publicId,
    });
  }
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

// ---------------------------------------------------------------------------
// Recovery (D57)
// ---------------------------------------------------------------------------

/**
 * How long a broken consultation stays rejoinable without paying again.
 *
 * Long enough for a phone that died, a power cut, or a patient who has to find
 * somewhere with signal; short enough that a consultation does not stay open
 * forever with nobody looking at it. The operator can change it, and what
 * happens at the end of it is deliberately not "the money is gone" — Neem
 * arranges for the consultation to be finished.
 */
export const REJOIN_WINDOW_HOURS = 24;

interface RejoinWindow {
  rejoinableUntil: Date | null;
}

export function canStillRejoin(consultation: RejoinWindow, clock: Clock = systemClock): boolean {
  // No deadline recorded means nothing has expired: an older interruption, or
  // one an administrator opened by hand, is not a patient's fault.
  if (!consultation.rejoinableUntil) return true;
  return consultation.rejoinableUntil > clock.now();
}

/**
 * Creates a room for a consultation, replacing one that has gone.
 *
 * The unique index on open sessions is what makes this safe against two
 * clicks, two tabs or two servers: the second insert loses, reads the winner,
 * and everybody ends up in the same room. A replacement is always cheaper than
 * a second room nobody else is in.
 */
async function openRoom(
  consultation: { id: string; publicId: string },
  kind: 'VIDEO' | 'AUDIO',
  lifetimeSeconds: number,
  replacing: { id: string; attempt: number; providerRoomRef: string | null } | null,
  db: PrismaClient,
  clock: Clock,
) {
  const provider = getVideoProvider();

  if (replacing) {
    await db.mediaSession.updateMany({
      where: { id: replacing.id, endedAt: null },
      data: { endedAt: clock.now(), endReason: 'room_replaced' },
    });

    // Best effort: a room we are abandoning should not outlive us, but a
    // provider that cannot be reached must not stop the patient rejoining.
    if (replacing.providerRoomRef) {
      await provider
        .endRoom(replacing.providerRoomRef)
        .catch((error: unknown) =>
          getLogger().warn({ err: error }, 'could not delete the replaced room'),
        );
    }
  }

  const room = await provider.createRoom({
    consultationPublicId: consultation.publicId,
    kind,
    maxDurationSeconds: lifetimeSeconds,
  });

  try {
    const created = await db.mediaSession.create({
      data: {
        consultationId: consultation.id,
        provider: provider.name,
        kind,
        providerRoomRef: room.providerRoomRef,
        startedAt: clock.now(),
        // Never set from a parameter. There is no code path that sets it true.
        recordingEnabled: false,
        roomUrlEnc: room.roomUrl ? encryptField(room.roomUrl) : null,
        hostRoomUrlEnc: room.hostRoomUrl ? encryptField(room.hostRoomUrl) : null,
        roomExpiresAt: room.expiresAt ?? null,
        attempt: (replacing?.attempt ?? 0) + 1,
        replacedSessionId: replacing?.id ?? null,
      },
    });

    if (replacing) {
      await recordAudit(
        {
          action: AUDIT_ACTIONS.CALL_ROOM_REPLACED,
          actorType: 'SYSTEM',
          entityType: 'consultation',
          entityId: consultation.id,
          metadata: { attempt: created.attempt },
        },
        db,
      );
    }

    return created;
  } catch (error) {
    /*
     * Somebody else opened one first. Theirs is as good as ours, and two
     * rooms would leave the two parties looking at each other's absence — so
     * the loser tidies up and joins the winner.
     */
    if (!isUniqueConstraintError(error)) throw error;

    await provider.endRoom(room.providerRoomRef).catch(() => undefined);

    const winner = await db.mediaSession.findFirst({
      where: { consultationId: consultation.id, endedAt: null },
      orderBy: { startedAt: 'desc' },
    });
    if (!winner) throw error;
    return winner;
  }
}

/** Who was in the call, and when. Never why, and never anything clinical. */
async function recordAttendance(
  entry: {
    consultationId: string;
    mediaSessionId?: string | null;
    participant: 'PATIENT' | 'DOCTOR';
    event: 'JOINED' | 'LEFT' | 'SESSION_ENDED';
    source: 'CLIENT' | 'WEBHOOK' | 'SERVER';
    providerSessionRef?: string | null;
  },
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<void> {
  await db.callAttendanceEvent.create({
    data: {
      consultationId: entry.consultationId,
      mediaSessionId: entry.mediaSessionId ?? null,
      participant: entry.participant,
      event: entry.event,
      source: entry.source,
      providerSessionRef: entry.providerSessionRef ?? null,
      occurredAt: clock.now(),
    },
  });
}

export { recordAttendance };

/**
 * Records that the call broke, and that the consultation is unfinished (D57).
 *
 * Called by the doctor, never by a timer and never by the provider. It frees
 * the doctor's slot — an interrupted consultation is not one in progress — and
 * starts the window in which the patient may come back without paying again.
 * It completes nothing, charges nothing and pays nobody.
 */
export async function interruptConsultation(
  consultationId: string,
  actor: { type: 'DOCTOR' | 'ADMIN' | 'SYSTEM'; id?: string; note?: string },
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<{ state: 'INTERRUPTED'; rejoinableUntil: string }> {
  const consultation = await db.consultation.findUnique({
    where: { id: consultationId },
    select: { id: true, publicId: true, state: true, rejoinableUntil: true },
  });
  if (!consultation) throw errors.notFound('Consultation not found.');

  // Already interrupted: saying so twice is not an error, and the patient's
  // window is not restarted by a second click.
  if (consultation.state === 'INTERRUPTED') {
    return {
      state: 'INTERRUPTED',
      rejoinableUntil: (consultation.rejoinableUntil ?? clock.now()).toISOString(),
    };
  }

  const hours = await getIntSetting(SETTING_KEYS.CONSULTATION_REJOIN_WINDOW_HOURS, db).catch(
    () => REJOIN_WINDOW_HOURS,
  );
  const rejoinableUntil = new Date(clock.now().getTime() + hours * 3_600_000);

  await db.consultation.update({
    where: { id: consultationId },
    data: {
      rejoinableUntil,
      interruptedAt: clock.now(),
      interruptionNote: actor.note?.slice(0, 500) ?? null,
    },
  });

  await transition(
    consultationId,
    'INTERRUPTED',
    { actorType: actor.type, actorId: actor.id, reason: 'call_interrupted' },
    db,
    clock,
  );

  await recordAudit(
    {
      action: AUDIT_ACTIONS.CALL_INTERRUPTED,
      actorType: actor.type,
      actorId: actor.id ?? null,
      entityType: 'consultation',
      entityId: consultationId,
      metadata: { rejoinableUntil: rejoinableUntil.toISOString() },
    },
    db,
  );

  emitToConsultation(consultation.publicId, 'consultation.state_changed', {
    state: 'INTERRUPTED',
  });

  /*
   * Fire and forget, like every other notification: a patient who cannot be
   * reached by SMS still has the consultation open, and failing to tell them
   * must not undo the record that it is.
   */
  void notify({
    templateCode: 'patient.consultation.interrupted',
    recipient: { type: 'PATIENT', consultationId },
    variables: { consultationReference: consultation.publicId },
  }).catch((error: unknown) =>
    getLogger().warn({ err: error, consultationId }, 'could not tell the patient'),
  );

  return { state: 'INTERRUPTED', rejoinableUntil: rejoinableUntil.toISOString() };
}

/**
 * Either party came back, so the consultation is live again (D57).
 *
 * The doctor's slot is taken back by the transition out of INTERRUPTED, so a
 * doctor mid-call cannot be handed a second patient.
 */
async function resumeInterrupted(
  consultationId: string,
  participant: 'PATIENT' | 'DOCTOR',
  db: PrismaClient,
  clock: Clock,
): Promise<void> {
  const consultation = await db.consultation.findUnique({
    where: { id: consultationId },
    select: { id: true, publicId: true, state: true, doctorId: true },
  });
  // Raced by a completion, or by the other party rejoining first. Either way
  // there is nothing to resume.
  if (!consultation || consultation.state !== 'INTERRUPTED') return;

  await db.consultation.update({
    where: { id: consultationId },
    data: { rejoinableUntil: null },
  });

  await transition(
    consultationId,
    'IN_PROGRESS',
    {
      actorType: participant === 'PATIENT' ? 'PATIENT' : 'DOCTOR',
      reason: 'call_resumed',
    },
    db,
    clock,
  );

  await recordAudit(
    {
      action: AUDIT_ACTIONS.CALL_RESUMED,
      actorType: participant === 'PATIENT' ? 'PATIENT' : 'DOCTOR',
      entityType: 'consultation',
      entityId: consultationId,
      metadata: { by: participant },
    },
    db,
  );

  emitToConsultation(consultation.publicId, 'consultation.state_changed', {
    state: 'IN_PROGRESS',
  });
}
