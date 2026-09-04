import type { PrismaClient } from '@prisma/client';
import { notify, notifyOnce } from '../notification/notification.service.ts';
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
  warned: number;
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
      subscription.graceEndsAt ??
      new Date(subscription.periodEnd.getTime() + graceDays * 86_400_000);

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

        // Suspension arrived silently until Phase 11: the account stopped
        // receiving consultations and nothing said why. Sent after the status
        // change succeeds, so a refused transition does not produce a message
        // about a suspension that did not happen.
        void notify({
          templateCode: 'doctor.membership.suspended',
          recipient: { type: 'DOCTOR', doctorId: subscription.doctor.id },
        });
      } catch {
        // A transition the state machine refuses is not a sweep failure — the
        // doctor may already have been moved by an admin in the meantime.
      }
    }
  }

  const warned = await warnExpiringMemberships(db, clock);

  return { expired, suspended, enteringGrace, warned };
}

/**
 * Warns doctors whose membership is about to end.
 *
 * The sweep above handles a membership that has already lapsed. This is the
 * message that should have come first — an advance warning, so that expiry is
 * something a doctor can prevent rather than something they discover when
 * consultations stop arriving.
 *
 * Deduped over the warning window, because the condition stays true every day
 * until the period ends and this job runs hourly. A doctor warned once acts on
 * it; a doctor warned two hundred times filters the sender.
 */
async function warnExpiringMemberships(db: PrismaClient, clock: Clock): Promise<number> {
  const warningDays = await getIntSetting(SETTING_KEYS.DOCTOR_MEMBERSHIP_WARNING_DAYS, db);
  const now = clock.now();
  const threshold = new Date(now.getTime() + warningDays * 86_400_000);

  const ending = await db.doctorSubscription.findMany({
    where: { status: 'ACTIVE', periodEnd: { gt: now, lte: threshold } },
    select: { doctorId: true, periodEnd: true },
  });

  let warned = 0;

  for (const subscription of ending) {
    const sent = await notifyOnce(
      {
        templateCode: 'doctor.membership.expiring',
        recipient: { type: 'DOCTOR', doctorId: subscription.doctorId },
        variables: { periodEnd: subscription.periodEnd.toISOString().slice(0, 10) },
      },
      { withinDays: warningDays },
      db,
      clock,
    );
    if (sent) warned += 1;
  }

  return warned;
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
): Promise<
  Array<{
    publicId: string;
    fullName: string;
    mdcNumber: string;
    mdcExpiresAt: Date;
    daysRemaining: number;
  }>
> {
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

/**
 * Warns doctors whose MDC licence is approaching expiry (spec §22).
 *
 * Everything for this existed except the thing that sends it: a warning
 * threshold in settings, a query, an audit action reserved for it, and a
 * written message. What that adds up to is a warning an administrator has to
 * remember to look for, rather than one the doctor receives — and the doctor
 * is the only person who can do anything about it.
 *
 * Without it, a doctor discovers their licence has lapsed when a prescription
 * is refused mid-consultation, with a patient in front of them. That is the
 * worst possible moment to find out, and it is the moment the product chose
 * by default.
 *
 * Reports only. It never changes a doctor's status: a renewal Neem has not
 * seen yet is not the same as a licence that has lapsed, and that judgement
 * stays with an administrator.
 */
export async function warnExpiringLicences(
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<number> {
  const expiring = await findExpiringLicences(db, clock);
  const warningDays = await getIntSetting(SETTING_KEYS.DOCTOR_LICENCE_WARNING_DAYS, db);

  let warned = 0;

  for (const doctor of expiring) {
    const record = await db.doctor.findUnique({
      where: { publicId: doctor.publicId },
      select: { id: true },
    });
    if (!record) continue;

    /**
     * Once per warning window, not once per run.
     *
     * The window is 60 days by default and this runs daily, so an
     * un-deduplicated warning would arrive sixty times about one licence. A
     * doctor who receives that learns to ignore the sender, which costs more
     * than the warning was worth.
     */
    const sent = await notifyOnce(
      {
        templateCode: 'doctor.licence.expiring',
        recipient: { type: 'DOCTOR', doctorId: record.id },
        variables: { expiresAt: doctor.mdcExpiresAt.toISOString().slice(0, 10) },
      },
      { withinDays: Math.max(1, Math.floor(warningDays / 2)) },
      db,
      clock,
    );

    if (!sent) continue;
    warned += 1;

    await recordAudit(
      {
        action: AUDIT_ACTIONS.DOCTOR_LICENCE_EXPIRING,
        actorType: 'SYSTEM',
        entityType: 'doctor',
        entityId: record.id,
        // A date and a count of days. Never the licence number.
        metadata: { daysRemaining: doctor.daysRemaining },
      },
      db,
    );
  }

  return warned;
}

export async function getCurrentSubscription(doctorId: string, db: Db = getPrisma()) {
  return db.doctorSubscription.findFirst({
    where: { doctorId },
    orderBy: { periodEnd: 'desc' },
  });
}
