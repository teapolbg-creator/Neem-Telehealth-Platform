import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env.ts';

/**
 * The guards that stop a development configuration reaching production
 * (spec §7, §76, §93).
 *
 * These matter because the development `.env` is deliberately unsafe: mock
 * providers, demo seeding, and rate limits raised so the end-to-end suite is
 * not throttled by its own repeated runs. Copying that file to a server is the
 * single most plausible way this repository ends up misconfigured, so the
 * process refuses to boot rather than starting quietly.
 */

/** A configuration that is valid in production, as a baseline to spoil. */
// `undefined` is meaningful in an override: it removes a variable the baseline
// sets, which is how the "required when ..." guards are exercised.
function productionEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://neem:secret@db:5432/neem',
    SESSION_SECRET: 'a-real-production-session-secret-value-01',
    CSRF_SECRET: 'a-real-production-csrf-secret-value-000001',
    ENCRYPTION_KEY: 'a-real-production-encryption-key-value-001',
    WEB_ORIGIN: 'https://app.neem.example',
    PAYMENT_PROVIDER: 'paystack',
    PAYSTACK_SECRET_KEY: 'sk_live_not_a_real_key',
    PAYSTACK_PUBLIC_KEY: 'pk_live_not_a_real_key',
    PAYSTACK_WEBHOOK_SECRET: 'a-real-webhook-secret-value-00000000000001',
    VIDEO_PROVIDER: 'whereby',
    WHEREBY_API_KEY: 'a-real-whereby-api-key-value-000000001',
    SMS_PROVIDER: 'hubtel',
    HUBTEL_CLIENT_ID: 'a-real-hubtel-client-id',
    HUBTEL_CLIENT_SECRET: 'a-real-hubtel-client-secret',
    HUBTEL_SENDER_ID: 'Neem',
    // Call Me is switched off rather than mocked (D38).
    VOICE_PROVIDER: 'none',
    EMAIL_PROVIDER: 'smtp',
    SMTP_HOST: 'smtp.example.com',
    SMTP_PORT: '587',
    SEED_DEMO_DATA: 'false',
    ...overrides,
  };
}

/**
 * Which variables a configuration is refused over.
 *
 * `loadEnv` renders its issues into one message — "  - KEY: reason" per line —
 * so this reads them back rather than duplicating the parse. Asserting on the
 * set of keys is what makes "voice and SMS are the ONLY things wrong" a real
 * claim; a `toThrow(/SMS_PROVIDER/)` would pass just as happily with five
 * other things broken too.
 */
function collectIssues(source: NodeJS.ProcessEnv): Array<{ path: string[] }> {
  try {
    loadEnv(source);
    return [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return message
      .split(/\r?\n/)
      .filter((line) => line.trimStart().startsWith('- '))
      .map((line) => ({ path: [line.trim().slice(2).split(':')[0]!.trim()] }));
  }
}

describe('the production configuration baseline', () => {
  /**
   * **A production configuration is completable again.**
   *
   * It was not, between D36 and D38. Removing Twilio left voice, SMS and
   * WhatsApp with no provider, and production refuses a mock — so no value
   * existed that it would accept. D37 gave SMS a real provider; D38 gave voice
   * an honest "off".
   *
   * That `none` is accepted where `mock` is refused is the whole point, and
   * the two assertions below are what would notice if somebody collapsed the
   * distinction to make a deploy go through.
   */
  it('is valid, so a failure below is caused by the override', () => {
    expect(() => loadEnv(productionEnv())).not.toThrow();
  });

  it('accepts Call Me switched off, because "off" is not "pretending"', () => {
    // `none` reports no call. Nothing offers the mode to a patient and the
    // routes refuse it (D38).
    expect(collectIssues(productionEnv({ VOICE_PROVIDER: 'none' }))).toEqual([]);
  });

  it('still refuses a mocked voice provider', () => {
    /**
     * The distinction that makes `none` safe. A mock reports a bridged call
     * that never happened; that must never run in production, and switching a
     * capability off must not become a way to smuggle one in.
     */
    const issues = collectIssues(productionEnv({ VOICE_PROVIDER: 'mock' }));

    expect(issues.map((issue) => issue.path.join('.'))).toEqual(['VOICE_PROVIDER']);
  });

  it('refuses Hubtel without the sender ID that makes it deliver', () => {
    /**
     * An unregistered or absent alphanumeric sender is accepted by Hubtel's
     * API and dropped by the network, silently. Boot-time is the only place
     * that failure can still be made loud.
     */
    expect(() => loadEnv(productionEnv({ HUBTEL_SENDER_ID: undefined }))).toThrow(
      /HUBTEL_SENDER_ID/,
    );
  });

  it('refuses Hubtel without its credentials', () => {
    expect(() => loadEnv(productionEnv({ HUBTEL_CLIENT_SECRET: undefined }))).toThrow(
      /HUBTEL_CLIENT_SECRET/,
    );
  });
});

/**
 * The guard added after the pharmacy-verification review.
 *
 * The development `.env` raises these to 500 so the E2E suite is not throttled
 * by its own runs. Nothing checked that they were lowered again, so a copied
 * file would have shipped a login endpoint permitting hundreds of attempts per
 * IP per window.
 */
describe('rate limits raised for development', () => {
  const cases: Array<[string, string]> = [
    ['RATE_LIMIT_AUTH_MAX', '500'],
    ['RATE_LIMIT_ONBOARDING_MAX', '500'],
    ['RATE_LIMIT_QR_EXCHANGE_MAX', '500'],
    ['RATE_LIMIT_MAX_PER_MINUTE', '10000'],
    ['LOGIN_MAX_ATTEMPTS', '500'],
  ];

  for (const [key, devValue] of cases) {
    it(`refuses to boot production with ${key}=${devValue}`, () => {
      expect(() => loadEnv(productionEnv({ [key]: devValue }))).toThrow(
        new RegExp(`${key}=${devValue} is too permissive`),
      );
    });
  }

  it('names the file to look at, so the fix is obvious from the message', () => {
    expect(() => loadEnv(productionEnv({ RATE_LIMIT_AUTH_MAX: '500' }))).toThrow(/\.env\.example/);
  });

  it('accepts the values shipped in .env.example', () => {
    /**
     * Asserted on the issues rather than on `not.toThrow()`.
     *
     * The baseline no longer loads at all — voice and SMS have no provider
     * since D36 — so "does it throw" cannot distinguish a rate limit being
     * refused from a channel being missing. This asserts the thing the test
     * is actually about: that none of these five values is complained about.
     */
    const flagged = collectIssues(
      productionEnv({
        RATE_LIMIT_MAX_PER_MINUTE: '120',
        RATE_LIMIT_AUTH_MAX: '10',
        RATE_LIMIT_ONBOARDING_MAX: '5',
        RATE_LIMIT_QR_EXCHANGE_MAX: '20',
        LOGIN_MAX_ATTEMPTS: '5',
      }),
    ).map((issue) => issue.path.join('.'));

    expect(
      flagged.filter((key) => key.startsWith('RATE_LIMIT_') || key === 'LOGIN_MAX_ATTEMPTS'),
    ).toEqual([]);
  });

  it('leaves development alone — the suite depends on the loose values', () => {
    expect(() =>
      loadEnv({
        NODE_ENV: 'development',
        DATABASE_URL: 'postgresql://neem:neem_dev@localhost:5433/neem',
        SESSION_SECRET: 'dev-session-secret-value-00000000000000001',
        CSRF_SECRET: 'dev-csrf-secret-value-000000000000000000001',
        ENCRYPTION_KEY: 'dev-encryption-key-value-0000000000000001',
        RATE_LIMIT_AUTH_MAX: '500',
        RATE_LIMIT_ONBOARDING_MAX: '500',
        RATE_LIMIT_QR_EXCHANGE_MAX: '500',
      }),
    ).not.toThrow();
  });
});

/** The pre-existing guards, covered here because nothing else asserted them. */
describe('the other production guards', () => {
  it('refuses a mock provider', () => {
    expect(() => loadEnv(productionEnv({ PAYMENT_PROVIDER: 'mock' }))).toThrow(
      /a mock adapter cannot verify that anything actually happened/,
    );
  });

  /**
   * The Twilio sender-number guards lived here until D36.
   *
   * They asserted that selecting a channel without the number it sends from
   * was refused at boot rather than at the first message. There is nothing
   * left to assert: no provider can be selected for those channels at all.
   * Whatever replaces Twilio needs the same guard on its own credentials, and
   * this note is here so that requirement is not rediscovered the hard way.
   */

  it('refuses MailHog, which is a mock by another name', () => {
    expect(() => loadEnv(productionEnv({ EMAIL_PROVIDER: 'mailhog' }))).toThrow(
      /not permitted in production/,
    );
  });

  it('refuses demo seeding', () => {
    expect(() => loadEnv(productionEnv({ SEED_DEMO_DATA: 'true' }))).toThrow(
      /SEED_DEMO_DATA must be false in production/,
    );
  });

  it('refuses a secret still holding the development placeholder', () => {
    expect(() =>
      loadEnv(productionEnv({ SESSION_SECRET: 'dev-only-change-me-session-secret-value-1' })),
    ).toThrow(/still holds the development placeholder/);
  });
});
