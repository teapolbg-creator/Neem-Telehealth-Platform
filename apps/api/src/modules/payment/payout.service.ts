import type { PrismaClient } from '@prisma/client';
import { getPrisma, type Db } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { generatePublicId } from '../../lib/crypto.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit.service.ts';

/**
 * Pharmacy payouts (spec §40, docs/payment-flow.md §6).
 *
 * Calculated automatically, paid by hand. Neem holds the money and settles
 * with pharmacies out of band during the MVP, so nothing in this module moves
 * funds — it works out what is owed, and records that a human sent it.
 *
 * The calculation is deliberately re-runnable. A period can be recalculated as
 * late allocations land or refunds reverse them, and the figure updates,
 * **until** the payout has been marked paid. After that the amount is frozen:
 * an amount someone has already transferred cannot be quietly rewritten
 * underneath them, and a later correction is a new period's adjustment rather
 * than an edit to history.
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
 * What each pharmacy earned in a period.
 *
 * Reversed allocations are excluded rather than subtracted: a refunded
 * consultation never earned the pharmacy anything, and netting it off against
 * unrelated earnings would make the figure impossible to reconcile against the
 * consultations behind it.
 */
export async function calculatePayouts(
  period: PayoutPeriod,
  adminId: string,
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<{ periodStart: string; periodEnd: string; created: number; updated: number; frozen: number }> {
  const periodStart = asDateOnly(period.periodStart);
  const periodEnd = asDateOnly(period.periodEnd);

  if (periodEnd < periodStart) {
    throw errors.businessRule('The period ends before it starts.');
  }

  // The end date is inclusive to a human, so the window runs to the following
  // midnight. Getting this wrong silently drops a day's earnings.
  const windowEnd = new Date(periodEnd);
  windowEnd.setUTCDate(windowEnd.getUTCDate() + 1);

  const allocations = await db.revenueAllocation.findMany({
    where: {
      reversedAt: null,
      calculatedAt: { gte: periodStart, lt: windowEnd },
    },
    select: {
      pharmacyShareMinor: true,
      currency: true,
      consultation: { select: { pharmacyId: true } },
    },
  });

  const totals = new Map<string, { amountMinor: number; currency: string }>();
  for (const allocation of allocations) {
    const pharmacyId = allocation.consultation.pharmacyId;
    const running = totals.get(pharmacyId) ?? { amountMinor: 0, currency: allocation.currency };
    running.amountMinor += allocation.pharmacyShareMinor;
    totals.set(pharmacyId, running);
  }

  const now = clock.now();
  let created = 0;
  let updated = 0;
  let frozen = 0;

  for (const [pharmacyId, total] of totals) {
    const existing = await db.pharmacyPayout.findUnique({
      where: { pharmacyId_periodStart_periodEnd: { pharmacyId, periodStart, periodEnd } },
      select: { id: true, status: true, amountDueMinor: true },
    });

    if (!existing) {
      await db.pharmacyPayout.create({
        data: {
          publicId: generatePublicId('pay'),
          pharmacyId,
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
      await db.pharmacyPayout.update({
        where: { id: existing.id },
        data: { amountDueMinor: total.amountMinor },
      });
      updated += 1;
    }
  }

  await recordAudit(
    {
      action: AUDIT_ACTIONS.PAYOUT_CALCULATED,
      actorType: 'ADMIN',
      actorId: adminId,
      entityType: 'payout-period',
      metadata: {
        periodStart: periodStart.toISOString().slice(0, 10),
        periodEnd: periodEnd.toISOString().slice(0, 10),
        pharmacies: totals.size,
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
 * is exactly the situation this record exists to prevent (spec §40).
 */
export async function markPayoutPaid(
  publicId: string,
  adminId: string,
  input: { paymentReference: string; amountPaidMinor?: number; note?: string },
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<{ publicId: string; status: string }> {
  const payout = await db.pharmacyPayout.findUnique({ where: { publicId } });
  if (!payout) throw errors.notFound('Payout not found.');

  if (payout.status !== 'PENDING') {
    throw errors.conflict(`This payout is already ${payout.status.toLowerCase()}.`);
  }

  const amountPaidMinor = input.amountPaidMinor ?? payout.amountDueMinor;

  const updated = await db.pharmacyPayout.update({
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
      action: AUDIT_ACTIONS.PAYOUT_MARKED_PAID,
      actorType: 'ADMIN',
      actorId: adminId,
      entityType: 'payout',
      entityId: payout.id,
      metadata: {
        pharmacyId: payout.pharmacyId,
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

export interface PayoutListItem {
  publicId: string;
  pharmacyName: string;
  pharmacyPublicId: string;
  periodStart: string;
  periodEnd: string;
  amountDueMinor: number;
  amountPaidMinor: number;
  currency: string;
  status: string;
  paidAt: string | null;
  paymentReference: string | null;
  note: string | null;
}

export async function listPayouts(
  filter: { pendingOnly?: boolean; pharmacyId?: string; limit?: number },
  db: Db = getPrisma(),
): Promise<PayoutListItem[]> {
  const payouts = await db.pharmacyPayout.findMany({
    where: {
      ...(filter.pendingOnly ? { status: 'PENDING' } : {}),
      ...(filter.pharmacyId ? { pharmacyId: filter.pharmacyId } : {}),
    },
    include: { pharmacy: { select: { name: true, publicId: true } } },
    orderBy: [{ periodStart: 'desc' }, { createdAt: 'desc' }],
    take: filter.limit ?? 100,
  });

  return payouts.map((payout) => ({
    publicId: payout.publicId,
    pharmacyName: payout.pharmacy.name,
    pharmacyPublicId: payout.pharmacy.publicId,
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

/**
 * A pharmacy's own earnings (spec §40, permission `finance:read-own`).
 *
 * Its share only. A pharmacy is never shown Neem's share or another
 * pharmacy's, and the figures come from the allocations rather than from the
 * consultation price, so a refund is reflected without a second calculation
 * having to remember to subtract it.
 */
export async function pharmacyEarnings(
  pharmacyId: string,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<{
  currency: string;
  allTimeMinor: number;
  last30DaysMinor: number;
  consultations30Days: number;
  awaitingPayoutMinor: number;
  payouts: PayoutListItem[];
}> {
  const since = new Date(clock.now().getTime() - 30 * 86_400_000);

  const allocations = await db.revenueAllocation.findMany({
    where: { reversedAt: null, consultation: { pharmacyId } },
    select: { pharmacyShareMinor: true, currency: true, calculatedAt: true },
  });

  const allTimeMinor = allocations.reduce((sum, row) => sum + row.pharmacyShareMinor, 0);
  const recent = allocations.filter((row) => row.calculatedAt >= since);

  const paidOut = await db.pharmacyPayout.aggregate({
    where: { pharmacyId, status: { in: ['PAID', 'RECONCILED'] } },
    _sum: { amountPaidMinor: true },
  });

  return {
    currency: allocations[0]?.currency ?? 'GHS',
    allTimeMinor,
    last30DaysMinor: recent.reduce((sum, row) => sum + row.pharmacyShareMinor, 0),
    consultations30Days: recent.length,
    // Everything earned that has not yet been settled, however the periods
    // happen to have been cut.
    awaitingPayoutMinor: allTimeMinor - (paidOut._sum.amountPaidMinor ?? 0),
    payouts: await listPayouts({ pharmacyId, limit: 24 }, db),
  };
}
