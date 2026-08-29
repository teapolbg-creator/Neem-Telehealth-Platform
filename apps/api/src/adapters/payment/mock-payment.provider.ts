import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getEnv } from '../../config/env.ts';
import {
  WebhookSignatureError,
  type InitializePaymentInput,
  type InitializePaymentResult,
  type PaymentProvider,
  type RefundInput,
  type RefundResult,
  type VerifiedPayment,
  type VerifiedPaymentStatus,
  type WebhookEvent,
} from './payment.provider.ts';

/**
 * Development payment provider.
 *
 * This is a *simulator*, not a pretence. It implements the production contract
 * faithfully — including HMAC-signed webhooks that are genuinely verified — so
 * the code paths exercised in development are the same ones that will run
 * against Paystack (spec §77, §93).
 *
 * What it will not do is claim money moved on its own. A mock payment stays
 * PENDING until something explicitly settles it: the pharmacy pressing
 * "simulate payment" in development, or a signed simulated webhook. That
 * mirrors reality, where a payment is pending until the provider says
 * otherwise.
 *
 * `isMock` is true, and the config loader refuses to boot production with a
 * mock provider selected.
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';
  readonly isMock = true;

  /** In-memory ledger. Cleared on restart, which is fine for development. */
  private readonly payments = new Map<
    string,
    { amountMinor: number; currency: string; status: VerifiedPaymentStatus; channel?: string; paidAt?: Date }
  >();

  async initialize(input: InitializePaymentInput): Promise<InitializePaymentResult> {
    const providerReference = `mock_${input.reference}`;

    this.payments.set(providerReference, {
      amountMinor: input.amountMinor,
      currency: input.currency,
      status: 'PENDING',
      channel: 'mobile_money',
    });

    return {
      providerReference,
      // Points at our own simulator page rather than a fake provider domain,
      // so nobody can mistake it for a real checkout.
      authorizationUrl: `${getEnv().WEB_ORIGIN}/dev/payment/${encodeURIComponent(providerReference)}`,
      accessCode: randomBytes(8).toString('hex'),
      channel: 'mobile_money',
    };
  }

  async verify(providerReference: string): Promise<VerifiedPayment> {
    const record = this.payments.get(providerReference);

    if (!record) {
      // An unknown reference is not a success. Matching production behaviour
      // matters most in exactly this case.
      return {
        providerReference,
        status: 'FAILED',
        amountMinor: 0,
        currency: 'GHS',
        failureReason: 'Unknown payment reference',
      };
    }

    return {
      providerReference,
      status: record.status,
      amountMinor: record.amountMinor,
      currency: record.currency,
      channel: record.channel,
      paidAt: record.paidAt,
    };
  }

  parseWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): WebhookEvent {
    const supplied = headers['x-neem-mock-signature'];
    const signature = Array.isArray(supplied) ? supplied[0] : supplied;

    if (!signature) throw new WebhookSignatureError('Missing signature header');

    // Signed over the RAW body, exactly as the Paystack adapter will be. This
    // is what makes webhook spoofing testable before the real provider exists.
    const expected = createHmac('sha512', this.webhookSecret()).update(rawBody).digest('hex');

    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new WebhookSignatureError();
    }

    const payload = JSON.parse(rawBody.toString('utf8')) as {
      id?: string;
      event?: string;
      data?: { reference?: string; status?: string; amount?: number; currency?: string; channel?: string; paid_at?: string };
    };

    const reference = payload.data?.reference;
    if (!reference) throw new WebhookSignatureError('Webhook payload has no payment reference');

    const status = normaliseStatus(payload.data?.status);

    // Keep the in-memory ledger consistent, so a later verify() agrees with
    // the webhook — as it would with a real provider.
    const existing = this.payments.get(reference);
    if (existing) {
      existing.status = status;
      existing.paidAt = status === 'SUCCESS' ? new Date() : undefined;
    }

    return {
      providerEventId: payload.id ?? `mock_evt_${reference}_${status}`,
      eventType: payload.event ?? 'charge.completed',
      providerReference: reference,
      status,
      amountMinor: payload.data?.amount ?? existing?.amountMinor ?? 0,
      currency: payload.data?.currency ?? existing?.currency ?? 'GHS',
      channel: payload.data?.channel,
      paidAt: status === 'SUCCESS' ? new Date() : undefined,
      raw: payload,
    };
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    const record = this.payments.get(input.providerReference);

    if (!record || record.status !== 'SUCCESS') {
      return { providerRefundReference: `mock_rf_${randomBytes(6).toString('hex')}`, status: 'FAILED' };
    }

    record.status = 'FAILED';
    return {
      providerRefundReference: `mock_rf_${randomBytes(6).toString('hex')}`,
      status: 'COMPLETED',
    };
  }

  // -------------------------------------------------------------------------
  // Development-only helpers. Not part of PaymentProvider — nothing in the
  // business logic may call these, and the real adapter has no equivalent.
  // -------------------------------------------------------------------------

  /** Settles a payment, as the provider would when the payer completes it. */
  settle(providerReference: string, outcome: 'SUCCESS' | 'FAILED' = 'SUCCESS'): boolean {
    const record = this.payments.get(providerReference);
    if (!record) return false;

    record.status = outcome;
    record.paidAt = outcome === 'SUCCESS' ? new Date() : undefined;
    return true;
  }

  /** Signs a body the way the provider would, so webhook handling is testable. */
  signWebhook(rawBody: Buffer): string {
    return createHmac('sha512', this.webhookSecret()).update(rawBody).digest('hex');
  }

  private webhookSecret(): string {
    // Falls back to the session secret so development needs no extra config;
    // production never reaches this adapter.
    return getEnv().PAYSTACK_WEBHOOK_SECRET || getEnv().SESSION_SECRET;
  }
}

function normaliseStatus(value: string | undefined): VerifiedPaymentStatus {
  switch ((value ?? '').toLowerCase()) {
    case 'success':
    case 'successful':
      return 'SUCCESS';
    case 'failed':
      return 'FAILED';
    case 'abandoned':
      return 'ABANDONED';
    default:
      return 'PENDING';
  }
}
