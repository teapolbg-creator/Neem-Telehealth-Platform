import { z } from 'zod';

/**
 * Environment configuration.
 *
 * Validated at boot. In production the process REFUSES TO START when a
 * required credential is missing, rather than silently degrading to a mock
 * (spec §7). In development, an absent provider credential selects the mock
 * adapter and logs a prominent warning.
 */

/** Placeholders shipped in .env.example. Rejected outright in production. */
const DEV_PLACEHOLDER = /^dev-only-change-me/;

/**
 * A secret's length is checked here; whether it is still a placeholder is
 * checked in the production block below.
 *
 * The placeholder check used to live on this schema and read
 * `process.env.NODE_ENV` directly. That meant it ignored the configuration
 * actually being validated — `loadEnv(source)` takes a source precisely so it
 * need not depend on ambient process state — which made the guard both
 * untestable and inconsistent with every other production rule.
 */
const secret = (name: string, minLength = 32) =>
  z.string().min(minLength, `${name} must be at least ${minLength} characters`);

const bool = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .transform((v) => v === 'true' || v === '1')
    .default(fallback ? 'true' : 'false');

const port = z.coerce.number().int().min(1).max(65535);

export const PROVIDER_MODES = {
  payment: ['mock', 'paystack'],
  video: ['mock', 'whereby'],
  /**
   * Voice, where `none` means the capability is switched off.
   *
   * "Call Me" bridges two telephone legs so neither party learns the other's
   * number (spec §33). Whereby cannot — it is browser-to-browser — and no
   * Ghanaian provider checked so far publishes call bridging (D36, D37).
   *
   * `none` and `mock` are deliberately different states, and conflating them
   * is what kept production from booting at all. A **mock pretends**: it
   * reports a call that never happened, which is why production refuses it.
   * **`none` does not pretend** — the mode is not offered to a patient, the
   * routes refuse it, and nothing anywhere claims a call took place. That is a
   * product decision a deployment is allowed to make (D38).
   */
  voice: ['none', 'mock'],
  sms: ['mock', 'arkesel', 'hubtel'],
  email: ['mock', 'mailhog', 'smtp'],
  whatsapp: ['mock'],
} as const;

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_PORT: port.default(4000),
    WEB_ORIGIN: z.string().url().default('http://localhost:3000'),
    API_PUBLIC_URL: z.string().url().default('http://localhost:4000'),
    // 'silent' is a real pino level and is what test runs use.
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    DATABASE_URL: z.string().min(1),
    TEST_DATABASE_URL: z.string().optional(),
    AUDIT_DATABASE_URL: z.string().optional(),

    SESSION_SECRET: secret('SESSION_SECRET'),
    CSRF_SECRET: secret('CSRF_SECRET'),
    ENCRYPTION_KEY: secret('ENCRYPTION_KEY'),
    /**
     * Retired keys, comma-separated. Decrypt-only — never used to encrypt.
     *
     * Clinical records are held for years (D23), so the key that wrote them
     * will outlive its own sensible lifetime. This lets a rotation happen
     * without a flag day: the new key encrypts, the old one still decrypts,
     * and re-encryption proceeds at leisure. See src/lib/crypto.ts.
     */
    ENCRYPTION_KEY_PREVIOUS: z.string().optional(),

    SESSION_IDLE_TIMEOUT_MINUTES: z.coerce.number().int().min(1).default(30),
    SESSION_ABSOLUTE_TIMEOUT_HOURS: z.coerce.number().int().min(1).default(12),
    PATIENT_SESSION_TIMEOUT_MINUTES: z.coerce.number().int().min(1).default(60),

    LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
    LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().min(1).default(15),
    RATE_LIMIT_MAX_PER_MINUTE: z.coerce.number().int().min(1).default(120),
    // Stricter per-IP limits on the endpoints an attacker actually hammers:
    // login, 2FA verification and password reset (docs/security.md §6).
    // Separate from LOGIN_MAX_ATTEMPTS, which locks a single account; this
    // caps attempts from one source across many accounts.
    RATE_LIMIT_AUTH_MAX: z.coerce.number().int().min(1).default(10),
    RATE_LIMIT_AUTH_WINDOW: z.string().default('15 minutes'),
    // Account creation, limited per source.
    RATE_LIMIT_ONBOARDING_MAX: z.coerce.number().int().min(1).default(5),
    RATE_LIMIT_ONBOARDING_WINDOW: z.string().default('1 hour'),
    // QR token exchange. A busy pharmacy shares one public IP, so this has to
    // accommodate a genuine queue of patients scanning in quick succession
    // while still blocking a script guessing tokens.
    RATE_LIMIT_QR_EXCHANGE_MAX: z.coerce.number().int().min(1).default(20),
    RATE_LIMIT_QR_EXCHANGE_WINDOW: z.string().default('5 minutes'),

    PAYMENT_PROVIDER: z.enum(PROVIDER_MODES.payment).default('mock'),
    VIDEO_PROVIDER: z.enum(PROVIDER_MODES.video).default('mock'),
    VOICE_PROVIDER: z.enum(PROVIDER_MODES.voice).default('none'),
    SMS_PROVIDER: z.enum(PROVIDER_MODES.sms).default('mock'),
    EMAIL_PROVIDER: z.enum(PROVIDER_MODES.email).default('mock'),
    WHATSAPP_PROVIDER: z.enum(PROVIDER_MODES.whatsapp).default('mock'),

    PAYSTACK_SECRET_KEY: z.string().optional(),
    PAYSTACK_PUBLIC_KEY: z.string().optional(),
    /**
     * Paystack signs webhooks with the account's SECRET key. This exists only
     * so the two can be separated in a test harness; leave it unset in
     * production and the secret key is used, which is the real arrangement.
     */
    PAYSTACK_WEBHOOK_SECRET: z.string().optional(),
    PAYSTACK_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(15_000),

    /**
     * Whereby Embedded (decision D18).
     *
     * One credential: a Bearer API key from the Whereby dashboard. There is no
     * second secret and no webhook signing key, because this adapter receives
     * no webhooks — Neem's own state machine decides when a consultation is
     * over, not the video provider.
     */
    WHEREBY_API_KEY: z.string().optional(),
    WHEREBY_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(15_000),

    /**
     * Hubtel SMS (decision D37).
     *
     * Two credentials and a sender name. The sender is alphanumeric — Ghana's
     * networks reject numeric international senders — and must be registered
     * with the networks before anything it sends will be delivered.
     */
    /**
     * Arkesel SMS (decision D39). The configured provider.
     *
     * One key and a sender name. The sender is alphanumeric and must be
     * registered with the networks — Ghana blocks unregistered senders, and an
     * unregistered one is accepted by the API and dropped by the network.
     */
    ARKESEL_API_KEY: z.string().optional(),
    ARKESEL_SENDER_ID: z.string().max(11).optional(),
    ARKESEL_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(15_000),

    HUBTEL_CLIENT_ID: z.string().optional(),
    HUBTEL_CLIENT_SECRET: z.string().optional(),
    HUBTEL_SENDER_ID: z.string().max(11).optional(),
    HUBTEL_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(15_000),
    /**
     * Domain for the synthetic per-transaction address Paystack requires.
     *
     * Neem collects a phone number at the counter, never an email. The address
     * is derived from our own payment reference and carries no patient data.
     */
    PAYSTACK_RECEIPT_DOMAIN: z.string().min(3).default('receipts.neem.local'),

    SMTP_HOST: z.string().default('localhost'),
    SMTP_PORT: port.default(1025),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    SMTP_FROM: z.string().default('Neem <no-reply@neem.local>'),

    SMS_API_KEY: z.string().optional(),
    SMS_SENDER_ID: z.string().default('Neem'),
    WHATSAPP_API_KEY: z.string().optional(),
    WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),

    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    STORAGE_LOCAL_PATH: z.string().default('./apps/api/uploads'),
    UPLOAD_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(1024)
      .default(10 * 1024 * 1024),

    SEED_DEMO_DATA: bool(true),
    DEMO_ADMIN_EMAIL: z.string().email().default('admin@neem.demo'),
    DEMO_ADMIN_PASSWORD: z.string().min(12).default('NeemDemoAdmin!2026'),
  })
  /**
   * A provider set to a real implementation must carry real credentials.
   * Failing here is deliberate: a half-configured payment provider in
   * production is worse than a refusal to boot.
   */
  .superRefine((env, ctx) => {
    const require = (path: string, value: unknown, because: string) => {
      if (!value) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [path],
          message: `${path} is required ${because}`,
        });
      }
    };

    if (env.PAYMENT_PROVIDER === 'paystack') {
      require('PAYSTACK_SECRET_KEY', env.PAYSTACK_SECRET_KEY, 'when PAYMENT_PROVIDER=paystack');
      require('PAYSTACK_PUBLIC_KEY', env.PAYSTACK_PUBLIC_KEY, 'when PAYMENT_PROVIDER=paystack');
      /**
       * PAYSTACK_WEBHOOK_SECRET is deliberately NOT required.
       *
       * It was, on the reasoning that webhooks must be signature-verified —
       * which is true, and is exactly why requiring it was wrong: Paystack
       * signs with the secret key, so demanding a second value invited an
       * operator to invent one, and every real webhook would then fail its
       * signature check. The adapter falls back to the secret key, which is
       * already required above.
       */
    }

    if (env.EMAIL_PROVIDER === 'smtp') {
      require('SMTP_HOST', env.SMTP_HOST, 'when EMAIL_PROVIDER=smtp');
      require('SMTP_FROM', env.SMTP_FROM, 'when EMAIL_PROVIDER=smtp');
    }

    if (env.VIDEO_PROVIDER === 'whereby') {
      require('WHEREBY_API_KEY', env.WHEREBY_API_KEY, 'when VIDEO_PROVIDER=whereby');
    }

    if (env.SMS_PROVIDER === 'arkesel') {
      require('ARKESEL_API_KEY', env.ARKESEL_API_KEY, 'when SMS_PROVIDER=arkesel');
      /**
       * Required, not defaulted — the same reasoning as Hubtel's.
       *
       * Ghana's networks reject a numeric international sender outright and
       * block unregistered alphanumeric ones. A default would boot cleanly and
       * deliver nothing, which is the worst shape of failure: the deployment
       * looks healthy while every patient's reference is dropped.
       */
      require('ARKESEL_SENDER_ID', env.ARKESEL_SENDER_ID, 'when SMS_PROVIDER=arkesel');
    }

    if (env.SMS_PROVIDER === 'hubtel') {
      require('HUBTEL_CLIENT_ID', env.HUBTEL_CLIENT_ID, 'when SMS_PROVIDER=hubtel');
      require('HUBTEL_CLIENT_SECRET', env.HUBTEL_CLIENT_SECRET, 'when SMS_PROVIDER=hubtel');
      /**
       * Required, not defaulted.
       *
       * Ghana's networks reject a numeric international sender outright and
       * block unregistered alphanumeric ones. A default would boot cleanly and
       * then deliver nothing — the worst shape of failure, because the
       * deployment looks healthy while every patient's reference is dropped.
       */
      require('HUBTEL_SENDER_ID', env.HUBTEL_SENDER_ID, 'when SMS_PROVIDER=hubtel');
    }

    if (env.NODE_ENV === 'production') {
      // A secret still holding the value shipped in .env.example is a secret
      // an attacker already has.
      for (const [key, value] of [
        ['SESSION_SECRET', env.SESSION_SECRET],
        ['CSRF_SECRET', env.CSRF_SECRET],
        ['ENCRYPTION_KEY', env.ENCRYPTION_KEY],
      ] as const) {
        if (DEV_PLACEHOLDER.test(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} still holds the development placeholder — generate a real secret before running in production`,
          });
        }
      }

      // Mock adapters must never run in production — they would report
      // payments and messages that never happened (spec §93).
      const mocked = (
        [
          ['PAYMENT_PROVIDER', env.PAYMENT_PROVIDER],
          ['VIDEO_PROVIDER', env.VIDEO_PROVIDER],
          ['VOICE_PROVIDER', env.VOICE_PROVIDER],
          ['SMS_PROVIDER', env.SMS_PROVIDER],
          ['EMAIL_PROVIDER', env.EMAIL_PROVIDER],
        ] as const
      ).filter(([, value]) => value === 'mock' || value === 'mailhog');

      /**
       * Two different problems wear the same value.
       *
       * `mock` in production is usually a configuration slip: a real provider
       * exists and was not selected. But for voice, SMS and WhatsApp there is
       * no longer a real provider to select — Twilio was removed in D36 and
       * nothing replaced it — so `mock` there is not a slip, it is the whole
       * capability being absent.
       *
       * An operator who reads "not permitted in production" for SMS will go
       * looking for the setting they got wrong, and there isn't one. Saying so
       * turns a confusing hour into a decision: choose a provider, or launch
       * without that channel and accept what it costs.
       */
      const unbuilt: Record<string, string> = {
        VOICE_PROVIDER:
          'no telephony provider is implemented. Set VOICE_PROVIDER=none to switch "Call Me" ' +
          'off honestly — the mode is then not offered to patients and the routes refuse it, ' +
          'rather than a mock reporting calls that never happened (D38)',
      };

      for (const [key, value] of mocked) {
        const reason = unbuilt[key];

        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: reason
            ? `${key}="${value}" is not permitted in production, and there is nothing else to ` +
              `set it to: ${reason}. This is a gap in the build, not a mistake in this file.`
            : `${key}="${value}" is not permitted in production — a mock adapter cannot verify ` +
              'that anything actually happened',
        });
      }

      if (env.SEED_DEMO_DATA) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SEED_DEMO_DATA'],
          message: 'SEED_DEMO_DATA must be false in production (spec §76)',
        });
      }

      /**
       * Rate limits raised for local development must never reach production.
       *
       * The end-to-end suite throttles itself against production-shaped
       * limits, so `.env` carries deliberately loose values. Copying that file
       * to a server would ship a login endpoint that permits hundreds of
       * attempts per IP per window — the single most plausible way this
       * repository ends up with an open front door, and nothing checked for it
       * (docs/security.md §6).
       *
       * These are ceilings, not the recommended values. `.env.example` holds
       * those, and they sit far below these limits.
       */
      for (const [key, value, ceiling, note] of PRODUCTION_RATE_LIMIT_CEILINGS(env)) {
        if (value > ceiling) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message:
              `${key}=${value} is too permissive for production (ceiling ${ceiling}). ` +
              `${note} This value is raised in the development .env so the test suite is not ` +
              `throttled; see .env.example for the production value.`,
          });
        }
      }
    }
  });

/**
 * Upper bounds on the per-IP rate limits, enforced only in production.
 *
 * Chosen to catch a development configuration that has been copied to a
 * server, not to dictate policy — each ceiling sits well above the value in
 * `.env.example` and well below the loosened development one.
 */
const PRODUCTION_RATE_LIMIT_CEILINGS = (env: {
  RATE_LIMIT_MAX_PER_MINUTE: number;
  RATE_LIMIT_AUTH_MAX: number;
  RATE_LIMIT_ONBOARDING_MAX: number;
  RATE_LIMIT_QR_EXCHANGE_MAX: number;
  LOGIN_MAX_ATTEMPTS: number;
}): Array<[string, number, number, string]> => [
  [
    'RATE_LIMIT_AUTH_MAX',
    env.RATE_LIMIT_AUTH_MAX,
    50,
    'This caps password, two-factor and reset attempts from one source across every account.',
  ],
  [
    'RATE_LIMIT_ONBOARDING_MAX',
    env.RATE_LIMIT_ONBOARDING_MAX,
    50,
    'This caps account creation from one source.',
  ],
  [
    // A busy pharmacy shares one public IP and a queue of patients scan in
    // quick succession, so this legitimately needs more headroom than the
    // others — but not hundreds.
    'RATE_LIMIT_QR_EXCHANGE_MAX',
    env.RATE_LIMIT_QR_EXCHANGE_MAX,
    200,
    'This caps QR token exchange attempts, which is what stops a script guessing tokens.',
  ],
  [
    'RATE_LIMIT_MAX_PER_MINUTE',
    env.RATE_LIMIT_MAX_PER_MINUTE,
    1_000,
    'This is the global per-principal ceiling.',
  ],
  [
    'LOGIN_MAX_ATTEMPTS',
    env.LOGIN_MAX_ATTEMPTS,
    20,
    'This is the per-account lockout threshold, distinct from the per-IP limit.',
  ],
];

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    throw new Error(
      `Invalid environment configuration:\n${lines.join('\n')}\n\n` +
        `Copy .env.example to .env and fill in the required values.`,
    );
  }

  return parsed.data;
}

export function getEnv(): Env {
  cached ??= loadEnv();
  return cached;
}

/** Test seam — lets a test install a specific configuration. */
export function setEnvForTesting(env: Env | undefined): void {
  cached = env;
}

/** Providers currently running as mocks. Surfaced in the UI and health check. */
export function mockedProviders(env: Env): string[] {
  return (
    [
      ['payment', env.PAYMENT_PROVIDER],
      ['video', env.VIDEO_PROVIDER],
      ['voice', env.VOICE_PROVIDER],
      ['sms', env.SMS_PROVIDER],
      ['email', env.EMAIL_PROVIDER],
      ['whatsapp', env.WHATSAPP_PROVIDER],
    ] as const
  )
    .filter(([, mode]) => mode === 'mock')
    .map(([name]) => name);
}
