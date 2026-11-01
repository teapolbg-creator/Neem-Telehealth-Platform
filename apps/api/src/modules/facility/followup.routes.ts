import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  PERMISSIONS,
  followUpCancelSchema,
  followUpCompleteSchema,
  followUpCreateSchema,
  followUpListQuerySchema,
  followUpMissedSchema,
} from '@neem/contracts';
import { guard, requireAuth } from '../../middleware/auth.ts';
import { staffContext } from './patient.service.ts';
import {
  cancelFollowUp,
  completeFollowUp,
  createFollowUp,
  listFollowUps,
  markFollowUpMissed,
} from './followup.service.ts';

/**
 * Follow-ups (CHPS slice 2b, D81) — docs/api.md §18. Facility staff only,
 * within their own facility.
 */

const params = z.object({ publicId: z.string().min(1).max(32) });

export async function followUpRoutes(app: FastifyInstance): Promise<void> {
  const manage = guard({ roles: ['FACILITY'], permissions: [PERMISSIONS.CHPS_FOLLOW_UP_MANAGE] });
  const ctx = (request: FastifyRequest, write: boolean) =>
    staffContext(requireAuth(request), { write, correlationId: request.correlationId });

  app.get('/facility/follow-ups', { preHandler: manage }, async (request, reply) => {
    const { view } = followUpListQuerySchema.parse(request.query);
    const data = await listFollowUps(await ctx(request, false), view);
    return reply.send({ data, meta: { requestId: request.correlationId } });
  });

  app.post(
    '/facility/visits/:publicId/follow-ups',
    { preHandler: manage },
    async (request, reply) => {
      const { publicId } = params.parse(request.params);
      const input = followUpCreateSchema.parse(request.body);
      const data = await createFollowUp(await ctx(request, true), publicId, input);
      return reply.status(201).send({ data, meta: { requestId: request.correlationId } });
    },
  );

  app.post(
    '/facility/follow-ups/:publicId/complete',
    { preHandler: manage },
    async (request, reply) => {
      const { publicId } = params.parse(request.params);
      const input = followUpCompleteSchema.parse(request.body);
      const data = await completeFollowUp(await ctx(request, false), publicId, input);
      return reply.send({ data, meta: { requestId: request.correlationId } });
    },
  );

  app.post(
    '/facility/follow-ups/:publicId/missed',
    { preHandler: manage },
    async (request, reply) => {
      const { publicId } = params.parse(request.params);
      const { note } = followUpMissedSchema.parse(request.body);
      const data = await markFollowUpMissed(await ctx(request, false), publicId, note);
      return reply.send({ data, meta: { requestId: request.correlationId } });
    },
  );

  app.post(
    '/facility/follow-ups/:publicId/cancel',
    { preHandler: manage },
    async (request, reply) => {
      const { publicId } = params.parse(request.params);
      const { reason } = followUpCancelSchema.parse(request.body);
      const data = await cancelFollowUp(await ctx(request, false), publicId, reason);
      return reply.send({ data, meta: { requestId: request.correlationId } });
    },
  );
}
