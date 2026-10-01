import type { PrismaClient } from '@prisma/client';
import { getPrisma, type Db } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { getLogger } from '../../lib/logger.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
import { getIntSetting } from '../settings/settings.service.ts';
import { SETTING_KEYS } from '../settings/settings.defaults.ts';
import { doctorCanReceiveConsultations } from '../../domain/account-state.ts';
import { OCCUPYING_CONSULTATION_STATES } from '../../domain/consultation-state.ts';

/**
 * Doctor presence (spec §24, §31).
 *
 * Presence is a *heartbeat*, not a flag. A doctor who closes their laptop
 * without signing out stops sending heartbeats and drops out of allocation
 * within 90 seconds — whereas a boolean "available" flag would leave
 * consultations being offered to an empty chair.
 *
 * Going online is not the same as being eligible. Eligibility also requires an
 * ACTIVE account, a valid licence, a live subscription and a confirmed shift;
 * those are checked by the allocation engine, which is the single place the
 * rules live.
 */

/** A heartbeat older than this means the doctor is gone. */
export const HEARTBEAT_STALE_SECONDS = 90;

export async function goOnline(
  doctorId: string,
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<{ onlineSince: Date; maxLoad: number }> {
  const doctor = await db.doctor.findUnique({
    where: { id: doctorId },
    select: { status: true, mdcExpiresAt: true },
  });
  if (!doctor) throw errors.notFound('Doctor not found.');

  if (!doctorCanReceiveConsultations(doctor.status)) {
    throw errors.businessRule(
      `Your account is ${doctor.status}. Only active doctors can receive consultations.`,
    );
  }
  if (doctor.mdcExpiresAt && doctor.mdcExpiresAt <= clock.now()) {
    throw errors.businessRule(
      'Your MDC licence has expired. Upload a current licence before going online.',
    );
  }

  const maxLoad = await getIntSetting(SETTING_KEYS.DOCTOR_MAX_CONCURRENT, db);
  const now = clock.now();

  const presence = await db.doctorPresence.upsert({
    where: { doctorId },
    update: { onlineSince: now, lastHeartbeatAt: now, maxLoad },
    create: { doctorId, onlineSince: now, lastHeartbeatAt: now, currentLoad: 0, maxLoad },
  });

  /*
   * Coming online is the moment to believe the consultations over the counter
   * (D59).
   *
   * A slot count that has drifted upwards makes a doctor permanently invisible
   * to allocation, and before this, nothing a doctor could do from their own
   * dashboard fixed it — going offline and back on left the number untouched.
   * Now the one action they would naturally try is the one that repairs it.
   */
  await reconcileDoctorLoad(doctorId, db);

  return { onlineSince: presence.onlineSince ?? now, maxLoad };
}

/**
 * Refreshes the heartbeat.
 *
 * Deliberately does NOT re-run eligibility: a doctor mid-consultation whose
 * subscription lapses should finish that consultation, not be cut off. The
 * allocation engine re-checks eligibility for every offer, which is where it
 * matters.
 */
export async function heartbeat(
  doctorId: string,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<void> {
  await db.doctorPresence.updateMany({
    where: { doctorId },
    data: { lastHeartbeatAt: clock.now() },
  });
}

export async function goOffline(doctorId: string, db: Db = getPrisma()): Promise<void> {
  await db.doctorPresence.updateMany({
    where: { doctorId },
    data: { onlineSince: null, lastHeartbeatAt: null },
  });
}

export interface PresenceView {
  online: boolean;
  onlineSince: string | null;
  currentLoad: number;
  maxLoad: number;
  /** Why the doctor is not eligible right now, for their own screen. */
  blockedBy: string | null;
}

/**
 * The doctor's own availability picture.
 *
 * Tells them plainly why they are not receiving consultations. "You are online
 * but have no confirmed shift covering now" is actionable; silence is not.
 */
export async function getPresence(
  doctorId: string,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<PresenceView> {
  const now = clock.now();
  const serviceDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  const doctor = await db.doctor.findUniqueOrThrow({
    where: { id: doctorId },
    include: {
      presence: true,
      subscriptions: { orderBy: { periodEnd: 'desc' }, take: 1 },
      shiftAssignments: {
        where: { serviceDate, status: 'CONFIRMED' },
        include: { shiftDefinition: true },
      },
    },
  });

  const presence = doctor.presence;
  const staleAfter = new Date(now.getTime() - HEARTBEAT_STALE_SECONDS * 1000);
  const online = Boolean(presence?.lastHeartbeatAt && presence.lastHeartbeatAt >= staleAfter);

  const subscription = doctor.subscriptions[0];
  const hasShift = doctor.shiftAssignments.length > 0;

  const blockedBy = !doctorCanReceiveConsultations(doctor.status)
    ? `Your account is ${doctor.status.toLowerCase()}.`
    : doctor.mdcExpiresAt && doctor.mdcExpiresAt <= now
      ? 'Your MDC licence has expired.'
      : subscription && subscription.status !== 'ACTIVE' && subscription.status !== 'GRACE'
        ? 'Your Neem membership is not active.'
        : !hasShift
          ? 'You have no confirmed shift today.'
          : !online
            ? 'You are offline.'
            : /*
               * Being full is the last reason, and it was missing (D59).
               *
               * A doctor at capacity is skipped by every allocation, and until
               * now their dashboard said nothing at all — it reported them
               * online, on shift and ready while the queue silently passed them
               * over. That is how a drifted count went unnoticed: there was no
               * screen anywhere that would have shown it.
               *
               * It names the number, because "you are already with 1 of 1
               * patients" is checkable against what the doctor knows they are
               * doing. If it says they are with a patient and they are not, that
               * is the bug, visible at last.
               */
              presence && presence.currentLoad >= presence.maxLoad
              ? `You are already with ${presence.currentLoad} of ${presence.maxLoad} patients, so no new consultation will be offered until one is finished.`
              : null;

  return {
    online,
    onlineSince: presence?.onlineSince?.toISOString() ?? null,
    currentLoad: presence?.currentLoad ?? 0,
    maxLoad: presence?.maxLoad ?? 1,
    blockedBy,
  };
}

/** Releases a doctor's capacity when a consultation ends. */
export async function releaseCapacity(doctorId: string, db: Db = getPrisma()): Promise<void> {
  // Quoted identifiers and a $1 placeholder — see the note in
  // scheduling.service.ts. GREATEST is spelled the same in both.
  await db.$executeRawUnsafe(
    'UPDATE doctor_presence SET "currentLoad" = GREATEST("currentLoad" - 1, 0) WHERE "doctorId" = $1',
    doctorId,
  );
}

/**
 * Takes a doctor's capacity back when an interrupted consultation resumes (D57).
 *
 * The mirror of `releaseCapacity`, and deliberately not a no-op when the
 * doctor is already at their limit: one who took another patient while this
 * one was away is genuinely busy with two, and the count has to say so. What
 * stops the queue handing them a third is that same count.
 */
export async function claimDoctorCapacity(doctorId: string, db: Db = getPrisma()): Promise<void> {
  await db.doctorPresence.updateMany({
    where: { doctorId },
    data: { currentLoad: { increment: 1 } },
  });
}

/**
 * Sets a doctor's slot count to what their consultations actually say (D59).
 *
 * `currentLoad` is a counter that is incremented and decremented, which means it
 * can drift — and a count that drifts **upwards** is silently catastrophic. At
 * the default limit of one concurrent consultation, a single extra increment
 * puts a doctor permanently at capacity: they are skipped by every allocation
 * with the reason AT_CAPACITY, no screen says so, going offline and back online
 * does not clear it, and restarting the API does not either. They simply stop
 * being offered patients, for ever.
 *
 * That is not hypothetical. Before [D57] the count was released only when a
 * consultation crossed into a terminal state, so `DOCTOR_ACCEPTED` to
 * `REASSIGNING` — a reassignment after a doctor had accepted — incremented and
 * never decremented. One of those was enough to retire a doctor from the queue.
 *
 * So the count is treated as a cache of something derivable, and this recomputes
 * it from the only authority there is: the consultations assigned to this doctor
 * that are in a state which occupies them. Called when a doctor comes online,
 * because that is the moment they are asserting they are ready, and from a sweep
 * for anyone who stays online for days.
 *
 * Returns the corrected value, and whether it had to be corrected, so a drift
 * worth investigating can be logged rather than quietly fixed.
 */
export async function reconcileDoctorLoad(
  doctorId: string,
  db: Db = getPrisma(),
): Promise<{ currentLoad: number; corrected: boolean }> {
  const [presence, actual] = await Promise.all([
    db.doctorPresence.findUnique({ where: { doctorId }, select: { currentLoad: true } }),
    db.consultation.count({
      where: { doctorId, state: { in: [...OCCUPYING_CONSULTATION_STATES] } },
    }),
  ]);

  if (!presence) return { currentLoad: actual, corrected: false };
  if (presence.currentLoad === actual) return { currentLoad: actual, corrected: false };

  await db.doctorPresence.update({ where: { doctorId }, data: { currentLoad: actual } });

  return { currentLoad: actual, corrected: true };
}

/**
 * The same correction for everybody who is online (D59).
 *
 * Returns how many counts were wrong, which is a number that should be zero: a
 * non-zero one means something is still leaking a slot, and the sweep is hiding
 * it. That is why it is counted and logged rather than silently repaired.
 */
export async function reconcileOnlineDoctorLoads(db: Db = getPrisma()): Promise<number> {
  const online = await db.doctorPresence.findMany({
    where: { onlineSince: { not: null } },
    select: { doctorId: true },
  });

  let corrected = 0;

  for (const presence of online) {
    try {
      const result = await reconcileDoctorLoad(presence.doctorId, db);
      if (result.corrected) {
        corrected += 1;
        getLogger().warn(
          { doctorId: presence.doctorId, currentLoad: result.currentLoad },
          'corrected a drifted concurrent-consultation count',
        );
      }
    } catch (error) {
      getLogger().error(
        { err: error, doctorId: presence.doctorId },
        'could not reconcile a doctor load',
      );
    }
  }

  return corrected;
}

/**
 * Clears presence for doctors whose heartbeat has stopped.
 *
 * Housekeeping only — allocation already ignores a stale heartbeat, so this
 * exists to keep the admin's "doctors online" count honest rather than to
 * enforce anything.
 */
export async function reapStalePresence(
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<number> {
  const cutoff = new Date(clock.now().getTime() - HEARTBEAT_STALE_SECONDS * 1000);

  const result = await db.doctorPresence.updateMany({
    where: { onlineSince: { not: null }, lastHeartbeatAt: { lt: cutoff } },
    data: { onlineSince: null },
  });

  return result.count;
}
