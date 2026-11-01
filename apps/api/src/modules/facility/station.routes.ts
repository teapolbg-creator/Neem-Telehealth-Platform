import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  PERMISSIONS,
  STATION_HEADER,
  stationAssignSchema,
  stationCreateSchema,
  stationPairSchema,
} from '@neem/contracts';
import { getEnv } from '../../config/env.ts';
import { errors } from '../../lib/errors.ts';
import { guard, requireAuth } from '../../middleware/auth.ts';
import { staffContext } from './patient.service.ts';
import {
  STATION_COOKIE,
  clearStation,
  createStation,
  listStations,
  pairStation,
  repairStation,
  resolveStation,
  revokeStation,
  sendToStation,
  stationJoin,
  stationLeave,
  stationState,
  type StationPrincipal,
} from './station.service.ts';

/**
 * Consultation stations (CHPS slice 1d, D77) — docs/api.md §15.
 *
 * Two audiences. Facility staff manage their stations under /facility, with
 * a user session like any other route. The station itself calls /station
 * with its own credential, a cookie obtained by pairing, and nothing else.
 *
 * A station request that changes anything must also carry the
 * `x-neem-station` header. A cross-site form cannot set a header, and a
 * cross-origin script cannot send one without a CORS preflight the API
 * refuses, so the cookie alone is never enough.
 */

const params = z.object({ publicId: z.string().min(1).max(32) });

async function requireStation(request: FastifyRequest): Promise<StationPrincipal> {
  const principal = await resolveStation(request.cookies[STATION_COOKIE]);
  if (!principal) {
    throw errors.unauthenticated('This station is not paired. Ask the facility staff to pair it.');
  }
  if (request.method !== 'GET' && request.headers[STATION_HEADER] !== '1') {
    throw errors.forbidden('Station requests must come from the station screen.');
  }
  return principal;
}

function pairLimit() {
  const env = getEnv();
  return { max: env.RATE_LIMIT_AUTH_MAX, timeWindow: env.RATE_LIMIT_AUTH_WINDOW };
}

function setStationCookie(reply: FastifyReply, token: string, expires: Date) {
  reply.setCookie(STATION_COOKIE, token, {
    httpOnly: true,
    secure: getEnv().NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    expires,
  });
}

export async function stationRoutes(app: FastifyInstance): Promise<void> {
  const manage = guard({ roles: ['FACILITY'], permissions: [PERMISSIONS.STATION_MANAGE] });
  const ctx = (request: FastifyRequest, write: boolean) =>
    staffContext(requireAuth(request), { write, correlationId: request.correlationId });

  // -------------------------------------------------------------------------
  // Facility staff
  // -------------------------------------------------------------------------

  app.get('/facility/stations', { preHandler: manage }, async (request, reply) => {
    const data = await listStations(await ctx(request, false));
    return reply.send({ data, meta: { requestId: request.correlationId } });
  });

  app.post('/facility/stations', { preHandler: manage }, async (request, reply) => {
    const { label } = stationCreateSchema.parse(request.body);
    const data = await createStation(await ctx(request, true), label);
    return reply.status(201).send({ data, meta: { requestId: request.correlationId } });
  });

  app.post(
    '/facility/stations/:publicId/pairing-code',
    { preHandler: manage },
    async (request, reply) => {
      const { publicId } = params.parse(request.params);
      const data = await repairStation(await ctx(request, true), publicId);
      return reply.send({ data, meta: { requestId: request.correlationId } });
    },
  );

  app.post(
    '/facility/stations/:publicId/revoke',
    { preHandler: manage },
    async (request, reply) => {
      const { publicId } = params.parse(request.params);
      const data = await revokeStation(await ctx(request, false), publicId);
      return reply.send({ data, meta: { requestId: request.correlationId } });
    },
  );

  app.post('/facility/stations/:publicId/clear', { preHandler: manage }, async (request, reply) => {
    const { publicId } = params.parse(request.params);
    const data = await clearStation(await ctx(request, false), publicId);
    return reply.send({ data, meta: { requestId: request.correlationId } });
  });

  app.post('/facility/visits/:publicId/station', { preHandler: manage }, async (request, reply) => {
    const { publicId } = params.parse(request.params);
    const { stationPublicId } = stationAssignSchema.parse(request.body);
    const data = await sendToStation(await ctx(request, true), publicId, stationPublicId);
    return reply.send({ data, meta: { requestId: request.correlationId } });
  });

  // -------------------------------------------------------------------------
  // The station
  // -------------------------------------------------------------------------

  app.post('/station/pair', { config: { rateLimit: pairLimit() } }, async (request, reply) => {
    const { code } = stationPairSchema.parse(request.body);
    const { token, expiresAt } = await pairStation(code, {
      correlationId: request.correlationId,
      ip: request.ip,
    });
    setStationCookie(reply, token, expiresAt);
    return reply.send({ data: { paired: true }, meta: { requestId: request.correlationId } });
  });

  app.get('/station/state', async (request, reply) => {
    const data = await stationState(await requireStation(request));
    return reply.send({ data, meta: { requestId: request.correlationId } });
  });

  app.post('/station/join', async (request, reply) => {
    const data = await stationJoin(await requireStation(request));
    return reply.send({ data, meta: { requestId: request.correlationId } });
  });

  app.post('/station/leave', async (request, reply) => {
    await stationLeave(await requireStation(request));
    return reply.send({ data: { ok: true }, meta: { requestId: request.correlationId } });
  });
}
