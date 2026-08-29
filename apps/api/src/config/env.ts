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

const secret = (name: string, minLength = 32) =>
  z
    .string()
    .min(minLength, `${name} must be at least ${minLength} characters`)
    .refine(
      (v) => process.env.NODE_ENV !== 'production' || !DEV_PLACEHOLDER.test(v),
      `${name} still holds the development placeholder — generate a real secret before running in production`,
    );

const bool = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .transform((v) => v === 'true' || v === '1')
    .default(fallback ? 'true' : 'false');

const port = z.coerce.number().int().min(1).max(65535);

export const PROVIDER_MODES = {
  payment: ['mock', 'paystack'],
  video: ['mock', 'twilio'],
  voice: ['mock', 'twilio'],
  sms: ['mock', 'twilio'],
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

    PAYMENT_PROVIDER: z.enum(PROVIDER_MODES.payment).default('mock'),
    VIDEO_PROVIDER: z.enum(PROVIDER_MODES.video).default('mock'),
    VOICE_PROVIDER: z.enum(PROVIDER_MODES.voice).default('mock'),
    SMS_PROVIDER: z.enum(PROVIDER_MODES.sms).default('mock'),
    EMAIL_PROVIDER: z.enum(PROVIDER_MODES.email).default('mock'),
    WHATSAPP_PROVIDER: z.enum(PROVIDER_MODES.whatsapp).default('mock'),

    PAYSTACK_SECRET_KEY: z.string().optional(),
    PAYSTACK_PUBLIC_KEY: z.string().optional(),
    PAYSTACK_WEBHOOK_SECRET: z.string().optional(),

    TWILIO_ACCOUNT_SID: z.string().optional(),
    TWILIO_AUTH_TOKEN: z.string().optional(),
    TWILIO_API_KEY_SID: z.string().optional(),
    TWILIO_API_KEY_SECRET: z.string().optional(),
    TWILIO_VOICE_NUMBER: z.string().optional(),

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
    UPLOAD_MAX_BYTES: z.coerce.number().int().min(1024).default(10 * 1024 * 1024),

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
      require(
        'PAYSTACK_WEBHOOK_SECRET',
        env.PAYSTACK_WEBHOOK_SECRET,
        'when PAYMENT_PROVIDER=paystack — webhooks must be signature-verified',
      );
    }

    const usesTwilio =
      env.VIDEO_PROVIDER === 'twilio' ||
      env.VOICE_PROVIDER === 'twilio' ||
      env.SMS_PROVIDER === 'twilio';
    if (usesTwilio) {
      require('TWILIO_ACCOUNT_SID', env.TWILIO_ACCOUNT_SID, 'when a Twilio provider is selected');
      require('TWILIO_AUTH_TOKEN', env.TWILIO_AUTH_TOKEN, 'when a Twilio provider is selected');
    }
    if (env.VOICE_PROVIDER === 'twilio') {
      require('TWILIO_VOICE_NUMBER', env.TWILIO_VOICE_NUMBER, 'for Call Me');
    }

    if (env.NODE_ENV === 'production') {
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

      for (const [key, value] of mocked) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key}="${value}" is not permitted in production — a mock adapter cannot verify that anything actually happened`,
        });
      }

      if (env.SEED_DEMO_DATA) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SEED_DEMO_DATA'],
          message: 'SEED_DEMO_DATA must be false in production (spec §76)',
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
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
