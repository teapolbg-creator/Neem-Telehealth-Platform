import type { PrismaClient } from '@prisma/client';
import { getPrisma, isUniqueConstraintError, type Db } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { getEnv } from '../../config/env.ts';
import { generatePublicId, generateToken } from '../../lib/crypto.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
import { getLogger } from '../../lib/logger.ts';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit.service.ts';
import { getIntSetting } from '../settings/settings.service.ts';
import { SETTING_KEYS } from '../settings/settings.defaults.ts';
import { splitRevenue } from '../../lib/money.ts';
import { getPaymentProvider, type VerifiedPayment } from '../../adapters/payment/index.ts';
import { transition } from '../consultation/consultation.service.ts';
import { isAwaitingPayment } from '../../domain/consultation-state.ts';

/**
 * Payment orchestration (spec §34, §35, §68).
 *
 * The rule that shapes this module: **a consultation is never activated
 * because a client said the payment succeeded.** Activation happens in exactly
 * one place — `settlePayment()` — and only from a `VerifiedPayment` obtained
 * from the provider, whether that came from an explicit verify or from a
 * signature-checked webhook that we then re-verified.
 */

export interface InitiatePaymentResult {
  paymentPublicId: string;
  providerReference: string;
  authorizationUrl: string | null;
  amountMinor: number;
  currency: string;
  isMockProvider: boolean;
}

/**
 * Starts a payment for a consultation.
 *
 * Idempotent per consultation: calling it again while a payment is pending
 * returns the existing one rather than creating a second charge.
 */
export async function initiatePayment(
  consultationPublicId: string,
  input: { payerPhone?: string; pharmacyId: string },
  context: { actorId: string; correlationId?: string },
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<InitiatePaymentResult> {
  const consultation = await db.consultation.findUnique({
    where: { publicId: consultationPublicId },
    include: { payments: { orderBy: { createdAt: 'desc' } } },
  });
  if (!consultation) throw errors.notFound('Consultation not found.');
  if (consultation.pharmacyId !== input.pharmacyId) throw errors.notFound('Consultation not found.');

  if (!isAwaitingPayment(consultation.state)) {
    throw errors.businessRule(
      `This consultation is ${consultation.state} and is not awaiting payment.`,
    );
  }

  // The window is enforced here as well as by the sweep, so a request arriving
  // just after expiry cannot slip a payment through.
  if (consultation.paymentDeadlineAt && consultation.paymentDeadlineAt <= clock.now()) {
    throw errors.businessRule(
      'The payment window for this consultation has closed. Start a new consultation.',
    );
  }

  const provider = getPaymentProvider();

  // Reuse a live attempt rather than charging twice.
  const pending = consultation.payments.find(
    (payment) => payment.status === 'PENDING' || payment.status === 'PROCESSING',
  );
  if (pending) {
    return {
      paymentPublicId: pending.publicId,
      providerReference: pending.providerReference,
      authorizationUrl: null,
      amountMinor: pending.amountMinor,
      currency: pending.currency,
      isMockProvider: provider.isMock,
    };
  }

  // Our own reference doubles as the idempotency key. Unique per attempt, so a
  // retry after a genuine failure is a distinct charge, not a duplicate.
  const reference = `neem_${consultation.publicId}_${generateToken(6)}`;

  const initialized = await provider.initialize({
    amountMinor: consultation.netMinor,
    currency: consultation.currency,
    reference,
    // Non-clinical context only (spec §60).
    metadata: { consultationPublicId: consultation.publicId },
    payerPhone: input.payerPhone,
  });

  const payment = await db.payment.create({
    data: {
      publicId: generatePublicId('pay'),
      consultationId: consultation.id,
      provider: provider.name,
      providerReference: initialized.providerReference,
      amountMinor: consultation.netMinor,
      currency: consultation.currency,
      status: 'PROCESSING',
      channel: initialized.channel ?? null,
      idempotencyKey: reference,
      isDemo: consultation.isDemo,
    },
  });

  if (consultation.state === 'PENDING_PAYMENT' || consultation.state === 'PAYMENT_FAILED') {
    await transition(
      consultation.id,
      'PAYMENT_PROCESSING',
      { actorType: 'PHARMACY', actorId: context.actorId },
      db,
      clock,
    );
  }

  return {
    paymentPublicId: payment.publicId,
    providerReference: payment.providerReference,
    authorizationUrl: initialized.authorizationUrl ?? null,
    amountMinor: payment.amountMinor,
    currency: payment.currency,
    isMockProvider: provider.isMock,
  };
}

/**
 * Asks the provider for the authoritative status and applies it.
 *
 * Safe to call repeatedly — the pharmacy screen polls it — because
 * `settlePayment` is idempotent.
 */
export async function verifyAndSettle(
  providerReference: string,
  context: { actorType: 'PHARMACY' | 'SYSTEM'; actorId?: string; correlationId?: string },
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<{ status: string; consultationState: string }> {
  const verified = await getPaymentProvider().verify(providerReference);
  return settlePayment(verified, context, db, clock);
}

/**
 * Applies a verified payment result.
 *
 * The single point at which a consultation becomes PAID and then ACTIVATED,
 * and the single point at which revenue is allocated. Everything it does
 * happens in one transaction:
 *
 *   payment → SUCCESS
 *   consultation → PAID → ACTIVATED
 *   revenue allocation written (UNIQUE on paymentId — cannot double-count)
 *   one-time access token issued
 *
 * Idempotent: a second call for an already-successful payment returns the
 * existing outcome without writing anything (spec §68, §103).
 */
export async function settlePayment(
  verified: VerifiedPayment,
  context: { actorType: 'PHARMACY' | 'SYSTEM'; actorId?: string; correlationId?: string },
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<{ status: string; consultationState: string }> {
  const payment = await db.payment.findUnique({
    where: { providerReference: verified.providerReference },
    include: { consultation: { select: { id: true, state: true, netMinor: true, currency: true } } },
  });

  if (!payment) {
    // A reference we never issued. Recorded as an anomaly rather than ignored:
    // it means either a spoofed webhook or a genuine reconciliation problem.
    await recordAudit(
      {
        action: AUDIT_ACTIONS.PAYMENT_ANOMALY,
        actorType: 'SYSTEM',
        outcome: 'FAILURE',
        correlationId: context.correlationId,
        metadata: { reason: 'unknown_provider_reference', status: verified.status },
      },
      db,
    );
    throw errors.notFound('Payment not found.');
  }

  const consultation = payment.consultation;

  // Already settled — nothing to do. This is what makes duplicate webhooks and
  // repeated polling harmless.
  if (payment.status === 'SUCCESS') {
    return { status: 'SUCCESS', consultationState: consultation?.state ?? 'UNKNOWN' };
  }

  if (verified.status !== 'SUCCESS') {
    await db.payment.update({
      where: { id: payment.id },
      data: {
        status: verified.status === 'PENDING' ? 'PROCESSING' : verified.status,
        failureReason: verified.failureReason ?? null,
      },
    });

    if (verified.status === 'FAILED' && consultation && consultation.state === 'PAYMENT_PROCESSING') {
      await transition(
        consultation.id,
        'PAYMENT_FAILED',
        { actorType: context.actorType, actorId: context.actorId, reason: verified.failureReason },
        db,
        clock,
      );
    }

    return {
      status: verified.status,
      consultationState: consultation
        ? (await db.consultation.findUniqueOrThrow({ where: { id: consultation.id } })).state
        : 'UNKNOWN',
    };
  }

  if (!consultation) throw errors.notFound('Consultation not found for this payment.');

  // The provider must have taken what we asked for. A mismatch is an anomaly,
  // never something to quietly accept.
  if (verified.amountMinor !== payment.amountMinor) {
    await recordAudit(
      {
        action: AUDIT_ACTIONS.PAYMENT_ANOMALY,
        actorType: 'SYSTEM',
        outcome: 'FAILURE',
        entityType: 'payment',
        entityId: payment.id,
        correlationId: context.correlationId,
        metadata: { expectedMinor: payment.amountMinor, receivedMinor: verified.amountMinor },
      },
      db,
    );
    throw errors.businessRule(
      'The amount confirmed by the payment provider does not match this consultation. This has been flagged for review.',
    );
  }

  const pharmacySharePctBp = await getIntSetting(SETTING_KEYS.REVENUE_PHARMACY_BP, db);
  const now = clock.now();

  await db.$transaction(async (tx) => {
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: 'SUCCESS',
        paidAt: verified.paidAt ?? now,
        verifiedAt: now,
        channel: verified.channel ?? payment.channel,
      },
    });

    await transition(
      consultation.id,
      'PAID',
      { actorType: context.actorType, actorId: context.actorId, reason: 'payment_verified' },
      tx,
      clock,
    );

    // The split is computed once, at settlement, and stores the rate that was
    // in force — so a later configuration change cannot rewrite history.
    const split = splitRevenue(consultation.netMinor, pharmacySharePctBp, consultation.currency);

    try {
      await tx.revenueAllocation.create({
        data: {
          consultationId: consultation.id,
          paymentId: payment.id,
          grossMinor: consultation.netMinor,
          netMinor: split.netMinor,
          pharmacySharePctBp: split.pharmacySharePctBp,
          pharmacyShareMinor: split.pharmacyShareMinor,
          neemShareMinor: split.neemShareMinor,
          currency: consultation.currency,
          calculatedAt: now,
        },
      });
    } catch (error) {
      // UNIQUE(paymentId) — revenue was already allocated for this payment.
      // That is success, not failure: it is the constraint doing its job.
      if (!isUniqueConstraintError(error)) throw error;
    }

    await transition(
      consultation.id,
      'ACTIVATED',
      { actorType: 'SYSTEM', reason: 'payment_settled' },
      tx,
      clock,
    );
  });

  // Deliberately NOT issuing an access token here.
  //
  // Only the hash of a token is stored, so a QR can be rendered exactly once —
  // at the moment of issue. Minting one during settlement produced a code
  // nobody could ever display, and the pharmacy's first visit to the QR screen
  // then rotated it away. The token is issued when the pharmacy actually asks
  // for the code, which is also the only moment it can be shown.

  await recordAudit(
    {
      action: AUDIT_ACTIONS.PAYMENT_CONFIRMED,
      actorType: context.actorType,
      actorId: context.actorId,
      entityType: 'payment',
      entityId: payment.id,
      correlationId: context.correlationId,
      metadata: {
        consultationId: consultation.id,
        amountMinor: payment.amountMinor,
        provider: payment.provider,
        mock: getPaymentProvider().isMock,
      },
    },
    db,
  );

  return { status: 'SUCCESS', consultationState: 'ACTIVATED' };
}

/**
 * Handles a provider webhook.
 *
 * Signature is verified against the raw body by the adapter before this runs.
 * The unique constraint on (provider, providerEventId) is the idempotency
 * mechanism: a replayed webhook fails to insert and is acknowledged without
 * being processed again (spec §68).
 */
export async function handleWebhookEvent(
  event: {
    providerEventId: string;
    eventType: string;
    providerReference: string;
    status: string;
    amountMinor: number;
    currency: string;
  },
  provider: string,
  payloadHash: string,
  correlationId: string | undefined,
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<{ processed: boolean; reason?: string }> {
  try {
    await db.paymentWebhookEvent.create({
      data: {
        provider,
        providerEventId: event.providerEventId,
        eventType: event.eventType,
        signatureValid: true,
        payloadHash,
        receivedAt: clock.now(),
      },
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      getLogger().info(
        { providerEventId: event.providerEventId },
        'duplicate webhook ignored — already processed',
      );
      return { processed: false, reason: 'duplicate' };
    }
    throw error;
  }

  // Re-verify with the provider rather than trusting the webhook body. A valid
  // signature proves origin, not that the body reflects current truth.
  const verified = await getPaymentProvider().verify(event.providerReference);

  let result: { status: string; consultationState: string } | undefined;
  let error: string | undefined;

  try {
    result = await settlePayment(verified, { actorType: 'SYSTEM', correlationId }, db, clock);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : 'unknown error';
  }

  await db.paymentWebhookEvent.updateMany({
    where: { provider, providerEventId: event.providerEventId },
    data: {
      processedAt: clock.now(),
      processingResult: result?.status ?? 'ERROR',
      error: error?.slice(0, 500) ?? null,
    },
  });

  return { processed: true, reason: result?.status };
}

/**
 * Expires consultations whose payment window has closed (spec §35).
 *
 * Only touches consultations still awaiting payment, so a slow provider can
 * never expire one that was in fact paid.
 */
export async function expirePendingPayments(
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<number> {
  const now = clock.now();

  const stale = await db.consultation.findMany({
    where: {
      state: { in: ['PENDING_PAYMENT', 'PAYMENT_PROCESSING', 'PAYMENT_FAILED'] },
      paymentDeadlineAt: { lt: now },
    },
    select: { id: true, state: true },
  });

  let expired = 0;

  for (const consultation of stale) {
    try {
      await db.$transaction(async (tx) => {
        await transition(
          consultation.id,
          'EXPIRED',
          { actorType: 'SYSTEM', reason: 'payment_window_elapsed' },
          tx,
          clock,
        );
        // Clean up the temporary payment-session data (spec §35).
        await tx.payment.updateMany({
          where: { consultationId: consultation.id, status: { in: ['PENDING', 'PROCESSING'] } },
          data: { status: 'ABANDONED', failureReason: 'payment_window_elapsed' },
        });
        await tx.consultationAccessToken.updateMany({
          where: { consultationId: consultation.id, revokedAt: null },
          data: { revokedAt: now, revokedReason: 'consultation_expired' },
        });
      });
      expired += 1;
    } catch (caught) {
      getLogger().warn(
        { err: caught, consultationId: consultation.id },
        'could not expire consultation',
      );
    }
  }

  return expired;
}

/** Seconds left in the payment window, for the pharmacy's countdown. */
export function secondsRemaining(deadline: Date | null, clock: Clock = systemClock): number | null {
  if (!deadline) return null;
  return Math.max(0, Math.floor((deadline.getTime() - clock.now().getTime()) / 1000));
}

export function isMockPaymentProvider(): boolean {
  return getPaymentProvider().isMock;
}

export function paymentCallbackUrl(consultationPublicId: string): string {
  return `${getEnv().WEB_ORIGIN}/pharmacy/consultations/${consultationPublicId}`;
}
