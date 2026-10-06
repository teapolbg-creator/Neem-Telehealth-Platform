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

  /*
   * Past its deadline, nobody joins — whatever state it is in (D63).
   *
   * The recovery check above only looks at INTERRUPTED consultations, which
   * left the case the incident actually took: a consultation stuck IN_PROGRESS
   * accepted a rejoin seven days later, found its Whereby room long swept, and
   * **minted a fresh one**. A room is a bearer credential, so that is not a
   * cosmetic bug — it is opening a new way into a consultation that should
   * have been closed.
   *
   * Checked before the room is opened rather than after, because the harm is
   * the room existing.
   */
  if (consultation.unservedDeadlineAt && consultation.unservedDeadlineAt <= clock.now()) {
    throw errors.businessRule(
      'This consultation has closed. Neem will be in touch about it, and you will not be ' +
        'charged again.',
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
    select: { startedAt: true, firstStartedAt: true, state: true, interruptedAt: true },
  });

  /*
   * From the first start, not the latest one (D61).
   *
   * `startedAt` is rewritten whenever a consultation re-enters IN_PROGRESS, so
   * counting from it meant a call broken at four minutes resumed showing zero
   * and the five-minute target began again. A resumed consultation is the same
   * consultation, and its elapsed time says so.
   *
   * `firstStartedAt` is null on records written before this existed, which
   * fall back to `startedAt` — the same number they always reported.
   */
  if (!consultation) return null;

  const began = consultation.firstStartedAt ?? consultation.startedAt;
  if (!began) return null;

  /*
   * A consultation nobody is in has no running clock.
   *
   * An interrupted one used to keep counting, which is how a patient came back
   * to "+9949:55 over": the timer had been running for a week on a call that
   * stopped on the first day. The elapsed figure is frozen at the interruption
   * instead, which is also the honest one — the consultation really did get
   * that far and no further.
   */
  const frozenAt = consultation.state === 'INTERRUPTED' ? consultation.interruptedAt : null;

  const [durationSeconds, warningSeconds] = await Promise.all([
    getIntSetting(SETTING_KEYS.CONSULTATION_DURATION_SECONDS, db),
    getIntSetting(SETTING_KEYS.CONSULTATION_WARNING_SECONDS, db),
  ]);

  const until = frozenAt ?? clock.now();
  const elapsedSeconds = Math.max(0, Math.floor((until.getTime() - began.getTime()) / 1000));
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
 * How long a broken call stays rejoinable, in minutes (D61).
 *
 * Fifteen, not the twenty-four hours this was. A rejoin resumes *this*
 * consultation: the same five-minute appointment, with the same doctor, who is
 * on a shift. After a day there is no call to resume, and a rejoin button that
 * says otherwise is telling the patient something untrue.
 *
 * The fallback only; the operator's value is `consultation.recoveryWindowMinutes`.
 */
export const RECOVERY_WINDOW_MINUTES = 15;

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
    select: {
      id: true,
      publicId: true,
      state: true,
      rejoinableUntil: true,
      interruptedAt: true,
    },
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

  /*
   * The deadline is set once, from the FIRST time this call broke (D61).
   *
   * A consultation can be interrupted, rejoined and interrupted again. If each
   * break started a fresh window, a patient could hold a consultation open
   * indefinitely by rejoining and dropping out — which is the shape of the bug
   * this replaces, where resuming cleared the deadline altogether and nothing
   * bounded the consultation's life again.
   *
   * So an existing `interruptedAt` wins, and a later break inherits the
   * deadline the first one set.
   */
  const minutes = await getIntSetting(SETTING_KEYS.CONSULTATION_RECOVERY_WINDOW_MINUTES, db).catch(
    () => RECOVERY_WINDOW_MINUTES,
  );

  const firstInterruptedAt = consultation.interruptedAt ?? clock.now();
  const rejoinableUntil =
    consultation.rejoinableUntil ?? new Date(firstInterruptedAt.getTime() + minutes * 60_000);

  await db.consultation.update({
    where: { id: consultationId },
    data: {
      rejoinableUntil,
      interruptedAt: firstInterruptedAt,
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
 * The patient is back, and waiting (D64).
 *
 * A return cannot resume the consultation — only a professional does that — so
 * this is what makes the return exist at all: a timestamp the doctor's portal
 * reads, a message on the channels they already use, and a live event for a
 * doctor who happens to be looking.
 *
 * **Idempotent on the timestamp.** A refresh, a double tap and a reconnect are
 * all the same return, and each must not send another message or reset how long
 * the patient has been waiting. Only the first one through writes; the rest
 * find it set and do nothing. That is also what stops a patient generating
 * notifications at will.
 *
 * Returns whether the professional was notified, meaning the notification
 * service accepted it for delivery — not that anybody has read it. The
 * patient's screen says the same thing in the same words.
 */
async function recordPatientReturn(
  consultation: { id: string; publicId: string; doctorId: string | null },
  db: PrismaClient,
  clock: Clock,
): Promise<boolean> {
  const claimed = await db.consultation.updateMany({
    where: { id: consultation.id, state: 'INTERRUPTED', patientReturnedAt: null },
    data: { patientReturnedAt: clock.now() },
  });

  // Already waiting, or no longer interrupted. Either way this return has
  // already been recorded and nobody needs telling twice.
  if (claimed.count === 0) return false;

  await recordAudit(
    {
      action: AUDIT_ACTIONS.CALL_RESUMED,
      actorType: 'PATIENT',
      entityType: 'consultation',
      entityId: consultation.id,
      metadata: { by: 'PATIENT', resumed: false, reason: 'awaiting_professional' },
    },
    db,
  );

  if (!consultation.doctorId) return false;

  /*
   * The live event for a doctor who is looking, and the message for one who is
   * not. Neither is relied on alone: the durable record is the timestamp above,
   * which the portal reads whether or not any of this arrived.
   */
  emitToDoctor(consultation.doctorId, 'consultation.patient_returned', {
    consultationPublicId: consultation.publicId,
  });

  try {
    await notify({
      templateCode: 'doctor.consultation.patient-returned',
      recipient: { type: 'DOCTOR', doctorId: consultation.doctorId },
      variables: { consultationReference: consultation.publicId },
    });
    return true;
  } catch (error) {
    /*
     * The patient is still back and the portal still shows it; what failed is
     * one way of telling the doctor. Reported as not notified rather than
     * swallowed, because the patient's screen must not claim a message was
     * sent when it was not.
     */
    getLogger().warn(
      { err: error, consultationId: consultation.id },
      'could not notify the professional that the patient returned',
    );
    return false;
  }
}

/**
 * Somebody came back (D57, corrected by D61).
 *
 * **Only a professional resumes a consultation.** It used to be either party,
 * which meant a patient tapping "rejoin" moved the consultation back to
 * IN_PROGRESS with nobody there to see them: the clock restarted, the doctor
 * was neither present nor told, and the patient sat alone in a video room
 * watching a timer run. That is the state the reported incident was found in.
 *
 * A patient returning is real and worth acting on — it is just not the
 * consultation resuming. They are let back into the room and the doctor is
 * paged; the consultation stays INTERRUPTED, and its deadline keeps running,
 * until a professional is actually back in the room.
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

  /*
   * A patient coming back is not the consultation resuming (D61).
   *
   * They are in the room, which is what they can do; the doctor is told, which
   * is what makes it useful. The state does not move, so the recovery deadline
   * keeps running and an unanswered return still expires rather than becoming
   * an open-ended session with nobody in it.
   */
  if (participant === 'PATIENT') {
    await recordPatientReturn(consultation, db, clock);
    return;
  }

  /*
   * `rejoinableUntil` is deliberately NOT cleared.
   *
   * Clearing it was how a single rejoin removed the only bound on the
   * consultation's life: it went back to IN_PROGRESS with no deadline, and no
   * sweep could see it again. The deadline belongs to the interruption, not to
   * whether somebody is currently in the room, and a consultation that resumes
   * and breaks again keeps the window the first break opened.
   */
  /*
   * The pending-return item is cleared by the thing that resolves it (D64).
   *
   * Leaving it set would keep a "patient waiting" row in the doctor's portal
   * for a consultation they are now in, which is the kind of notification
   * people learn to ignore.
   */
  await db.consultation.update({
    where: { id: consultationId },
    data: { patientReturnedAt: null },
  });

  await transition(
    consultationId,
    'IN_PROGRESS',
    { actorType: 'DOCTOR', reason: 'call_resumed' },
    db,
    clock,
  );

  await recordAudit(
    {
      action: AUDIT_ACTIONS.CALL_RESUMED,
      // Only a professional reaches here; a patient returning took the early
      // exit above without resuming anything (D61).
      actorType: 'DOCTOR',
      entityType: 'consultation',
      entityId: consultationId,
      metadata: { by: participant, resumed: true },
    },
    db,
  );

  emitToConsultation(consultation.publicId, 'consultation.state_changed', {
    state: 'IN_PROGRESS',
  });
}
