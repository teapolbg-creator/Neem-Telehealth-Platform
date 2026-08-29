/**
 * Test bootstrap.
 *
 * Installs a deterministic configuration so unit tests never depend on the
 * developer's .env, and so secrets used in tests are obviously test secrets.
 */
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'mysql://neem:neem_dev@localhost:3307/neem_test';
process.env.TEST_DATABASE_URL ??= process.env.DATABASE_URL;
process.env.SESSION_SECRET = 'test-session-secret-value-000000000000000000';
process.env.CSRF_SECRET = 'test-csrf-secret-value-0000000000000000000000';
process.env.ENCRYPTION_KEY = 'test-encryption-key-value-000000000000000000';
process.env.LOG_LEVEL = 'silent';
process.env.SEED_DEMO_DATA = 'false';

// The functional tests exercise many sign-ins in quick succession. The auth
// rate limiter is verified deliberately in tests/integration/rate-limit.test.ts,
// which builds an app with a low limit; leaving it low here would throttle the
// suite and mask real failures.
process.env.RATE_LIMIT_AUTH_MAX = '10000';
process.env.RATE_LIMIT_MAX_PER_MINUTE = '10000';
process.env.RATE_LIMIT_ONBOARDING_MAX = '10000';
