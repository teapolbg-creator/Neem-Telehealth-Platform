import type { FastifyInstance } from 'fastify';
import { ADMIN_ROLES, PERMISSIONS, chpsOperationsQuerySchema } from '@neem/contracts';
import { guard } from '../../middleware/auth.ts';
import { chpsOperationsOverview } from './chps-operations.service.ts';

/**
 * Neem operations' live view of CHPS (slice 3c, D86) — docs/api.md §23.
 * Both administrator roles: it is operations' own page.
 */
export async function chpsOperationsRoutes(app: FastifyInstance): Promise<void> {
  const operations = guard({ roles: ADMIN_ROLES, permissions: [PERMISSIONS.FACILITY_MANAGE] });

  app.get('/admin/chps/overview', { preHandler: operations }, async (request, reply) => {
    const { days } = chpsOperationsQuerySchema.parse(request.query);
    return reply.send({
      data: await chpsOperationsOverview(days),
      meta: { requestId: request.correlationId },
    });
  });
}
