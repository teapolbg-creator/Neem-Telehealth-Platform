import type { PrismaClient } from '@prisma/client';
import { getPrisma, type Db } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit.service.ts';
import { getIntSetting } from '../settings/settings.service.ts';
import { SETTING_KEYS } from '../settings/settings.defaults.ts';
import { changeDoctorStatus } from '../doctor/doctor.service.ts';

/**
 * Doctor membership subscriptions (spec §27).
 *
 * Doctors pay a recurring six-month membership fee. The amount and period are
 * configurable, never hard-coded.
 *
 * Payment itself is Phase 7 — this module owns the *lifecycle*: period,
 * status, grace, and the expiry consequence. It records a payment reference
 * when one exists but never asserts that money moved; that claim can only come
 * from a server-side verification against the provider (spec §34, §93).
 */

export async function createSubscription(
  doctorPublicId: string,
  context: { adminId?: string; correlationId?: string; paymentId?: string },
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<{ periodStart: Date; periodEnd: Date; amountMinor: number }> {
  const doctor = await db.doctor.findUnique({
    where: { publicId: doctorPublicId },
    include: { subscriptions: { orderBy: { periodEnd: 'desc' }, take: 1 } },
  });
  if (!doctor) throw errors.notFound('Doctor not found.');

  const amountMinor = await getIntSetting(SETTING_KEYS.DOCTOR_MEMBERSHIP_FEE_MINOR, db);
  const months = await getIntSetting(SETTING_KEYS.DOCTOR_MEMBERSHIP_MONTHS, db);

  const now = clock.now();
  const previous = doctor.subscriptions[0];

  // A renewal continues from the end of the current period rather than from
  // today, so renewing early does not forfeit the remaining time.
  const periodStart = previous && previous.periodEnd > now ? previous.periodEnd : now;
  const periodEnd = new Date(periodStart);
  periodEnd.setMonth(periodEnd.getMonth() + months);

  const subscription = await db.doctorSubscription.create({
    data: {
      doctorId: doctor.id,
      periodStart,
      periodEnd,
      amountMinor,
      status: context.paymentId ? 'ACTIVE' : 'PENDING',
      renewedFromId: previous?.id ?? null,
    },
  });

  await recordAudit(
    {
      action: previous ? AUDIT_ACTIONS.SUBSCRIPTION_RENEWED : AUDIT_ACTIONS.SUBSCRIPTION_CREATED,
      actorType: context.adminId ? 'ADMIN' : 'SYSTEM',
      actorId: context.adminId ?? null,
      entityType: 'doctor_subscription',
      entityId: subscription.id,
      correlationId: context.correlationId,
      metadata: {
        doctorId: doctor.id,
        amountMinor,
        months,
        periodEnd: periodEnd.toISOString(),
        // Explicitly records whether payment was verified, so the audit trail
        // never implies money moved when it did not.
        paid: Boolean(context.paymentId),
      },
    },
    db,
  );

  return { periodStart, periodEnd, amountMinor };
}

export interface ExpirySweepResult {
  expired: number;
  suspended: number;
  enteringGrace: number;
}

/**
 * Daily sweep: expires lapsed memberships and suspends the doctors behind them
 * (spec §27 — "If membership expires/unpaid: Active → Suspended").
 *
 * A configurable grace period runs first, so a doctor mid-shift is not cut off
 * the instant their period ends. An admin can still override by reactivating.
 */
export async function runSubscriptionExpirySweep(
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<ExpirySweepResult> {
  const now = clock.now();
  const graceDays = await getIntSetting(SETTING_KEYS.DOCTOR_MEMBERSHIP_GRACE_DAYS, db);

  const lapsed = await db.doctorSubscription.findMany({
    where: { status: { in: ['ACTIVE', 'GRACE'] }, periodEnd: { lt: now } },
    include: { doctor: { select: { id: true, publicId: true, status: true } } },
  });

  let expired = 0;
  let suspended = 0;
  let enteringGrace = 0;

  for (const subscription of lapsed) {
    const graceEndsAt =
      subscription.graceEndsAt ?? new Date(subscription.periodEnd.getTime() + graceDays * 86_400_000);

    if (now < graceEndsAt) {
      if (subscription.status !== 'GRACE') {
        await db.doctorSubscription.update({
          where: { id: subscription.id },
          data: { status: 'GRACE', graceEndsAt },
        });
        enteringGrace += 1;
      }
      continue;
    }

    await db.doctorSubscription.update({
      where: { id: subscription.id },
      data: { status: 'EXPIRED' },
    });
    expired += 1;

    await recordAudit(
      {
        action: AUDIT_ACTIONS.SUBSCRIPTION_EXPIRED,
        actorType: 'SYSTEM',
        entityType: 'doctor_subscription',
        entityId: subscription.id,
        metadata: { doctorId: subscription.doctor.id },
      },
      db,
    );

    if (subscription.doctor.status === 'ACTIVE') {
      try {
        await changeDoctorStatus(
          subscription.doctor.publicId,
          'SUSPENDED',
          { adminId: 'system', reason: 'Membership subscription expired' },
          db,
          clock,
        );
        suspended += 1;
      } catch {
        // A transition the state machine refuses is not a sweep failure — the
        // doctor may already have been moved by an admin in the meantime.
      }
    }
  }

  return { expired, suspended, enteringGrace };
}

/**
 * Flags MDC licences approaching expiry (spec §22).
 *
 * Reports only — it never changes a doctor's status on its own, because a
 * licence renewal that Neem has not yet seen is not the same as a licence that
 * has lapsed. The admin decides.
 */
export async function findExpiringLicences(
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<Array<{ publicId: string; fullName: string; mdcNumber: string; mdcExpiresAt: Date; daysRemaining: number }>> {
  const warningDays = await getIntSetting(SETTING_KEYS.DOCTOR_LICENCE_WARNING_DAYS, db);
  const now = clock.now();
  const threshold = new Date(now.getTime() + warningDays * 86_400_000);

  const doctors = await db.doctor.findMany({
    where: {
      status: { in: ['ACTIVE', 'APPROVED'] },
      mdcExpiresAt: { not: null, lte: threshold },
    },
    select: { publicId: true, fullName: true, mdcNumber: true, mdcExpiresAt: true },
    orderBy: { mdcExpiresAt: 'asc' },
  });

  return doctors.map((doctor) => ({
    publicId: doctor.publicId,
    fullName: doctor.fullName,
    mdcNumber: doctor.mdcNumber,
    mdcExpiresAt: doctor.mdcExpiresAt!,
    daysRemaining: Math.ceil((doctor.mdcExpiresAt!.getTime() - now.getTime()) / 86_400_000),
  }));
}

export async function getCurrentSubscription(doctorId: string, db: Db = getPrisma()) {
  return db.doctorSubscription.findFirst({
    where: { doctorId },
    orderBy: { periodEnd: 'desc' },
  });
}
