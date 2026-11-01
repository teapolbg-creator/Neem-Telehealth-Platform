import type { FastifyInstance } from 'fastify';
import { PERMISSIONS, districtReportQuerySchema } from '@neem/contracts';
import { guard, requireAuth } from '../../middleware/auth.ts';
import { districtOverview, districtReport } from './district.service.ts';

/**
 * A district health officer's view of their area (CHPS slice 3a, D84) —
 * docs/api.md §22. Read-only: there is no write route here.
 */
export async function districtRoutes(app: FastifyInstance): Promise<void> {
  const officer = guard({ roles: ['DISTRICT'], permissions: [PERMISSIONS.DISTRICT_REPORT_READ] });

  app.get('/district/overview', { preHandler: officer }, async (request, reply) => {
    const principal = requireAuth(request);
    return reply.send({
      data: await districtOverview(principal.userId),
      meta: { requestId: request.correlationId },
    });
  });

  app.get('/district/report', { preHandler: officer }, async (request, reply) => {
    const principal = requireAuth(request);
    const query = districtReportQuerySchema.parse(request.query);
    return reply.send({
      data: await districtReport(principal.userId, query),
      meta: { requestId: request.correlationId },
    });
  });
}
