import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedPrincipal } from '../modules/auth/session.service.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** Correlates every log line and audit entry for one request (spec §87). */
    correlationId: string;
    /** Populated by the auth middleware; null for anonymous requests. */
    principal: AuthenticatedPrincipal | null;
  }
}

/**
 * Request context.
 *
 * A correlation id is accepted from the caller when it looks safe, so the web
 * app can stitch a browser action to its server-side trail; otherwise one is
 * generated. It is echoed in `meta.requestId` on every response.
 */
export const contextPlugin = fp(async (app: FastifyInstance) => {
  app.decorateRequest('correlationId', '');
  app.decorateRequest('principal', null);

  app.addHook('onRequest', async (request, reply) => {
    const supplied = request.headers['x-correlation-id'];
    const candidate = Array.isArray(supplied) ? supplied[0] : supplied;

    request.correlationId =
      candidate && /^[A-Za-z0-9_-]{8,64}$/.test(candidate) ? candidate : randomUUID();

    request.principal = null;
    reply.header('x-correlation-id', request.correlationId);
  });
});

/**
 * Client IP.
 *
 * Only trusted when the proxy is trusted — `trustProxy` is configured
 * explicitly in app.ts, so a client cannot spoof its address by setting
 * X-Forwarded-For against a directly-exposed server.
 */
export function clientIp(request: FastifyRequest): string | undefined {
  return request.ip;
}

export function userAgent(request: FastifyRequest): string | undefined {
  const value = request.headers['user-agent'];
  return Array.isArray(value) ? value[0] : value;
}

export function requestContext(request: FastifyRequest) {
  return {
    ip: clientIp(request),
    userAgent: userAgent(request),
    correlationId: request.correlationId,
  };
}
