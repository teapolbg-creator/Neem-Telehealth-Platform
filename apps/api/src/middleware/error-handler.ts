import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { ZodError } from 'zod';
import { ERROR_CODES } from '@neem/contracts';
import { AppError, isAppError } from '../lib/errors.ts';
import { isUniqueConstraintError } from '../db/prisma.ts';

/**
 * Central error handling.
 *
 * Two rules:
 *   1. The client receives a machine-readable code and a message safe to show
 *      a pharmacist or a patient. Never a stack trace, SQL, or provider payload.
 *   2. Everything an operator needs is logged with the correlation id, through
 *      the redaction list.
 *
 * The system must never be left in an ambiguous state (spec §67), so every
 * error maps to a definite status and code — there is no silent fall-through.
 */
export const errorHandlerPlugin = fp(async (app: FastifyInstance) => {
  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: { code: ERROR_CODES.NOT_FOUND, message: 'That endpoint does not exist.' },
      meta: { requestId: request.correlationId },
    });
  });

  // Typed loosely on purpose: what arrives here is a FastifyError, one of our
  // AppErrors, a ZodError, a Prisma error, or something genuinely unexpected.
  app.setErrorHandler((rawError: unknown, request, reply) => {
    const error = rawError as Error & { statusCode?: number };
    const meta = { requestId: request.correlationId };

    if (isAppError(error)) {
      // 5xx AppErrors are genuine faults; 4xx are expected outcomes.
      const level = error.statusCode >= 500 ? 'error' : 'info';
      request.log[level](
        {
          err: error.statusCode >= 500 ? error : undefined,
          code: error.code,
          statusCode: error.statusCode,
          route: request.routeOptions.url,
          principal: request.principal?.userPublicId,
          ...error.logContext,
        },
        error.message,
      );

      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
        meta,
      });
    }

    /**
     * A sealed clinical record (decision D23).
     *
     * Mapped centrally rather than at each call site: the sealing rule applies
     * everywhere clinical data is read, and a route that forgot to catch it
     * would answer 500 — which reads as a broken server rather than a refusal,
     * and buries the actual reason in a stack trace.
     *
     * 403 with the rule stated, so a doctor reopening a finished consultation
     * is told why rather than seeing an error page.
     */
    if (error.name === 'ClinicalRecordSealed') {
      request.log.info(
        { route: request.routeOptions.url, principal: request.principal?.userPublicId },
        'refused a read of a sealed clinical record',
      );

      return reply.status(403).send({
        error: { code: ERROR_CODES.FORBIDDEN, message: error.message },
        meta,
      });
    }

    if (error instanceof ZodError) {
      const details = error.issues.map((issue) => ({
        field: issue.path.join('.') || undefined,
        issue: issue.message,
      }));
      request.log.info({ details, route: request.routeOptions.url }, 'request validation failed');

      return reply.status(400).send({
        error: {
          code: ERROR_CODES.VALIDATION_FAILED,
          message: 'The submitted data is not valid.',
          details,
        },
        meta,
      });
    }

    if (isUniqueConstraintError(error)) {
      request.log.warn({ route: request.routeOptions.url }, 'unique constraint violated');
      return reply.status(409).send({
        error: {
          code: ERROR_CODES.CONFLICT,
          message: 'That record already exists.',
        },
        meta,
      });
    }

    // Fastify's own errors (payload too large, bad JSON, rate limit) carry a
    // usable status code; anything else is ours and is a 500.
    const statusCode = typeof error.statusCode === 'number' ? error.statusCode : 500;

    if (statusCode === 429) {
      return reply.status(429).send({
        error: {
          code: ERROR_CODES.RATE_LIMITED,
          message: 'Too many requests. Please wait and try again.',
        },
        meta,
      });
    }

    if (statusCode < 500) {
      request.log.info({ err: error, route: request.routeOptions.url }, 'client error');
      return reply.status(statusCode).send({
        error: {
          code: ERROR_CODES.VALIDATION_FAILED,
          message: error.message || 'That request could not be processed.',
        },
        meta,
      });
    }

    request.log.error(
      { err: error, route: request.routeOptions.url, principal: request.principal?.userPublicId },
      'unhandled error',
    );

    return reply.status(500).send({
      error: {
        code: ERROR_CODES.INTERNAL_ERROR,
        message: 'Something went wrong on our side. Please try again.',
      },
      meta,
    });
  });
});

export { AppError };
