import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PERMISSIONS, triageRuleCreateSchema } from '@neem/contracts';
import { guard, requireAuth } from '../../middleware/auth.ts';
import { activeRules, addRule, listRules, retireRule } from './triage-protocol.service.ts';

/** The approved triage protocol (slice 5c, D93) — docs/api.md §29. */
export async function triageProtocolRoutes(app: FastifyInstance): Promise<void> {
  const superAdmin = guard({ roles: ['ADMIN'], permissions: [PERMISSIONS.SETTINGS_MANAGE] });
  const triage = guard({ roles: ['FACILITY'], permissions: [PERMISSIONS.TRIAGE_WRITE] });

  app.get('/facility/triage-protocol', { preHandler: triage }, async (request, reply) => {
    return reply.send({ data: await activeRules(), meta: { requestId: request.correlationId } });
  });

  app.get('/admin/triage-protocol', { preHandler: superAdmin }, async (request, reply) => {
    return reply.send({ data: await listRules(), meta: { requestId: request.correlationId } });
  });

  app.post('/admin/triage-protocol', { preHandler: superAdmin }, async (request, reply) => {
    const input = triageRuleCreateSchema.parse(request.body);
    await addRule(input, {
      userId: requireAuth(request).userId,
      correlationId: request.correlationId,
    });
    return reply
      .status(201)
      .send({ data: await listRules(), meta: { requestId: request.correlationId } });
  });

  app.post(
    '/admin/triage-protocol/:id/retire',
    { preHandler: superAdmin },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().min(1).max(64) }).parse(request.params);
      await retireRule(id, {
        userId: requireAuth(request).userId,
        correlationId: request.correlationId,
      });
      return reply.send({ data: await listRules(), meta: { requestId: request.correlationId } });
    },
  );
}
