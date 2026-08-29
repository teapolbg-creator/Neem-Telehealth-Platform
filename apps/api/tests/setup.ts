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
