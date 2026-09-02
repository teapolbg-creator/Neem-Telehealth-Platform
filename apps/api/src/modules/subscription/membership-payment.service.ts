import type { PrismaClient } from '@prisma/client';
import { getPrisma, type Db } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { generatePublicId, generateToken } from '../../lib/crypto.ts';
import { getLogger } from '../../lib/logger.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
import { getPaymentProvider } from '../../adapters/payment/index.ts';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit.service.ts';
import { getIntSetting } from '../settings/settings.service.ts';
import { SETTING_KEYS } from '../settings/settings.defaults.ts';
import { changeDoctorStatus } from '../doctor/doctor.service.ts';

/**
 * Paying the doctor membership fee (spec §27, §34).
 *
 * The lifecycle — period, grace, expiry, suspension — has existed since Phase 2
 * in `subscription.service.ts`. This is the half that takes the money, and it
 * obeys the same rule as every other payment in Neem: **only a server-side
 * verification may say the fee was paid.** Initiating returns something the
 * doctor can pay with and activates nothing.
 *
 * The subscription row is created up front as PENDING and the payment is
 * attached to it. A failed payment therefore leaves a PENDING period, which is
 * harmless and reused on the next attempt — better than the alternative, where
 * a payment would have nothing to point at until after it settled.
 */

/**
 * The reason the expiry sweep records when it suspends a doctor.
 *
 * Matched exactly on renewal. It is the difference between "suspended because
 * they stopped paying" — which paying should undo — and "suspended by an
 * administrator", which it must not.
 */
export const MEMBERSHIP_SUSPENSION_REASON = 'Membership subscription expired';

export interface MembershipPaymentResult {
  paymentPublicId: string;
  providerReference: string;
  authorizationUrl: string | null;
  amountMinor: number;
  currency: string;
  periodStart: string;
  periodEnd: string;
  isMockProvider: boolean;
}

export async function initiateMembershipPayment(
  doctorId: string,
  context: { correlationId?: string },
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<MembershipPaymentResult> {
  const doctor = await db.doctor.findUnique({
    where: { id: doctorId },
    include: { subscriptions: { orderBy: { periodEnd: 'desc' }, take: 1 } },
  });
  if (!doctor) throw errors.notFound('Doctor not found.');

  /**
   * A rejected doctor cannot buy their way in.
   *
   * Membership is what an approved doctor maintains, not what makes them one.
   * Taking money from someone whose application was refused would be both
   * useless to them and difficult to explain afterwards.
   */
  if (doctor.status === 'REJECTED') {
    throw errors.businessRule('This account cannot take out a membership.');
  }

  const provider = getPaymentProvider();
  const amountMinor = await getIntSetting(SETTING_KEYS.DOCTOR_MEMBERSHIP_FEE_MINOR, db);
  const months = await getIntSetting(SETTING_KEYS.DOCTOR_MEMBERSHIP_MONTHS, db);
  const now = clock.now();

  // Reuse an attempt already in flight rather than charging twice.
  const pending = await db.payment.findFirst({
    where: {
      doctorSubscription: { doctorId },
      status: { in: ['PENDING', 'PROCESSING'] },
    },
    include: { doctorSubscription: true },
    orderBy: { createdAt: 'desc' },
  });

  if (pending?.doctorSubscription) {
    return {
      paymentPublicId: pending.publicId,
      providerReference: pending.providerReference,
      // Deliberately null: a hosted checkout URL is single-use at some
      // providers, and handing back a stale one would send the doctor to a
      // dead page. They restart instead, which costs a request and works.
      authorizationUrl: null,
      amountMinor: pending.amountMinor,
      currency: pending.currency,
      periodStart: pending.doctorSubscription.periodStart.toISOString(),
      periodEnd: pending.doctorSubscription.periodEnd.toISOString(),
      isMockProvider: provider.isMock,
    };
  }

  const previous = doctor.subscriptions[0];

  // Renewing early does not forfeit the remaining time: the new period
  // continues from the end of the current one.
  const periodStart = previous && previous.periodEnd > now ? previous.periodEnd : now;
  const periodEnd = new Date(periodStart);
  periodEnd.setMonth(periodEnd.getMonth() + months);

  const subscription =
    previous?.status === 'PENDING'
      ? previous
      : await db.doctorSubscription.create({
          data: {
            doctorId,
            periodStart,
            periodEnd,
            amountMinor,
            status: 'PENDING',
            renewedFromId: previous?.id ?? null,
          },
        });

  const reference = `neem_sub_${doctor.publicId}_${generateToken(6)}`;

  const initialized = await provider.initialize({
    amountMinor,
    currency: subscription.currency,
    reference,
    // Non-clinical, and not even patient-related. A doctor's own membership.
    metadata: { doctorPublicId: doctor.publicId, kind: 'membership' },
  });

  const payment = await db.payment.create({
    data: {
      publicId: generatePublicId('pay'),
      doctorSubscriptionId: subscription.id,
      provider: provider.name,
      providerReference: initialized.providerReference,
      amountMinor,
      currency: subscription.currency,
      status: 'PROCESSING',
      channel: initialized.channel ?? null,
      idempotencyKey: reference,
      isDemo: doctor.isDemo,
    },
  });

  return {
    paymentPublicId: payment.publicId,
    providerReference: payment.providerReference,
    authorizationUrl: initialized.authorizationUrl ?? null,
    amountMinor,
    currency: subscription.currency,
    periodStart: subscription.periodStart.toISOString(),
    periodEnd: subscription.periodEnd.toISOString(),
    isMockProvider: provider.isMock,
  };
}

/**
 * Applies a verified membership payment.
 *
 * Called from `settlePayment` once the provider has confirmed the money, so
 * everything here can assume the fee was genuinely paid. Idempotent: a
 * duplicate webhook finds the subscription already ACTIVE and does nothing.
 */
export async function settleMembershipPayment(
  subscriptionId: string,
  context: { correlationId?: string },
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<void> {
  const subscription = await db.doctorSubscription.findUnique({
    where: { id: subscriptionId },
    include: { doctor: { select: { id: true, publicId: true, status: true, statusReason: true } } },
  });
  if (!subscription) return;
  if (subscription.status === 'ACTIVE') return;

  await db.doctorSubscription.update({
    where: { id: subscription.id },
    data: { status: 'ACTIVE', graceEndsAt: null },
  });

  await recordAudit(
    {
      action: subscription.renewedFromId
        ? AUDIT_ACTIONS.SUBSCRIPTION_RENEWED
        : AUDIT_ACTIONS.SUBSCRIPTION_CREATED,
      actorType: 'SYSTEM',
      entityType: 'doctor_subscription',
      entityId: subscription.id,
      correlationId: context.correlationId,
      metadata: {
        doctorId: subscription.doctorId,
        amountMinor: subscription.amountMinor,
        periodEnd: subscription.periodEnd.toISOString(),
        // The one place in this codebase where `paid: true` is warranted: the
        // provider has been asked and answered.
        paid: true,
      },
    },
    db,
  );

  /**
   * Reinstating a doctor suspended for non-payment.
   *
   * Only when that is demonstrably why they were suspended. A doctor
   * suspended by an administrator — for conduct, for a lapsed licence, for
   * anything else — does not become active again by paying a fee, and a rule
   * that could not tell the two apart would let the fee buy its way past a
   * decision a person made.
   */
  const doctor = subscription.doctor;
  if (doctor.status !== 'SUSPENDED' || doctor.statusReason !== MEMBERSHIP_SUSPENSION_REASON) {
    return;
  }

  try {
    await changeDoctorStatus(
      doctor.publicId,
      'ACTIVE',
      { adminId: 'system', reason: 'Membership renewed' },
      db,
      clock,
    );
  } catch (error) {
    /**
     * Reactivation has its own conditions — verified documents, a captured
     * signature, an unexpired MDC licence. If one now fails, the doctor stays
     * suspended and an administrator picks it up. The payment stands either
     * way: they paid, and refusing to record that because a separate check
     * failed would lose the money.
     */
    getLogger().warn(
      { err: error, doctorPublicId: doctor.publicId },
      'membership paid but the doctor could not be reactivated automatically',
    );
  }
}

export interface MembershipView {
  status: string;
  periodStart: string | null;
  periodEnd: string | null;
  graceEndsAt: string | null;
  amountMinor: number;
  currency: string;
  /** Days until the period ends; negative once it has. Null when none exists. */
  daysRemaining: number | null;
  /** True when the doctor should be prompted to renew. */
  renewalDue: boolean;
  doctorStatus: string;
  /** True when this doctor is suspended specifically for non-payment. */
  suspendedForNonPayment: boolean;
}

/** How far ahead a doctor is told their membership is ending. */
const RENEWAL_PROMPT_DAYS = 30;

export async function membershipView(
  doctorId: string,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<MembershipView> {
  const doctor = await db.doctor.findUniqueOrThrow({
    where: { id: doctorId },
    select: {
      status: true,
      statusReason: true,
      subscriptions: { orderBy: { periodEnd: 'desc' }, take: 1 },
    },
  });

  const amountMinor = await getIntSetting(SETTING_KEYS.DOCTOR_MEMBERSHIP_FEE_MINOR, db);
  const current = doctor.subscriptions[0];
  const now = clock.now();

  const daysRemaining = current
    ? Math.ceil((current.periodEnd.getTime() - now.getTime()) / 86_400_000)
    : null;

  return {
    status: current?.status ?? 'NONE',
    periodStart: current?.periodStart.toISOString() ?? null,
    periodEnd: current?.periodEnd.toISOString() ?? null,
    graceEndsAt: current?.graceEndsAt?.toISOString() ?? null,
    amountMinor: current?.amountMinor ?? amountMinor,
    currency: current?.currency ?? 'GHS',
    daysRemaining,
    renewalDue:
      !current ||
      current.status !== 'ACTIVE' ||
      (daysRemaining !== null && daysRemaining <= RENEWAL_PROMPT_DAYS),
    doctorStatus: doctor.status,
    suspendedForNonPayment:
      doctor.status === 'SUSPENDED' && doctor.statusReason === MEMBERSHIP_SUSPENSION_REASON,
  };
}
