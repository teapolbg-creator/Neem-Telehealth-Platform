import { createHmac } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { PaystackPaymentProvider } from '../../src/adapters/payment/paystack-payment.provider.ts';
import { WebhookSignatureError } from '../../src/adapters/payment/payment.provider.ts';

/**
 * The Paystack adapter's two unforgiving parts (spec §34, §68).
 *
 * Everything else in the adapter is an HTTP call that integration testing
 * covers. These two are pure, and both are places where a plausible-looking
 * mistake moves money: a webhook that is trusted without a valid signature,
 * and a provider status that is read as success when it is not.
 */

const SECRET = 'sk_test_neem_adapter_spec';

beforeAll(() => {
  process.env.PAYSTACK_SECRET_KEY = SECRET;
  // Left unset deliberately: Paystack signs with the secret key, and the
  // adapter must fall back to it rather than require a second value.
  delete process.env.PAYSTACK_WEBHOOK_SECRET;
});

function signed(body: unknown): { raw: Buffer; signature: string } {
  const raw = Buffer.from(JSON.stringify(body), 'utf8');
  return { raw, signature: createHmac('sha512', SECRET).update(raw).digest('hex') };
}

const CHARGE = {
  event: 'charge.success',
  data: {
    id: 302961,
    reference: 'neem_c_abc123',
    status: 'success',
    amount: 3000,
    currency: 'GHS',
    channel: 'mobile_money',
    paid_at: '2026-09-02T10:00:00.000Z',
  },
};

describe('webhook signature verification', () => {
  const provider = new PaystackPaymentProvider();

  it('accepts a body signed with the secret key', () => {
    const { raw, signature } = signed(CHARGE);

    const event = provider.parseWebhook(raw, { 'x-paystack-signature': signature });

    expect(event.providerReference).toBe('neem_c_abc123');
    expect(event.status).toBe('SUCCESS');
    expect(event.amountMinor).toBe(3000);
  });

  it('refuses a body that was altered after signing', () => {
    const { signature } = signed(CHARGE);
    // The classic attack: a valid signature from a real event, replayed over a
    // body whose amount has been raised.
    const tampered = Buffer.from(
      JSON.stringify({ ...CHARGE, data: { ...CHARGE.data, amount: 300_000 } }),
      'utf8',
    );

    expect(() => provider.parseWebhook(tampered, { 'x-paystack-signature': signature })).toThrow(
      WebhookSignatureError,
    );
  });

  it('refuses a missing signature header', () => {
    const { raw } = signed(CHARGE);

    expect(() => provider.parseWebhook(raw, {})).toThrow(WebhookSignatureError);
  });

  it('refuses a signature of the wrong length without throwing from the comparison', () => {
    const { raw } = signed(CHARGE);

    // timingSafeEqual throws on unequal lengths; the adapter must return a
    // signature error rather than let that escape as a 500.
    expect(() => provider.parseWebhook(raw, { 'x-paystack-signature': 'deadbeef' })).toThrow(
      WebhookSignatureError,
    );
  });

  it('refuses a body signed with a different key', () => {
    const raw = Buffer.from(JSON.stringify(CHARGE), 'utf8');
    const signature = createHmac('sha512', 'sk_test_someone_else').update(raw).digest('hex');

    expect(() => provider.parseWebhook(raw, { 'x-paystack-signature': signature })).toThrow(
      WebhookSignatureError,
    );
  });

  it('does not parse the body before the signature check', () => {
    // Invalid JSON with a bad signature must fail as a signature error. If the
    // order were reversed this would surface as a JSON syntax error, which
    // would mean unauthenticated input had already reached the parser.
    const raw = Buffer.from('{ not json', 'utf8');

    expect(() => provider.parseWebhook(raw, { 'x-paystack-signature': 'ff'.repeat(64) })).toThrow(
      WebhookSignatureError,
    );
  });

  it('gives the same transaction different event ids for different events', () => {
    const success = signed(CHARGE);
    const refund = signed({ ...CHARGE, event: 'refund.processed' });

    const a = provider.parseWebhook(success.raw, { 'x-paystack-signature': success.signature });
    const b = provider.parseWebhook(refund.raw, { 'x-paystack-signature': refund.signature });

    // Both are legitimate and both must be processed. Sharing an id would make
    // the second collide on the unique constraint and be silently dropped.
    expect(a.providerEventId).not.toBe(b.providerEventId);
  });
});

describe('status mapping', () => {
  const provider = new PaystackPaymentProvider();

  const parse = (status: string) => {
    const { raw, signature } = signed({ ...CHARGE, data: { ...CHARGE.data, status } });
    return provider.parseWebhook(raw, { 'x-paystack-signature': signature }).status;
  };

  it('treats only "success" as success', () => {
    expect(parse('success')).toBe('SUCCESS');
  });

  it('treats a reversal as failed, not as success', () => {
    expect(parse('reversed')).toBe('FAILED');
  });

  it('treats failure and abandonment distinctly', () => {
    expect(parse('failed')).toBe('FAILED');
    expect(parse('abandoned')).toBe('ABANDONED');
  });

  /**
   * The safe default.
   *
   * A status Paystack adds later, or one we have not anticipated, must settle
   * nothing. PENDING leaves the consultation awaiting a definitive answer;
   * anything else would risk activating on a status nobody has read.
   */
  it('treats an unrecognised status as pending', () => {
    expect(parse('ongoing')).toBe('PENDING');
    expect(parse('queued')).toBe('PENDING');
    expect(parse('something_paystack_added_in_2027')).toBe('PENDING');
    expect(parse('')).toBe('PENDING');
  });

  it('does not report a paidAt for anything but a success', () => {
    const { raw, signature } = signed({ ...CHARGE, data: { ...CHARGE.data, status: 'failed' } });

    expect(provider.parseWebhook(raw, { 'x-paystack-signature': signature }).paidAt).toBeUndefined();
  });
});
