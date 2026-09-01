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
function productionEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
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
    VIDEO_PROVIDER: 'twilio',
    VOICE_PROVIDER: 'twilio',
    SMS_PROVIDER: 'twilio',
    EMAIL_PROVIDER: 'smtp',
    TWILIO_ACCOUNT_SID: 'AC00000000000000000000000000000001',
    TWILIO_AUTH_TOKEN: 'a-real-twilio-auth-token-value-0000000001',
    TWILIO_VOICE_NUMBER: '+233200000000',
    SMTP_HOST: 'smtp.example.com',
    SMTP_PORT: '587',
    SEED_DEMO_DATA: 'false',
    ...overrides,
  };
}

describe('the production configuration baseline', () => {
  it('is itself valid, so a failure below is caused by the override', () => {
    expect(() => loadEnv(productionEnv())).not.toThrow();
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
    expect(() => loadEnv(productionEnv({ RATE_LIMIT_AUTH_MAX: '500' }))).toThrow(
      /\.env\.example/,
    );
  });

  it('accepts the values shipped in .env.example', () => {
    expect(() =>
      loadEnv(
        productionEnv({
          RATE_LIMIT_MAX_PER_MINUTE: '120',
          RATE_LIMIT_AUTH_MAX: '10',
          RATE_LIMIT_ONBOARDING_MAX: '5',
          RATE_LIMIT_QR_EXCHANGE_MAX: '20',
          LOGIN_MAX_ATTEMPTS: '5',
        }),
      ),
    ).not.toThrow();
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
