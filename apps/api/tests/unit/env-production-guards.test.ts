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
    DATABASE_URL: 'mysql://neem:secret@db:3306/neem',
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
    // Voice, SMS and WhatsApp have no real provider since D36 removed Twilio.
    // A production environment therefore cannot select one, which is itself
    // asserted below.
    SMS_PROVIDER: 'mock',
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
   * **This build cannot be deployed to production, and the test says so.**
   *
   * Removing Twilio (D36) left voice, SMS and WhatsApp with no real provider
   * at all. Production refuses a mock adapter — correctly, because a mock
   * reports messages that were never sent — so there is now no value for
   * `VOICE_PROVIDER` or `SMS_PROVIDER` that a production environment accepts.
   *
   * That is the honest state of the product rather than a broken test. SMS is
   * load-bearing: a patient's consultation reference reaches them that way and
   * it is their only route back to their own record (D24). Launching without
   * it is a decision someone has to take deliberately.
   *
   * When an SMS provider lands, this test becomes `not.toThrow()` again and
   * the assertion below is deleted. Until then it is what stops "we are ready
   * to deploy" being said by accident.
   */
  it('cannot be completed, because voice and SMS have no provider', () => {
    expect(() => loadEnv(productionEnv())).toThrow(/nothing else to set it to/);
  });

  it('says which capability is missing rather than blaming the config', () => {
    // An operator told only "mock is not permitted" goes looking for a setting
    // they got wrong. There isn't one.
    expect(() => loadEnv(productionEnv())).toThrow(/gap in the build, not a mistake in this file/);
  });

  it('is otherwise valid, so a failure below is caused by the override', () => {
    /**
     * The rest of the baseline still has to be sound, or every test after this
     * one would pass for the wrong reason. Voice and SMS are the only things
     * wrong with it, and this asserts exactly that.
     */
    const issues = collectIssues(productionEnv());

    expect(issues.map((issue) => issue.path.join('.')).sort()).toEqual([
      'SMS_PROVIDER',
      'VOICE_PROVIDER',
    ]);
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
        DATABASE_URL: 'mysql://neem:neem_dev@localhost:3307/neem',
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
