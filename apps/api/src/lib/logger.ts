import { pino, type Logger } from 'pino';
import { getEnv, mockedProviders } from '../config/env.ts';

/**
 * Structured logging.
 *
 * The redaction list is not advisory — logs must never carry clinical notes,
 * patient identifiers, credentials, or tokens (spec §60, §87). Anything added
 * to a log context that matches a path below is replaced before it is written.
 */
const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'password',
  'currentPassword',
  'newPassword',
  'passwordHash',
  'token',
  'tokenHash',
  'accessToken',
  'refreshToken',
  'csrfToken',
  'secret',
  'twoFactorSecret',
  'code',
  'phone',
  'phoneNumber',
  'paymentPhone',
  'patientName',
  'fullName',
  'notes',
  'clinicalNotes',
  'diagnosis',
  'treatment',
  'signature',
  'signatureData',
  'cardNumber',
  'cvv',
  '*.password',
  '*.token',
  '*.phone',
  '*.patientName',
  '*.notes',
  '*.diagnosis',
];

let rootLogger: Logger | undefined;

export function createLogger(): Logger {
  const env = getEnv();
  const isDev = env.NODE_ENV === 'development';

  return pino({
    level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    base: {
      service: 'neem-api',
      env: env.NODE_ENV,
      // Every line carries which providers are mocked, so a log can never be
      // mistaken for evidence that a real payment or call occurred.
      mocked: mockedProviders(env).join(',') || 'none',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(isDev
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service,env' },
          },
        }
      : {}),
  });
}

export function getLogger(): Logger {
  rootLogger ??= createLogger();
  return rootLogger;
}

export function resetLoggerForTesting(): void {
  rootLogger = undefined;
}
