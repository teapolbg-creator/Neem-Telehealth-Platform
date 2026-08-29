import { ERROR_CODES, type ErrorCode } from '@neem/contracts';

/**
 * Application errors.
 *
 * `message` is user-facing and must never leak internals — no stack traces, no
 * SQL, no provider payloads. Anything an operator needs goes in `logContext`,
 * which is logged (through the redaction list) but never serialised to the
 * client. See docs/api.md §1.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly details?: Array<{ field?: string; issue: string }>;
  readonly logContext?: Record<string, unknown>;
  readonly expose = true;

  constructor(params: {
    statusCode: number;
    code: ErrorCode;
    message: string;
    details?: Array<{ field?: string; issue: string }>;
    logContext?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(params.message, params.cause ? { cause: params.cause } : undefined);
    this.name = 'AppError';
    this.statusCode = params.statusCode;
    this.code = params.code;
    this.details = params.details;
    this.logContext = params.logContext;
  }
}

export const errors = {
  validation: (details: Array<{ field?: string; issue: string }>, message = 'The submitted data is not valid.') =>
    new AppError({ statusCode: 400, code: ERROR_CODES.VALIDATION_FAILED, message, details }),

  unauthenticated: (message = 'You need to sign in to continue.') =>
    new AppError({ statusCode: 401, code: ERROR_CODES.UNAUTHENTICATED, message }),

  forbidden: (message = 'You do not have permission to do that.', logContext?: Record<string, unknown>) =>
    new AppError({ statusCode: 403, code: ERROR_CODES.FORBIDDEN, message, logContext }),

  /**
   * Used both for genuinely missing resources and for resources the caller is
   * not entitled to know exist. Returning 404 rather than 403 in the second
   * case prevents the API from confirming an identifier is real
   * (docs/security.md §4).
   */
  notFound: (message = 'Not found.', logContext?: Record<string, unknown>) =>
    new AppError({ statusCode: 404, code: ERROR_CODES.NOT_FOUND, message, logContext }),

  conflict: (message: string, logContext?: Record<string, unknown>) =>
    new AppError({ statusCode: 409, code: ERROR_CODES.CONFLICT, message, logContext }),

  invalidStateTransition: (from: string, to: string, entity = 'record') =>
    new AppError({
      statusCode: 409,
      code: ERROR_CODES.INVALID_STATE_TRANSITION,
      message: `This ${entity} cannot move from ${from} to ${to}.`,
      logContext: { from, to, entity },
    }),

  businessRule: (message: string, logContext?: Record<string, unknown>) =>
    new AppError({ statusCode: 422, code: ERROR_CODES.BUSINESS_RULE_VIOLATION, message, logContext }),

  rateLimited: (message = 'Too many requests. Please wait and try again.') =>
    new AppError({ statusCode: 429, code: ERROR_CODES.RATE_LIMITED, message }),

  accountLocked: (until: Date) =>
    new AppError({
      statusCode: 429,
      code: ERROR_CODES.ACCOUNT_LOCKED,
      message: 'This account is temporarily locked after too many failed sign-in attempts.',
      logContext: { lockedUntil: until.toISOString() },
    }),

  accountNotActive: (message = 'This account is not active. Contact Neem support.') =>
    new AppError({ statusCode: 403, code: ERROR_CODES.ACCOUNT_NOT_ACTIVE, message }),

  twoFactorInvalid: (message = 'That code is not valid. Check your authenticator app and try again.') =>
    new AppError({ statusCode: 401, code: ERROR_CODES.TWO_FACTOR_INVALID, message }),

  csrfInvalid: () =>
    new AppError({
      statusCode: 403,
      code: ERROR_CODES.CSRF_INVALID,
      message: 'Your session could not be verified. Refresh the page and try again.',
    }),

  providerUnavailable: (provider: string) =>
    new AppError({
      statusCode: 503,
      code: ERROR_CODES.PROVIDER_UNAVAILABLE,
      message: 'A required service is temporarily unavailable. Please try again shortly.',
      logContext: { provider },
    }),

  internal: (cause?: unknown) =>
    new AppError({
      statusCode: 500,
      code: ERROR_CODES.INTERNAL_ERROR,
      message: 'Something went wrong on our side. Please try again.',
      cause,
    }),
};

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
