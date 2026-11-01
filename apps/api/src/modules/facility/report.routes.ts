import type { FastifyInstance } from 'fastify';
import { PERMISSIONS, facilityReportQuerySchema } from '@neem/contracts';
import { guard, requireAuth } from '../../middleware/auth.ts';
import { staffContext } from './patient.service.ts';
import { facilityReport } from './report.service.ts';

/**
 * A CHPS facility's own report (slice 2c, D82) — docs/api.md §19. Facility
 * staff, their own facility only; district and national reporting is Phase 3.
 */
export async function reportRoutes(app: FastifyInstance): Promise<void> {
  const read = guard({ roles: ['FACILITY'], permissions: [PERMISSIONS.CHPS_REPORT_READ] });

  app.get('/facility/report', { preHandler: read }, async (request, reply) => {
    const range = facilityReportQuerySchema.parse(request.query);
    const ctx = await staffContext(requireAuth(request), {
      write: false,
      correlationId: request.correlationId,
    });
    const data = await facilityReport(ctx, range);
    return reply.send({ data, meta: { requestId: request.correlationId } });
  });
}
