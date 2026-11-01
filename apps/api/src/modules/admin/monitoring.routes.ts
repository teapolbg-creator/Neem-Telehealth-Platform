import type { FastifyInstance } from 'fastify';
import { ADMIN_ROLES, PERMISSIONS, monitoringQuerySchema } from '@neem/contracts';
import { guard, requireAuth } from '../../middleware/auth.ts';
import { systemMonitoring } from './monitoring.service.ts';

/**
 * System monitoring (slice 3d, D87) — docs/api.md §24.
 *
 * Both administrator roles see the counts. The list of security events names
 * accounts and comes from the audit log, so it goes only to those who may read
 * that log: the super administrator (D84).
 */
export async function monitoringRoutes(app: FastifyInstance): Promise<void> {
  const operations = guard({ roles: ADMIN_ROLES, permissions: [PERMISSIONS.SYSTEM_HEALTH_READ] });

  app.get('/admin/monitoring', { preHandler: operations }, async (request, reply) => {
    const principal = requireAuth(request);
    const { hours } = monitoringQuerySchema.parse(request.query);
    const data = await systemMonitoring(hours, {
      includeSecurityEvents: principal.permissions.includes(PERMISSIONS.AUDIT_READ),
    });
    return reply.send({ data, meta: { requestId: request.correlationId } });
  });
}
