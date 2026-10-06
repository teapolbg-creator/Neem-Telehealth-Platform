import type { PrismaClient } from '@prisma/client';
import { getPrisma, type Db } from '../../db/prisma.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
import { getLogger } from '../../lib/logger.ts';
import { getIntSetting } from '../settings/settings.service.ts';
import { SETTING_KEYS } from '../settings/settings.defaults.ts';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit.service.ts';
import { isTerminal } from '../../domain/consultation-state.ts';
import { transition } from './consultation.service.ts';
import { hasClinicalContent } from '../retention/clinical-record.service.ts';

/**
 * Nothing paid for stays open for ever (D61).
 *
 * The fault this exists for: no scheduled job could terminate a consultation
 * once it left the queue. `expire-pending-payments` covered the states before
 * payment and `cancel-unserved-consultations` covered the two queue states, and
 * between them they left `ACTIVATED`, `WAITING_FOR_PATIENT`, `PATIENT_JOINED`,
 * `ASSIGNED`, `DOCTOR_ACCEPTED`, `IN_PROGRESS`, `INTERRUPTED` and `COMPLETING`
 * immortal. A consultation that stalled in any of them sat there until somebody
 * noticed by hand — which is how a patient came back a week later to a rejoin
 * button and a timer reading "+9949:55 over".
 *
 * **The deadline is stored, not computed.** `unservedDeadlineAt` is written
 * once, when a verified payment activates the consultation, and nothing
 * recalculates it. That is what makes it immune to the things that used to
 * extend a consultation's life: a rejoin, a refresh, a new session token, a
 * server restart. A deadline derived on read from "now plus a day" would move
 * every time anybody looked at it.
 *
 * **It is a maximum, not a target.** A patient waiting anywhere near it has
 * already been failed. `queue.maxWaitSeconds` — twenty minutes — is the number
 * that describes a wait anyone should accept, and the existing queue sweep
 * still enforces it. This is the backstop behind that, for every state the
 * queue sweep cannot see.
 */

/** The allowance a scheduled appointment gets after its own start time. */
const APPOINTMENT_GRACE_HOURS = 24;

/**
 * When a consultation stops being worth waiting for.
 *
 * Immediate consultations are measured from the verified payment, because that
 * is when the patient started being owed something. A scheduled appointment is
 * measured from the appointment's own start — a booking made days ahead is not
 * unserved, it simply has not happened yet, and payment plus twenty-four hours
 * would expire it before the patient's slot came round.
 */
export async function computeUnservedDeadline(
  consultationId: string,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<Date> {
  const hours = await getIntSetting(SETTING_KEYS.CONSULTATION_UNSERVED_DEADLINE_HOURS, db).catch(
    () => 24,
  );

  const appointment = await db.appointment.findUnique({
    where: { consultationId },
    select: { startsAt: true },
  });

  const anchor = appointment?.startsAt ?? clock.now();
  const allowance = appointment ? APPOINTMENT_GRACE_HOURS : hours;

  return new Date(anchor.getTime() + allowance * 3_600_000);
}

/**
 * Records the deadline, once (D61).
 *
 * Called from the payment settlement. Idempotent on purpose: a webhook that
 * arrives twice, a verification that runs again, and a settlement replayed
 * after downtime must not push the deadline back — the second call finds one
 * already set and leaves it alone. That is the whole reason this is a stored
 * value rather than a computed one.
 */
export async function recordUnservedDeadline(
  consultationId: string,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<Date | null> {
  const existing = await db.consultation.findUnique({
    where: { id: consultationId },
    select: { unservedDeadlineAt: true, state: true },
  });
  if (!existing) return null;
  if (existing.unservedDeadlineAt) return existing.unservedDeadlineAt;
  if (isTerminal(existing.state)) return null;

  const deadline = await computeUnservedDeadline(consultationId, db, clock);

  /*
   * Conditional on the column still being empty, so two settlements racing
   * each other cannot write two different deadlines. The loser updates nothing
   * and reads the winner's value back.
   */
  const written = await db.consultation.updateMany({
    where: { id: consultationId, unservedDeadlineAt: null },
    data: { unservedDeadlineAt: deadline },
  });

  if (written.count === 0) {
    const current = await db.consultation.findUnique({
      where: { id: consultationId },
      select: { unservedDeadlineAt: true },
    });
    return current?.unservedDeadlineAt ?? null;
  }

  return deadline;
}

/**
 * Whether a professional was ever actually in this consultation.
 *
 * Deliberately several signals, not one timestamp. `startedAt` alone would be
 * wrong in both directions: it is set when a patient's rejoin resumed a
 * consultation nobody attended, and it is absent on a consultation where a
 * doctor connected through a path that did not set it. Getting this wrong
 * means either refunding care that was given or refusing a refund to a patient
 * who got nothing, so it asks every question it can:
 *
 * - did a professional's device ever join the room, by the browser's account or
 *   the provider's webhook;
 * - is there a clinical note, which only a professional can write;
 * - was any document issued.
 *
 * Any one of them is enough to say care may have been delivered. None of them
 * is proof that it was not — it is proof that this system holds no evidence it
 * was, which is why the result sends the case to a person rather than straight
 * to a refund.
 */
export async function professionalEverConnected(
  consultationId: string,
  db: Db = getPrisma(),
): Promise<boolean> {
  const [attendance, clinical, prescriptions, referrals, summary, doctorStarted] =
    await Promise.all([
      db.callAttendanceEvent.count({
        where: { consultationId, participant: 'DOCTOR', event: 'JOINED' },
      }),
      hasClinicalContent(consultationId, db),
      db.prescription.count({ where: { consultationId } }),
      db.referral.count({ where: { consultationId } }),
      db.consultationSummary.count({ where: { consultationId } }),
      /*
       * The state history, which every consultation has (D61).
       *
       * Attendance events only began with D57, so a consultation that ran before
       * it has none — and asking only the newer tables declares every older
       * consultation unattended. That is not a gap in the record, it is the
       * record saying nothing, and the two must not look the same when the
       * answer decides a refund.
       *
       * A transition into IN_PROGRESS performed by a DOCTOR is written by one
       * path only: a professional joining the room. It is durable, it predates
       * everything else here, and it is the evidence the reported incident
       * turned on — that consultation showed no attendance at all and had in
       * fact been joined by a doctor four seconds after they accepted it.
       */
      db.consultationStateEvent.count({
        where: { consultationId, toState: 'IN_PROGRESS', actorType: 'DOCTOR', accepted: true },
      }),
    ]);

  return attendance > 0 || clinical || prescriptions + referrals + summary > 0 || doctorStarted > 0;
}

/**
 * When something last actually happened in this consultation.
 *
 * The most recent attendance event, or the moment it started if there are
 * none. Used both to find consultations nobody is in and to protect ones
 * somebody is — a sweep that cannot tell those apart has no business ending
 * either.
 */
async function lastActivityAt(
  consultationId: string,
  startedAt: Date | null,
  db: Db = getPrisma(),
): Promise<Date | null> {
  const latest = await db.callAttendanceEvent.findFirst({
    where: { consultationId },
    orderBy: { occurredAt: 'desc' },
    select: { occurredAt: true },
  });

  return latest?.occurredAt ?? startedAt;
}

/**
 * Marks consultations interrupted when nothing has happened in them (D63).
 *
 * The gap this closes: a consultation left IN_PROGRESS only when a doctor
 * completed it. A doctor who closed their tab left it there permanently, and
 * because it had no queue entry no other sweep could see it either. The
 * reported incident sat like that for seven days with the patient's timer
 * running.
 *
 * It does **not** end anything. It marks the consultation INTERRUPTED, which is
 * what it actually is, and that starts the recovery window — so whoever dropped
 * out has fifteen minutes to come back before it is abandoned. Nothing here
 * decides money and the timer still ends nothing (spec §15).
 *
 * It also reaches consultations that predate `unservedDeadlineAt`, because it
 * asks about activity rather than about a deadline. That is deliberate: those
 * are exactly the records with no other way out.
 */
export async function interruptStaleConsultations(
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<number> {
  const minutes = await getIntSetting(
    SETTING_KEYS.CONSULTATION_STALE_IN_PROGRESS_MINUTES,
    db,
  ).catch(() => 120);
  if (minutes <= 0) return 0;

  const cutoff = new Date(clock.now().getTime() - minutes * 60_000);

  const live = await db.consultation.findMany({
    where: { state: 'IN_PROGRESS', startedAt: { not: null } },
    select: { id: true, publicId: true, startedAt: true },
    orderBy: { startedAt: 'asc' },
    take: 100,
  });

  let interrupted = 0;

  for (const consultation of live) {
    try {
      const activity = await lastActivityAt(consultation.id, consultation.startedAt, db);
      if (!activity || activity > cutoff) continue;

      const { interruptConsultation } = await import('../media/media.service.ts');
      await interruptConsultation(
        consultation.id,
        { type: 'SYSTEM', note: 'No activity in this consultation; marked interrupted (D63).' },
        db,
        clock,
      );
      interrupted += 1;

      getLogger().warn(
        { consultationId: consultation.id, lastActivityAt: activity.toISOString() },
        'marked a stale consultation interrupted',
      );
    } catch (error) {
      getLogger().error(
        { err: error, consultationPublicId: consultation.publicId },
        'could not interrupt a stale consultation',
      );
    }
  }

  return interrupted;
}

export interface ExpirySweepResult {
  expired: number;
  /** Consultations whose deadline has passed but which a professional attended. */
  needingReview: number;
}

/**
 * Ends paid consultations that are past their deadline (D61).
 *
 * Two outcomes, because they are two different situations and the money
 * question differs:
 *
 * - **Nobody ever came.** The consultation EXPIRES and a full refund is
 *   requested. The patient paid and received nothing.
 * - **A professional attended and it was never finished.** The consultation is
 *   ABANDONED and a refund request is raised for a person to decide, because
 *   whether care was delivered is a judgement this system cannot make. It is
 *   not treated as wholly undelivered.
 *
 * Neither outcome moves money on its own. Both raise a request in the existing
 * refund flow, which an administrator approves — a background job and a live
 * payment provider is not a combination to automate while the pilot is small.
 *
 * Safe to run repeatedly, concurrently, and after downtime: each consultation
 * is re-read and re-checked inside its own attempt, the state machine refuses a
 * second terminal transition, and a failure on one record cannot stop the rest.
 */
export async function expireUnservedConsultations(
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<ExpirySweepResult> {
  const now = clock.now();

  /*
   * Every non-terminal state, which is the point: the hole this closes was
   * that most of them were unreachable by any sweep. A terminal consultation
   * is excluded by the state filter rather than by the deadline, so a record
   * that already ended is never touched again however late the job runs.
   */
  const overdue = await db.consultation.findMany({
    where: {
      unservedDeadlineAt: { lt: now },
      state: {
        in: [
          'ACTIVATED',
          'WAITING_FOR_PATIENT',
          'PATIENT_JOINED',
          'WAITING_FOR_DOCTOR',
          'ASSIGNED',
          'REASSIGNING',
          'DOCTOR_ACCEPTED',
          'IN_PROGRESS',
          'INTERRUPTED',
        ],
      },
    },
    select: { id: true, publicId: true, state: true },
    orderBy: { unservedDeadlineAt: 'asc' },
    take: 100,
  });

  const result: ExpirySweepResult = { expired: 0, needingReview: 0 };

  for (const consultation of overdue) {
    try {
      const attended = await professionalEverConnected(consultation.id, db);
      const ended = await endUnserved(consultation.id, attended, db, clock);
      if (!ended) continue;

      if (attended) result.needingReview += 1;
      else result.expired += 1;
    } catch (error) {
      // One stuck record must not stop the rest being resolved.
      getLogger().error(
        { err: error, consultationPublicId: consultation.publicId },
        'could not expire an overdue consultation',
      );
    }
  }

  return result;
}

/**
 * Ends interrupted consultations whose recovery window has run out (D61).
 *
 * Separate from the unserved sweep because the clock is different: this one is
 * measured in minutes from the moment the call broke, not hours from the
 * payment, and it is the bound that was missing entirely — a rejoin used to
 * clear `rejoinableUntil`, after which nothing could see the consultation
 * again.
 *
 * A professional attended, by definition, since a consultation can only be
 * interrupted after one engaged with it. So every one of these is ABANDONED
 * with a refund request for a person to decide, never an automatic refund: some
 * of them had most of a consultation delivered before the call dropped.
 */
export async function expireRecoveryWindows(
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<number> {
  const lapsed = await db.consultation.findMany({
    where: { state: 'INTERRUPTED', rejoinableUntil: { lt: clock.now() } },
    select: { id: true, publicId: true },
    orderBy: { rejoinableUntil: 'asc' },
    take: 100,
  });

  let ended = 0;

  for (const consultation of lapsed) {
    try {
      /*
       * Asked rather than assumed, even here. An interruption implies a
       * professional was engaged, but "engaged" is an acceptance and this
       * decides money — so the same evidence test runs, and a consultation
       * where a doctor accepted and never actually appeared is treated as the
       * unattended case it is.
       */
      const attended = await professionalEverConnected(consultation.id, db);
      if (await endUnserved(consultation.id, attended, db, clock, 'recovery_window_elapsed')) {
        ended += 1;
      }
    } catch (error) {
      getLogger().error(
        { err: error, consultationPublicId: consultation.publicId },
        'could not end a consultation past its recovery window',
      );
    }
  }

  return ended;
}

/**
 * Ends one overdue consultation, losing every race it can lose.
 *
 * The state is re-read immediately before the transition and the transition
 * itself asserts what it is moving from, so a doctor who accepts, starts or
 * completes the consultation between the sweep's query and this call wins: the
 * transition is refused and the patient keeps the consultation they were about
 * to be given. Expiring a consultation a doctor has just joined would be the
 * worst possible outcome of a cleanup job.
 */
async function endUnserved(
  consultationId: string,
  attended: boolean,
  db: PrismaClient,
  clock: Clock,
  cause: 'unserved_deadline' | 'recovery_window_elapsed' = 'unserved_deadline',
): Promise<boolean> {
  const fresh = await db.consultation.findUnique({
    where: { id: consultationId },
    select: {
      id: true,
      publicId: true,
      state: true,
      startedAt: true,
      unservedDeadlineAt: true,
      rejoinableUntil: true,
    },
  });
  if (!fresh || isTerminal(fresh.state)) return false;

  /*
   * The deadline is re-read and re-checked here, not trusted from the query
   * that selected this row.
   *
   * Between the sweep's query and this call a doctor may have accepted the
   * consultation, started it, or completed it; a patient may have rejoined and
   * a professional come back. Re-reading is what makes the job lose those
   * races, which is the direction it should lose them in — expiring a
   * consultation a doctor has just joined would be the worst thing a cleanup
   * job could do.
   */
  const deadline =
    cause === 'recovery_window_elapsed' ? fresh.rejoinableUntil : fresh.unservedDeadlineAt;
  if (!deadline || deadline >= clock.now()) return false;
  if (cause === 'recovery_window_elapsed' && fresh.state !== 'INTERRUPTED') return false;

  /*
   * Never end a consultation somebody is in the middle of (D63).
   *
   * The unserved deadline is measured from payment, so a doctor who joins
   * twenty-three hours after a patient paid would be an hour from having the
   * consultation expired underneath them. A live call outranks a deadline
   * about waiting: the point of the deadline is that nobody came, and somebody
   * plainly has.
   *
   * The stale sweep is what ends these instead, measured from when anything
   * last happened rather than from the payment.
   */
  if (fresh.state === 'IN_PROGRESS') {
    const staleMinutes = await getIntSetting(
      SETTING_KEYS.CONSULTATION_STALE_IN_PROGRESS_MINUTES,
      db,
    ).catch(() => 120);
    const activity = await lastActivityAt(consultationId, fresh.startedAt, db);
    const quietSince = new Date(clock.now().getTime() - staleMinutes * 60_000);

    if (activity && activity > quietSince) return false;
  }

  /*
   * A consultation somebody attended is ABANDONED; one nobody attended
   * EXPIRED. Both are terminal and both seal the record, but the word is the
   * one an administrator reads when deciding the refund, so it is worth being
   * accurate about.
   */
  const to = attended ? 'ABANDONED' : 'EXPIRED';

  await transition(
    consultationId,
    to,
    {
      actorType: 'SYSTEM',
      reason: attended ? `${cause}_after_attendance` : cause,
    },
    db,
    clock,
  );

  await recordAudit(
    {
      action: AUDIT_ACTIONS.CONSULTATION_STATE_CHANGED,
      actorType: 'SYSTEM',
      entityType: 'consultation',
      entityId: consultationId,
      metadata: {
        to,
        reason: cause,
        professionalAttended: attended,
        deadlineAt: deadline.toISOString(),
      },
    },
    db,
  );

  /*
   * Any open media session is torn down with it.
   *
   * Hiding a rejoin button is not ending a consultation: a Whereby room URL is
   * a bearer credential, so a patient holding the address could walk back into
   * the room of an expired consultation long after the record said it was
   * over. Best effort and after the state has changed — a provider that cannot
   * be reached must not keep a consultation alive.
   */
  await import('../media/media.service.ts')
    .then((media) => media.endMediaSession(consultationId, `consultation_${to.toLowerCase()}`))
    .catch((error: unknown) =>
      getLogger().warn({ err: error, consultationId }, 'could not tear down the media session'),
    );

  await requestRefundForUnserved(consultationId, attended, db, clock);

  return true;
}

/**
 * Asks for the money back, without deciding it (D61).
 *
 * Both cases raise a REQUESTED refund for an administrator, and neither moves
 * any money: a background job and a live payment provider is not a combination
 * to automate while the pilot is small, and the one case that looks automatic —
 * nobody ever came — is also the one where a wrong refund is least recoverable.
 *
 * The reason differs because the decision differs. Nobody came is a full refund
 * an administrator is confirming. A professional attended is a judgement they
 * have to make, and the request says so rather than presenting it as settled.
 *
 * Idempotent: an existing request or a completed refund is success, not a
 * failure to retry. A consultation with no successful payment raises nothing,
 * because there is nothing to give back.
 */
async function requestRefundForUnserved(
  consultationId: string,
  attended: boolean,
  db: PrismaClient,
  clock: Clock,
): Promise<void> {
  const { requestRefund } = await import('../payment/refund.service.ts');

  try {
    await requestRefund(
      consultationId,
      {
        requestedByType: 'SYSTEM',
        keepConsultationState: true,
        reason: attended
          ? 'The consultation was never finished after the professional joined. Please review what was delivered before deciding the refund.'
          : 'No professional attended this consultation before its deadline. A full refund is due.',
      },
      db,
      clock,
    );
  } catch (error) {
    /*
     * The two refusals that are not problems: a refund already exists, and
     * nothing was ever paid. Both mean this consultation needs nothing from
     * here, and both would otherwise make an idempotent sweep log an error
     * every time it ran.
     */
    const message = error instanceof Error ? error.message : '';
    const benign = /already being reviewed|already been refunded|No payment has been taken/i.test(
      message,
    );

    if (!benign) {
      getLogger().error({ err: error, consultationId }, 'could not request a refund on expiry');
    }
  }
}
