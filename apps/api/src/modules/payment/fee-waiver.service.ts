import type { Prisma, PrismaClient } from '@prisma/client';
import { getPrisma, isUniqueConstraintError, type Db } from '../../db/prisma.ts';
import { getLogger } from '../../lib/logger.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
import { generatePublicId } from '../../lib/crypto.ts';
import { splitRevenue } from '../../lib/money.ts';
import { recordAudit, AUDIT_ACTIONS } from '../audit/audit.service.ts';
import { transition } from '../consultation/consultation.service.ts';
import { getIntSetting, getBooleanSetting } from '../settings/settings.service.ts';
import { SETTING_KEYS } from '../settings/settings.defaults.ts';

/**
 * Consultations given away during the pilot (D69).
 *
 * Month one of the pilot charges nothing. This is the switch and the path it
 * opens, and the point of both is that **no fee or payment logic is deleted**:
 * `consultation.feeEnabled` goes back to true in month two and the ordinary
 * flow resumes, with no release behind it.
 *
 * **Why the flag is read when a consultation is created, and never later.**
 * "Skip the payment step" is only true at creation. A branch inside
 * `initiatePayment` would leave three clients still calling an endpoint named
 * `/payment` that no longer pays, and would leave a free consultation sitting
 * in PENDING_PAYMENT with a deadline until one of them called — which is how
 * the expiry sweep would have ended it. Deciding at creation also makes "no
 * other path can charge for this" structural rather than another flag check:
 * a waived consultation is ACTIVATED before its creation transaction commits,
 * so `isAwaitingPayment` already refuses an old checkout link, a direct API
 * call and a replayed webhook without consulting any setting.
 *
 * **Why a real Payment row, for nothing.** `RevenueAllocation.paymentId` and
 * `ProfessionalEarning.paymentId` are both NOT NULL. Without a payment row
 * there can be no allocation and no earning, and a free month would leave no
 * ledger at all — no record of who did the work. The row carries
 * `amountMinor: 0` and `isWaived: true`, and everything that would otherwise
 * ask the provider about it knows to skip it.
 *
 * **Why status SUCCESS rather than a new WAIVED status.** SUCCESS means this
 * consultation's fee obligation is settled, which is true. Every existing
 * reader of `status === 'SUCCESS'` — the refund path, the earnings path, both
 * payment-status routes — then keeps working untouched. A new enum value would
 * instead require each of them to learn about it, and on Postgres an enum
 * value cannot be dropped, so it would be the one part of this work that could
 * not be reversed.
 */

/** The only reason a fee is waived today. Stored on the consultation. */
export const FEE_WAIVER_REASONS = {
  PILOT_FREE: 'pilot_free',
} as const;

export type FeeWaiverReason = (typeof FEE_WAIVER_REASONS)[keyof typeof FEE_WAIVER_REASONS];

/**
 * Whether a consultation created right now would be free.
 *
 * Asked once per creation. Callers must not ask it again later and expect the
 * same answer — that is what `Consultation.feeWaivedReason` is for.
 */
export async function isConsultationFeeWaived(db: Db = getPrisma()): Promise<boolean> {
  return !(await getBooleanSetting(SETTING_KEYS.CONSULTATION_FEE_ENABLED, db).catch(() => true));
}

/** A waived payment's reference. Deterministic, so re-running cannot double up. */
export function waivedPaymentReference(consultationPublicId: string): string {
  return `neem_waived_${consultationPublicId}`;
}

/**
 * Takes a newly created consultation from PENDING_PAYMENT to ACTIVATED without
 * money changing hands.
 *
 * Mirrors `settlePayment`'s consultation branch exactly, minus the provider:
 * the zero payment, the three transitions through the one funnel, the zero
 * revenue allocation. Runs **inside the caller's creation transaction**, so
 * there is no instant at which a free consultation exists in PENDING_PAYMENT
 * for a sweep to find.
 *
 * `admitPaidConsultation` is deliberately **not** called here — it opens its
 * own transaction. The caller does it after the creation transaction commits,
 * as settlement does.
 */
export async function waiveConsultationFee(
  consultation: {
    id: string;
    publicId: string;
    currency: string;
    pharmacyId: string | null;
    isDemo: boolean;
  },
  reason: FeeWaiverReason,
  tx: Prisma.TransactionClient,
  clock: Clock = systemClock,
): Promise<void> {
  const now = clock.now();

  /*
   * A pharmacy's share of nothing is nothing, and so is Neem's. The allocation
   * is still written: a row of zeros records that this consultation was
   * accounted for, where an absent row would be indistinguishable from one
   * that was missed. It is also what lets `recordEarning` write a counter
   * professional's earning, which refuses to run without it.
   */
  const pharmacySharePctBp = consultation.pharmacyId
    ? await getIntSetting(SETTING_KEYS.REVENUE_PHARMACY_BP, tx as unknown as Db)
    : 0;

  const reference = waivedPaymentReference(consultation.publicId);

  const payment = await tx.payment.create({
    data: {
      publicId: generatePublicId('pay'),
      consultationId: consultation.id,
      provider: 'none',
      providerReference: reference,
      amountMinor: 0,
      // Zero rather than null, so the earnings path does not log a missing
      // provider fee on every free consultation. There was no provider.
      feeMinor: 0,
      currency: consultation.currency,
      status: 'SUCCESS',
      channel: null,
      paidAt: now,
      verifiedAt: now,
      idempotencyKey: reference,
      isWaived: true,
      isDemo: consultation.isDemo,
    },
  });

  // The same three edges a paid consultation takes. Nothing is bypassed, so
  // the state history of a free consultation reads like any other.
  await transition(
    consultation.id,
    'PAYMENT_PROCESSING',
    { actorType: 'SYSTEM', reason: `fee_waived_${reason}` },
    tx,
    clock,
  );
  await transition(
    consultation.id,
    'PAID',
    { actorType: 'SYSTEM', reason: `fee_waived_${reason}` },
    tx,
    clock,
  );

  const split = splitRevenue(0, pharmacySharePctBp, consultation.currency);

  try {
    await tx.revenueAllocation.create({
      data: {
        consultationId: consultation.id,
        paymentId: payment.id,
        grossMinor: 0,
        netMinor: split.netMinor,
        pharmacySharePctBp: split.pharmacySharePctBp,
        pharmacyShareMinor: split.pharmacyShareMinor,
        neemShareMinor: split.neemShareMinor,
        currency: consultation.currency,
        calculatedAt: now,
      },
    });
  } catch (error) {
    // UNIQUE(paymentId) — already allocated. The constraint doing its job.
    if (!isUniqueConstraintError(error)) throw error;
  }

  await transition(
    consultation.id,
    'ACTIVATED',
    { actorType: 'SYSTEM', reason: `fee_waived_${reason}` },
    tx,
    clock,
  );
}

/**
 * The part that cannot run inside the creation transaction.
 *
 * `recordUnservedDeadline` and `admitPaidConsultation` each open their own,
 * and both swallow their failures the way settlement does: a consultation that
 * never reaches the queue is the one that most needs a deadline, and the sweep
 * retries admission.
 */
export async function afterFeeWaived(
  consultation: { id: string; publicId: string; priceMinor: number },
  reason: FeeWaiverReason,
  context: {
    actorType?: 'PHARMACY' | 'PATIENT' | 'SYSTEM';
    actorId?: string;
    correlationId?: string;
  },
  db: PrismaClient = getPrisma(),
): Promise<void> {
  const { recordUnservedDeadline } = await import('../consultation/unserved.service.ts');
  const { admitPaidConsultation } = await import('../patient-booking/patient-booking.service.ts');

  await recordAudit(
    {
      action: AUDIT_ACTIONS.PAYMENT_CONFIRMED,
      actorType: context.actorType ?? 'SYSTEM',
      actorId: context.actorId,
      entityType: 'consultation',
      entityId: consultation.id,
      correlationId: context.correlationId,
      // What it would have cost is the figure the pilot is measured against.
      metadata: { waived: true, reason, wouldHaveChargedMinor: consultation.priceMinor },
    },
    db,
  ).catch((error: unknown) =>
    getLogger().error(
      { err: error, consultationId: consultation.id },
      'could not audit a waived fee',
    ),
  );

  await recordUnservedDeadline(consultation.id).catch((error: unknown) =>
    getLogger().error(
      { err: error, consultationId: consultation.id },
      'could not record the unserved deadline for a waived consultation',
    ),
  );

  await admitPaidConsultation(consultation.publicId).catch((error: unknown) =>
    getLogger().error(
      { err: error, consultationId: consultation.id },
      'could not admit a waived consultation; the sweep will retry',
    ),
  );
}
