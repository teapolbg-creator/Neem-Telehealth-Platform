import type { PrismaClient } from '@prisma/client';
import { getPrisma, isUniqueConstraintError, type Db } from '../../db/prisma.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
import { getLogger } from '../../lib/logger.ts';
import { splitRevenue } from '../../lib/money.ts';
import { getBooleanSetting, getIntSetting } from '../settings/settings.service.ts';
import { SETTING_KEYS } from '../settings/settings.defaults.ts';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit.service.ts';

/**
 * What a professional earned, one consultation at a time (v2, plan phase 7).
 *
 * Three separate records, deliberately: `Payment` is what the patient paid,
 * `ProfessionalEarning` is what somebody earned by doing the work, and
 * `ProfessionalPayout` is what Neem actually sent. Collapsing any two of them
 * makes it impossible to say which one went wrong.
 *
 * **Nothing is recorded until the split is agreed.** The share has no honest
 * default: a number invented in code is a number a real person is paid. So the
 * switch below is off, the share is zero, and this module writes nothing at
 * all until an administrator has set both — see `assertEarningsConfigured`.
 *
 * Earnings are recorded at **completion**, not at settlement. When the money
 * clears, an immediate consultation has no professional yet; whoever completed
 * it is who earned it.
 *
 * The split is applied to what is left after the provider's fee, so both
 * parties carry the cost of collecting the money. The fee is whatever the
 * provider reported on the payment; when it reported none, the fee is zero and
 * the earning says so, rather than a missing figure being quietly assumed.
 */

/**
 * Only patient-direct consultations earn a share.
 *
 * Counter consultations are worked by salaried doctors and paid through
 * payroll (spec §26); recording a share for one as well would pay for the same
 * hour twice. Whether that arrangement should change is business decision §7.6
 * and is not something this module may assume.
 */
export async function recordEarning(
  consultationId: string,
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<boolean> {
  if (!(await getBooleanSetting(SETTING_KEYS.REVENUE_PROFESSIONAL_EARNINGS_ENABLED, db))) {
    return false;
  }

  const shareBp = await getIntSetting(SETTING_KEYS.REVENUE_PROFESSIONAL_BP, db);
  if (shareBp <= 0) {
    // Switched on without a share. Loud, not silent: somebody is working
    // without being credited, and that is not a thing to discover later.
    getLogger().error(
      { consultationId },
      'professional earnings are enabled but the share is not set',
    );
    return false;
  }

  const consultation = await db.consultation.findUnique({
    where: { id: consultationId },
    select: {
      id: true,
      channel: true,
      doctorId: true,
      netMinor: true,
      currency: true,
      doctor: { select: { discipline: true } },
      payments: {
        where: { status: 'SUCCESS' },
        orderBy: { paidAt: 'desc' },
        take: 1,
        select: { id: true, feeMinor: true, amountMinor: true },
      },
    },
  });

  if (!consultation) return false;
  if (consultation.channel !== 'DIRECT') return false;
  if (!consultation.doctorId || !consultation.doctor) return false;

  const payment = consultation.payments[0];
  if (!payment) return false;

  /*
   * The fee comes off first, so the cost of collecting the money is shared
   * rather than carried by Neem alone. A payment the provider told us nothing
   * about is split on the gross and says `feeMinor: 0`, which a reconciliation
   * can see; it is never a silently assumed zero inside an arithmetic.
   */
  const feeMinor = Math.min(payment.feeMinor ?? 0, consultation.netMinor);
  if (payment.feeMinor === null) {
    getLogger().warn(
      { consultationId, paymentId: payment.id },
      'no provider fee recorded; splitting the gross',
    );
  }

  const netMinor = consultation.netMinor - feeMinor;

  /*
   * The platform's one split function, invariant and rounding included. Its
   * fields say "pharmacy" because a pharmacy was the only counterparty when it
   * was written; the arithmetic is the same arithmetic.
   */
  const { pharmacyShareMinor: professionalShareMinor, neemShareMinor } = splitRevenue(
    netMinor,
    shareBp,
    consultation.currency,
  );

  try {
    const earning = await db.professionalEarning.create({
      data: {
        consultationId: consultation.id,
        paymentId: payment.id,
        doctorId: consultation.doctorId,
        grossMinor: consultation.netMinor,
        feeMinor,
        netMinor,
        professionalSharePctBp: shareBp,
        professionalShareMinor,
        neemShareMinor,
        currency: consultation.currency,
        discipline: consultation.doctor.discipline,
        calculatedAt: clock.now(),
      },
    });

    await recordAudit(
      {
        action: AUDIT_ACTIONS.EARNING_RECORDED,
        actorType: 'SYSTEM',
        entityType: 'professional-earning',
        entityId: earning.id,
        metadata: {
          doctorId: consultation.doctorId,
          grossMinor: earning.grossMinor,
          feeMinor: earning.feeMinor,
          netMinor: earning.netMinor,
          professionalShareMinor: earning.professionalShareMinor,
          professionalSharePctBp: shareBp,
        },
      },
      db,
    );

    return true;
  } catch (error) {
    // UNIQUE(consultationId) and UNIQUE(paymentId) — already earned. That is
    // the constraint doing its job, not a failure.
    if (isUniqueConstraintError(error)) return false;
    throw error;
  }
}

/**
 * Marks an earning as never earned after all.
 *
 * The row stays, exactly as a reversed revenue allocation does: deleting it
 * would leave a payout that was already calculated from it unexplainable.
 */
export async function reverseEarning(
  consultationId: string,
  at: Date,
  db: Db = getPrisma(),
): Promise<void> {
  await db.professionalEarning.updateMany({
    where: { consultationId, reversedAt: null },
    data: { reversedAt: at },
  });
}

export interface EarningStatement {
  currency: string;
  periodStart: string;
  periodEnd: string;
  totalMinor: number;
  consultations: number;
  lines: Array<{
    consultationReference: string;
    completedAt: string | null;
    grossMinor: number;
    /** Taken off before the share was worked out. */
    feeMinor: number;
    netMinor: number;
    sharePctBp: number;
    shareMinor: number;
    reversed: boolean;
  }>;
}

/**
 * A professional's own statement.
 *
 * Every line, including the reversed ones. A refunded consultation is shown as
 * reversed rather than quietly removed: somebody who remembers doing the
 * consultation should be able to see what happened to it, rather than find a
 * total that does not add up to their week.
 */
export async function earningStatement(
  doctorId: string,
  period: { from: Date; to: Date },
  db: Db = getPrisma(),
): Promise<EarningStatement> {
  const rows = await db.professionalEarning.findMany({
    where: { doctorId, calculatedAt: { gte: period.from, lt: period.to } },
    include: { consultation: { select: { publicId: true, completedAt: true } } },
    orderBy: { calculatedAt: 'desc' },
  });

  const earned = rows.filter((row) => row.reversedAt === null);

  return {
    currency: rows[0]?.currency ?? 'GHS',
    periodStart: period.from.toISOString(),
    periodEnd: period.to.toISOString(),
    totalMinor: earned.reduce((sum, row) => sum + row.professionalShareMinor, 0),
    consultations: earned.length,
    lines: rows.map((row) => ({
      consultationReference: row.consultation.publicId,
      completedAt: row.consultation.completedAt?.toISOString() ?? null,
      grossMinor: row.grossMinor,
      feeMinor: row.feeMinor,
      netMinor: row.netMinor,
      sharePctBp: row.professionalSharePctBp,
      shareMinor: row.professionalShareMinor,
      reversed: row.reversedAt !== null,
    })),
  };
}
