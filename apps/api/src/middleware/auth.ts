import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { Permission, UserRole } from '@neem/contracts';
import { errors } from '../lib/errors.ts';
import {
  CSRF_HEADER,
  SESSION_COOKIE,
  resolveSession,
  touchSession,
  verifyCsrf,
} from '../modules/auth/session.service.ts';

/**
 * Authentication and authorization.
 *
 * Applied as route-level hooks rather than a global gate, so every protected
 * route declares its own requirement explicitly and an unguarded route is
 * visible in review rather than silently public (docs/security.md §4).
 */

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Resolves a session if one is present. Never rejects — for optional auth. */
export const authPlugin = fp(async (app: FastifyInstance) => {
  app.addHook('preHandler', async (request) => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return;

    const principal = await resolveSession(token);
    if (!principal) return;

    request.principal = principal;
    void touchSession(principal.sessionId);
  });
});

export function requireAuth(request: FastifyRequest): NonNullable<FastifyRequest['principal']> {
  if (!request.principal) {
    throw errors.unauthenticated();
  }
  return request.principal;
}

/**
 * CSRF: double-submit token validated against the session's stored hash.
 *
 * Cookies are SameSite=Lax, which already blocks cross-site POSTs from a plain
 * form; this is the second layer. Webhook routes are exempt and authenticated
 * by provider signature instead (docs/api.md §8).
 */
export async function enforceCsrf(request: FastifyRequest): Promise<void> {
  if (!MUTATING_METHODS.has(request.method)) return;

  const principal = request.principal;
  if (!principal) return;

  const header = request.headers[CSRF_HEADER];
  const token = Array.isArray(header) ? header[0] : header;

  if (!(await verifyCsrf(principal.sessionId, token))) {
    throw errors.csrfInvalid();
  }
}

/** Route guard: authenticated, CSRF-checked, and holding every listed permission. */
export function guard(options: {
  permissions?: Permission[];
  roles?: UserRole[];
}): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request) => {
    const principal = requireAuth(request);
    await enforceCsrf(request);

    if (options.roles && !options.roles.includes(principal.role)) {
      throw errors.forbidden('You do not have permission to do that.', {
        requiredRoles: options.roles,
        actualRole: principal.role,
      });
    }

    if (options.permissions) {
      const missing = options.permissions.filter((p) => !principal.permissions.includes(p));
      if (missing.length > 0) {
        throw errors.forbidden('You do not have permission to do that.', {
          missingPermissions: missing,
          actualRole: principal.role,
        });
      }
    }
  };
}

/** Authenticated and CSRF-checked, with no additional permission requirement. */
export const requireSession = guard({});

/**
 * Ownership check.
 *
 * A permission grants the *kind* of action; this grants it over a *specific*
 * record. Holding `prescription:read` does not let a pharmacy read another
 * pharmacy's prescription (spec §45, §102).
 *
 * Admins pass. For everyone else the owning organisation must match.
 */
export function assertOwnership(
  principal: NonNullable<FastifyRequest['principal']>,
  ownerOrganisationId: string | null | undefined,
  entity = 'record',
): void {
  if (principal.role === 'ADMIN') return;

  if (!ownerOrganisationId || principal.organisationId !== ownerOrganisationId) {
    // 404 rather than 403: confirming the record exists would itself leak.
    throw errors.notFound('Not found.', {
      entity,
      principalOrganisation: principal.organisationId,
    });
  }
}
