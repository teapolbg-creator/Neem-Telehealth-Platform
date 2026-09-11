/**
 * Test bootstrap.
 *
 * Installs a deterministic configuration so unit tests never depend on the
 * developer's .env, and so secrets used in tests are obviously test secrets.
 */
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://neem:neem_dev@localhost:5433/neem_test';
process.env.TEST_DATABASE_URL ??= process.env.DATABASE_URL;
// The schema declares directUrl, and Prisma refuses to start if the variable it
// names is missing. Migrations never run from here, so it points at the same
// database rather than at a second one.
process.env.DIRECT_DATABASE_URL ??= process.env.DATABASE_URL;
process.env.SESSION_SECRET = 'test-session-secret-value-000000000000000000';
process.env.CSRF_SECRET = 'test-csrf-secret-value-0000000000000000000000';
process.env.ENCRYPTION_KEY = 'test-encryption-key-value-000000000000000000';
process.env.LOG_LEVEL = 'silent';
process.env.SEED_DEMO_DATA = 'false';

/*
 * No test may reach a real gateway.
 *
 * Stated plainly, because it was first written as a fix for a bug that does
 * not exist: **Vitest never loads `.env`**. Only `src/server.ts` imports
 * `load-dotenv`, so under this bootstrap the provider variables are unset and
 * fall through to their schema defaults, which are already `mock`. The suite
 * could not have reached Arkesel however `.env` was configured.
 *
 * These three lines are therefore belt and braces, not a repair, and they earn
 * their place cheaply: they make the guarantee explicit rather than emergent
 * from a default somebody could reasonably change, and they hold if this file
 * or `config/env.ts` ever starts reading `.env`. That is not far-fetched — the
 * e2e suite runs the real server, which does load it, and is protected
 * separately in `playwright.config.ts`.
 *
 * Assignment rather than `??=` so it wins if `.env` ever is in play. The
 * adapter tests set these themselves after this file runs and stub `fetch`,
 * so what they verify is untouched.
 */
process.env.SMS_PROVIDER = 'mock';
process.env.EMAIL_PROVIDER = 'mock';
process.env.WHATSAPP_PROVIDER = 'mock';

// The functional tests exercise many sign-ins in quick succession. The auth
// rate limiter is verified deliberately in tests/integration/rate-limit.test.ts,
// which builds an app with a low limit; leaving it low here would throttle the
// suite and mask real failures.
process.env.RATE_LIMIT_AUTH_MAX = '10000';
process.env.RATE_LIMIT_MAX_PER_MINUTE = '10000';
process.env.RATE_LIMIT_ONBOARDING_MAX = '10000';
process.env.RATE_LIMIT_QR_EXCHANGE_MAX = '10000';
process.env.RATE_LIMIT_CALL_MAX = '10000';
