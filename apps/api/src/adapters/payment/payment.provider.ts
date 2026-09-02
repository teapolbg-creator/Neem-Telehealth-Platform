/**
 * Payment provider abstraction (spec §91).
 *
 * Paystack is the intended provider, but no business logic knows that. The
 * interface is shaped around one non-negotiable rule: **only `verify()` and a
 * signature-checked webhook may assert that money moved.** `initialize()`
 * returns something the patient can pay with; it never returns success.
 */

export interface InitializePaymentInput {
  /** Minor units — pesewas. Never a float. */
  amountMinor: number;
  currency: string;
  /** Our idempotency key, echoed back by the provider where supported. */
  reference: string;
  /** Where the provider should send the payer afterwards. */
  callbackUrl?: string;
  /**
   * Contact for the payment prompt. Held only for the life of the
   * consultation and deleted with the rest of the patient session (spec §36).
   */
  payerPhone?: string;
  payerEmail?: string;
  /** Non-clinical context only — never a name, never a diagnosis (spec §60). */
  metadata?: Record<string, string | number | boolean>;
}

export interface InitializePaymentResult {
  providerReference: string;
  /** Hosted checkout, where the provider offers one. */
  authorizationUrl?: string;
  /** Provider-side token for a mobile-money prompt. */
  accessCode?: string;
  /** Which channel the payer was directed to, when known. */
  channel?: string;
}

export type VerifiedPaymentStatus = 'SUCCESS' | 'PENDING' | 'FAILED' | 'ABANDONED';

export interface VerifiedPayment {
  providerReference: string;
  status: VerifiedPaymentStatus;
  /** What the provider says was actually paid, in minor units. */
  amountMinor: number;
  currency: string;
  channel?: string;
  paidAt?: Date;
  failureReason?: string;
}

export interface WebhookEvent {
  /** Provider-side unique event id — the idempotency key for webhooks. */
  providerEventId: string;
  eventType: string;
  /** The original transaction's reference, for every kind of event. */
  providerReference: string;
  /**
   * The refund's own provider reference, on refund events only.
   *
   * A refund event is about a different object from the charge that preceded
   * it, and settling it as though it were a payment would re-verify the
   * charge and conclude, correctly but uselessly, that it succeeded.
   */
  refundReference?: string;
  status: VerifiedPaymentStatus;
  amountMinor: number;
  currency: string;
  channel?: string;
  paidAt?: Date;
  raw: unknown;
}

export interface RefundInput {
  providerReference: string;
  amountMinor: number;
  reason?: string;
}

export interface RefundResult {
  providerRefundReference: string;
  status: 'PENDING' | 'COMPLETED' | 'FAILED';
}

export interface PaymentProvider {
  /** Human-readable name, surfaced in health checks and logs. */
  readonly name: string;
  /** True for adapters that cannot verify real money movement. */
  readonly isMock: boolean;

  initialize(input: InitializePaymentInput): Promise<InitializePaymentResult>;

  /**
   * Authoritative status, fetched from the provider.
   *
   * This — not a webhook body, and certainly not the browser — is what may
   * activate a consultation (spec §34).
   */
  verify(providerReference: string): Promise<VerifiedPayment>;

  /**
   * Parses and authenticates a webhook.
   *
   * MUST verify the signature against the RAW body before parsing. Throws
   * `WebhookSignatureError` when it does not check out.
   */
  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): WebhookEvent;

  refund(input: RefundInput): Promise<RefundResult>;
}

export class WebhookSignatureError extends Error {
  constructor(message = 'Webhook signature verification failed') {
    super(message);
    this.name = 'WebhookSignatureError';
  }
}

export class PaymentProviderError extends Error {
  constructor(
    message: string,
    readonly providerReference?: string,
  ) {
    super(message);
    this.name = 'PaymentProviderError';
  }
}
