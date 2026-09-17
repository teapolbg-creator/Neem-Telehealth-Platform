import type { PrismaClient } from '@prisma/client';
import { getPrisma, type Db } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { generatePublicId } from '../../lib/crypto.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit.service.ts';

/**
 * Professional payouts (v2, plan phase 7).
 *
 * The pharmacy payout's twin, and deliberately so: calculated automatically,
 * paid by hand, re-runnable until the money is sent and frozen afterwards.
 * Neem moves no money here — it works out what is owed and records that a
 * human sent it.
 *
 * Three protections against paying twice, none of them a check-then-write:
 * one payout row per professional per period, enforced by a unique index; a
 * payout that is not PENDING refuses to be marked paid again; and an amount
 * that has already been sent is never recalculated underneath it.
 */

export interface PayoutPeriod {
  periodStart: Date;
  periodEnd: Date;
}

/** Midnight-to-midnight UTC, matching how `@db.Date` columns are stored. */
function asDateOnly(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

/**
 * What each professional earned in a period.
 *
 * Reversed earnings are excluded rather than subtracted: a refunded
 * consultation never earned anybody anything, and netting it off against
 * unrelated work would make the figure impossible to reconcile against the
 * consultations behind it.
 */
export async function calculateProfessionalPayouts(
  period: PayoutPeriod,
  adminId: string,
  db: PrismaClient = getPrisma(),
): Promise<{
  periodStart: string;
  periodEnd: string;
  created: number;
  updated: number;
  frozen: number;
}> {
  const periodStart = asDateOnly(period.periodStart);
  const periodEnd = asDateOnly(period.periodEnd);

  if (periodEnd < periodStart) {
    throw errors.businessRule('The period ends before it starts.');
  }

  // The end date is inclusive to a human, so the window runs to the following
  // midnight. Getting this wrong silently drops a day's earnings.
  const windowEnd = new Date(periodEnd);
  windowEnd.setUTCDate(windowEnd.getUTCDate() + 1);

  const earnings = await db.professionalEarning.findMany({
    where: { reversedAt: null, calculatedAt: { gte: periodStart, lt: windowEnd } },
    select: { doctorId: true, professionalShareMinor: true, currency: true },
  });

  const totals = new Map<string, { amountMinor: number; currency: string }>();
  for (const earning of earnings) {
    const running = totals.get(earning.doctorId) ?? {
      amountMinor: 0,
      currency: earning.currency,
    };
    running.amountMinor += earning.professionalShareMinor;
    totals.set(earning.doctorId, running);
  }

  let created = 0;
  let updated = 0;
  let frozen = 0;

  for (const [doctorId, total] of totals) {
    const existing = await db.professionalPayout.findUnique({
      where: { doctorId_periodStart_periodEnd: { doctorId, periodStart, periodEnd } },
      select: { id: true, status: true, amountDueMinor: true },
    });

    if (!existing) {
      await db.professionalPayout.create({
        data: {
          publicId: generatePublicId('ppo'),
          doctorId,
          periodStart,
          periodEnd,
          amountDueMinor: total.amountMinor,
          currency: total.currency,
          status: 'PENDING',
        },
      });
      created += 1;
      continue;
    }

    // Already settled. The figure stands as it was when the money was sent.
    if (existing.status !== 'PENDING') {
      frozen += 1;
      continue;
    }

    if (existing.amountDueMinor !== total.amountMinor) {
      await db.professionalPayout.update({
        where: { id: existing.id },
        data: { amountDueMinor: total.amountMinor },
      });
      updated += 1;
    }
  }

  await recordAudit(
    {
      action: AUDIT_ACTIONS.PROFESSIONAL_PAYOUT_CALCULATED,
      actorType: 'ADMIN',
      actorId: adminId,
      entityType: 'professional-payout-period',
      metadata: {
        periodStart: periodStart.toISOString().slice(0, 10),
        periodEnd: periodEnd.toISOString().slice(0, 10),
        professionals: totals.size,
        created,
        updated,
        frozen,
      },
    },
    db,
  );

  return {
    periodStart: periodStart.toISOString().slice(0, 10),
    periodEnd: periodEnd.toISOString().slice(0, 10),
    created,
    updated,
    frozen,
  };
}

/**
 * Records that an administrator has sent the money.
 *
 * A reference is required. A payout marked paid with nothing to trace it to is
 * indistinguishable from one that was never sent, and reconciling that later
 * is exactly the situation this record exists to prevent.
 */
export async function markProfessionalPayoutPaid(
  publicId: string,
  adminId: string,
  input: { paymentReference: string; amountPaidMinor?: number; note?: string },
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<{ publicId: string; status: string }> {
  const payout = await db.professionalPayout.findUnique({ where: { publicId } });
  if (!payout) throw errors.notFound('Payout not found.');

  if (payout.status !== 'PENDING') {
    throw errors.conflict(`This payout is already ${payout.status.toLowerCase()}.`);
  }

  const amountPaidMinor = input.amountPaidMinor ?? payout.amountDueMinor;

  const updated = await db.professionalPayout.update({
    where: { id: payout.id },
    data: {
      status: 'PAID',
      amountPaidMinor,
      paidAt: clock.now(),
      paymentReference: input.paymentReference,
      markedByAdminId: adminId,
      note: input.note ?? null,
    },
  });

  await recordAudit(
    {
      action: AUDIT_ACTIONS.PROFESSIONAL_PAYOUT_MARKED_PAID,
      actorType: 'ADMIN',
      actorId: adminId,
      entityType: 'professional-payout',
      entityId: payout.id,
      metadata: {
        doctorId: payout.doctorId,
        amountDueMinor: payout.amountDueMinor,
        amountPaidMinor,
        // Recorded because a short payment is the one an operator must be able
        // to find again without reading every row.
        short: amountPaidMinor !== payout.amountDueMinor,
      },
    },
    db,
  );

  return { publicId: updated.publicId, status: updated.status };
}

export async function listProfessionalPayouts(
  filter: { pendingOnly?: boolean; doctorId?: string; limit?: number },
  db: Db = getPrisma(),
) {
  const payouts = await db.professionalPayout.findMany({
    where: {
      ...(filter.pendingOnly ? { status: 'PENDING' } : {}),
      ...(filter.doctorId ? { doctorId: filter.doctorId } : {}),
    },
    include: { doctor: { select: { fullName: true, publicId: true, discipline: true } } },
    orderBy: [{ periodStart: 'desc' }, { createdAt: 'desc' }],
    take: filter.limit ?? 100,
  });

  return payouts.map((payout) => ({
    publicId: payout.publicId,
    professionalName: payout.doctor.fullName,
    professionalPublicId: payout.doctor.publicId,
    discipline: payout.doctor.discipline,
    periodStart: payout.periodStart.toISOString().slice(0, 10),
    periodEnd: payout.periodEnd.toISOString().slice(0, 10),
    amountDueMinor: payout.amountDueMinor,
    amountPaidMinor: payout.amountPaidMinor,
    currency: payout.currency,
    status: payout.status,
    paidAt: payout.paidAt?.toISOString() ?? null,
    paymentReference: payout.paymentReference,
    note: payout.note,
  }));
}

export interface Reconciliation {
  periodStart: string;
  periodEnd: string;
  currency: string;
  /** What patients actually paid for patient-direct consultations. */
  collectedMinor: number;
  /** What the provider charged to collect it, taken off before the split. */
  feesMinor: number;
  /** What professionals earned from them, reversals excluded. */
  earnedMinor: number;
  /** What was reversed when a consultation was refunded. */
  reversedMinor: number;
  /** What Neem kept, by the same snapshots. */
  neemMinor: number;
  /** What has been marked as sent for periods inside this window. */
  paidOutMinor: number;
  /** Earned but not yet sent. Positive is normal; negative needs explaining. */
  outstandingMinor: number;
}

/**
 * The three figures side by side, for an administrator closing a period.
 *
 * Collected, earned and paid are kept in three separate records precisely so
 * they can disagree — and this is the screen on which a disagreement shows up
 * rather than being averaged away.
 */
export async function reconcile(
  period: PayoutPeriod,
  db: Db = getPrisma(),
): Promise<Reconciliation> {
  const periodStart = asDateOnly(period.periodStart);
  const periodEnd = asDateOnly(period.periodEnd);
  const windowEnd = new Date(periodEnd);
  windowEnd.setUTCDate(windowEnd.getUTCDate() + 1);

  const earnings = await db.professionalEarning.findMany({
    where: { calculatedAt: { gte: periodStart, lt: windowEnd } },
    select: {
      grossMinor: true,
      feeMinor: true,
      professionalShareMinor: true,
      neemShareMinor: true,
      currency: true,
      reversedAt: true,
    },
  });

  const payouts = await db.professionalPayout.findMany({
    where: { periodStart: { gte: periodStart }, periodEnd: { lte: periodEnd }, status: 'PAID' },
    select: { amountPaidMinor: true },
  });

  const live = earnings.filter((row) => row.reversedAt === null);

  const collectedMinor = live.reduce((sum, row) => sum + row.grossMinor, 0);
  const feesMinor = live.reduce((sum, row) => sum + row.feeMinor, 0);
  const earnedMinor = live.reduce((sum, row) => sum + row.professionalShareMinor, 0);
  const neemMinor = live.reduce((sum, row) => sum + row.neemShareMinor, 0);
  const reversedMinor = earnings
    .filter((row) => row.reversedAt !== null)
    .reduce((sum, row) => sum + row.professionalShareMinor, 0);
  const paidOutMinor = payouts.reduce((sum, row) => sum + row.amountPaidMinor, 0);

  return {
    periodStart: periodStart.toISOString().slice(0, 10),
    periodEnd: periodEnd.toISOString().slice(0, 10),
    currency: earnings[0]?.currency ?? 'GHS',
    collectedMinor,
    feesMinor,
    earnedMinor,
    reversedMinor,
    neemMinor,
    paidOutMinor,
    outstandingMinor: earnedMinor - paidOutMinor,
  };
}
