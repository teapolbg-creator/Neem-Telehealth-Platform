import type { PrismaClient } from '@prisma/client';
import { getPrisma, type Db } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
import { getIntSetting } from '../settings/settings.service.ts';
import { SETTING_KEYS } from '../settings/settings.defaults.ts';
import { doctorCanReceiveConsultations } from '../../domain/account-state.ts';

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
  await db.$executeRawUnsafe(
    'UPDATE doctor_presence SET currentLoad = GREATEST(currentLoad - 1, 0) WHERE doctorId = ?',
    doctorId,
  );
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
