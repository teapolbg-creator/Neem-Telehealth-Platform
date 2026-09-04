import { createHmac, timingSafeEqual } from 'node:crypto';
import { getEnv } from '../../config/env.ts';
import {
  PaymentProviderError,
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
 * Paystack (spec §34, §68, §91).
 *
 * Three properties matter more than anything else here, and each is enforced
 * structurally rather than by convention:
 *
 *  1. **Only `verify()` and a signature-checked webhook may assert that money
 *     moved.** `initialize()` returns a way to pay and nothing more. There is
 *     no code path in this file that reports SUCCESS from a client callback.
 *  2. **The signature is checked against the raw body**, before the body is
 *     parsed, with a constant-time comparison.
 *  3. **Amounts stay integer minor units end to end.** Paystack denominates
 *     GHS in pesewas, which is what the rest of Neem uses, so nothing is
 *     converted anywhere in this file.
 *
 * Anything the provider says that we did not ask for is treated as suspect:
 * an unexpected currency, or an amount that does not match, is surfaced to
 * the caller rather than accommodated. `settlePayment` compares the amount
 * again against our own record and raises an anomaly on a mismatch.
 */

const BASE_URL = 'https://api.paystack.co';

/** Paystack's own vocabulary, mapped onto ours. */
function mapStatus(value: string | undefined): VerifiedPaymentStatus {
  switch ((value ?? '').toLowerCase()) {
    case 'success':
      return 'SUCCESS';
    case 'failed':
    case 'reversed':
      return 'FAILED';
    case 'abandoned':
      return 'ABANDONED';
    // 'ongoing', 'pending', 'processing', 'queued', and anything unrecognised.
    // Defaulting to PENDING is the safe direction: it settles nothing and
    // leaves the consultation awaiting a definitive answer.
    default:
      return 'PENDING';
  }
}

interface PaystackEnvelope<T> {
  status: boolean;
  message?: string;
  data?: T;
}

export class PaystackPaymentProvider implements PaymentProvider {
  readonly name = 'paystack';
  readonly isMock = false;

  /**
   * Every Paystack call, in one place.
   *
   * Times out rather than hanging: a payment provider that stops answering
   * must leave the consultation in PENDING_PAYMENT with the pharmacy told the
   * provider is unavailable, never in a state that looks like success
   * (docs/payment-flow.md §4).
   */
  private async call<T>(
    path: string,
    init: { method: 'GET' | 'POST'; body?: unknown },
  ): Promise<T> {
    const env = getEnv();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), env.PAYSTACK_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${BASE_URL}${path}`, {
        method: init.method,
        headers: {
          authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
          'content-type': 'application/json',
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      });
    } catch (error) {
      throw new PaymentProviderError(
        error instanceof Error && error.name === 'AbortError'
          ? 'The payment provider did not respond in time.'
          : 'The payment provider could not be reached.',
      );
    } finally {
      clearTimeout(timeout);
    }

    // Paystack returns its errors as JSON with a 4xx, so the body is read
    // either way — the message is what tells an operator what went wrong.
    const envelope = (await response.json().catch(() => undefined)) as
      PaystackEnvelope<T> | undefined;

    if (!response.ok || !envelope?.status) {
      throw new PaymentProviderError(
        envelope?.message ?? `Paystack returned ${response.status} for ${path}`,
      );
    }
    if (envelope.data === undefined) {
      throw new PaymentProviderError(`Paystack returned no data for ${path}`);
    }

    return envelope.data;
  }

  async initialize(input: InitializePaymentInput): Promise<InitializePaymentResult> {
    const data = await this.call<{
      authorization_url?: string;
      access_code?: string;
      reference?: string;
    }>('/transaction/initialize', {
      method: 'POST',
      body: {
        // Pesewas. Paystack denominates GHS in minor units, as we do.
        amount: input.amountMinor,
        currency: input.currency,
        reference: input.reference,
        callback_url: input.callbackUrl,
        /**
         * Paystack requires an email and Neem does not collect one from
         * patients — they give a phone number at the counter. A synthetic
         * per-transaction address is used rather than a shared placeholder,
         * so a receipt cannot reach the wrong person, and it carries no
         * patient data: it is derived from our own reference (spec §60).
         */
        email: input.payerEmail ?? `${input.reference}@${getEnv().PAYSTACK_RECEIPT_DOMAIN}`,
        // Mobile money first — it is how a Ghanaian pharmacy counter is paid.
        channels: ['mobile_money', 'card'],
        metadata: {
          ...input.metadata,
          // Shown in the Paystack dashboard. Deliberately no name, no phone,
          // and nothing clinical (spec §60).
          custom_fields: [
            {
              display_name: 'Neem reference',
              variable_name: 'neem_reference',
              value: input.reference,
            },
          ],
        },
      },
    });

    if (!data.authorization_url || !data.reference) {
      throw new PaymentProviderError('Paystack did not return a usable checkout.');
    }

    return {
      providerReference: data.reference,
      authorizationUrl: data.authorization_url,
      accessCode: data.access_code,
      channel: 'mobile_money',
    };
  }

  /**
   * The authoritative answer.
   *
   * This is the only thing in the system, other than a signature-checked
   * webhook, permitted to say a payment succeeded (spec §34).
   */
  async verify(providerReference: string): Promise<VerifiedPayment> {
    const data = await this.call<{
      status?: string;
      amount?: number;
      currency?: string;
      channel?: string;
      paid_at?: string;
      gateway_response?: string;
    }>(`/transaction/verify/${encodeURIComponent(providerReference)}`, { method: 'GET' });

    const status = mapStatus(data.status);

    return {
      providerReference,
      status,
      amountMinor: data.amount ?? 0,
      currency: data.currency ?? 'GHS',
      channel: data.channel,
      paidAt: status === 'SUCCESS' && data.paid_at ? new Date(data.paid_at) : undefined,
      failureReason: status === 'SUCCESS' ? undefined : data.gateway_response,
    };
  }

  /**
   * Verifies and parses a webhook.
   *
   * Paystack signs the **raw request body** with HMAC SHA-512 keyed by the
   * account's secret key, and sends it as `x-paystack-signature`. The body is
   * not parsed until that check passes, so a forged payload never reaches the
   * JSON parser, let alone the settlement path.
   */
  parseWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): WebhookEvent {
    const supplied = headers['x-paystack-signature'];
    const signature = Array.isArray(supplied) ? supplied[0] : supplied;

    if (!signature) throw new WebhookSignatureError('Missing x-paystack-signature header');

    const expected = createHmac('sha512', this.signingKey()).update(rawBody).digest('hex');

    const a = Buffer.from(signature, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    // Length is compared first because timingSafeEqual throws on a mismatch.
    // Length alone leaks nothing here: it is fixed for a SHA-512 hex digest.
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new WebhookSignatureError();
    }

    const payload = JSON.parse(rawBody.toString('utf8')) as {
      event?: string;
      data?: {
        id?: number;
        reference?: string;
        /** Refund events name the charge this way rather than `reference`. */
        transaction_reference?: string;
        status?: string;
        amount?: number;
        currency?: string;
        channel?: string;
        paid_at?: string;
      };
    };

    const isRefund = (payload.event ?? '').startsWith('refund.');
    const reference = isRefund
      ? (payload.data?.transaction_reference ?? payload.data?.reference)
      : payload.data?.reference;
    if (!reference) throw new WebhookSignatureError('Webhook payload carries no reference');

    const status = mapStatus(payload.data?.status);

    return {
      /**
       * The idempotency key for webhooks.
       *
       * Paystack does not send a dedicated event id, so the transaction id is
       * used, qualified by the event type — the same transaction legitimately
       * produces `charge.success` and later `refund.processed`, and those are
       * different events. Where even the transaction id is absent, the
       * reference and status stand in; a duplicate then collides on the
       * unique constraint, which is the outcome we want.
       */
      providerEventId: `${payload.event ?? 'event'}:${payload.data?.id ?? `${reference}:${status}`}`,
      eventType: payload.event ?? 'charge.success',
      providerReference: reference,
      refundReference:
        isRefund && payload.data?.id !== undefined ? String(payload.data.id) : undefined,
      status,
      amountMinor: payload.data?.amount ?? 0,
      currency: payload.data?.currency ?? 'GHS',
      channel: payload.data?.channel,
      paidAt:
        status === 'SUCCESS' && payload.data?.paid_at ? new Date(payload.data.paid_at) : undefined,
      raw: payload,
    };
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    const data = await this.call<{ id?: number; status?: string }>('/refund', {
      method: 'POST',
      body: {
        transaction: input.providerReference,
        amount: input.amountMinor,
        merchant_note: input.reason?.slice(0, 255),
      },
    });

    if (data.id === undefined) {
      throw new PaymentProviderError('Paystack did not return a refund reference.');
    }

    return {
      providerRefundReference: String(data.id),
      /**
       * Paystack refunds settle asynchronously. Anything not yet final is
       * PENDING, and the refund is completed by the `refund.processed`
       * webhook — never optimistically here.
       */
      status:
        (data.status ?? '').toLowerCase() === 'processed'
          ? 'COMPLETED'
          : (data.status ?? '').toLowerCase() === 'failed'
            ? 'FAILED'
            : 'PENDING',
    };
  }

  /**
   * The webhook signing key.
   *
   * Paystack signs with the account's **secret key**. `PAYSTACK_WEBHOOK_SECRET`
   * exists so the two can be separated in a test harness; when it is unset the
   * secret key is used, which is the real arrangement.
   */
  private signingKey(): string {
    const env = getEnv();
    return env.PAYSTACK_WEBHOOK_SECRET || env.PAYSTACK_SECRET_KEY || '';
  }
}
