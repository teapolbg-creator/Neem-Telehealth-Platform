import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  PERMISSIONS,
  PILOT_APPLICANT_ROLES,
  PILOT_APPLICATION_STATUSES,
  paginationQuerySchema,
  pilotApplicationSchema,
  pilotApplicationStatusUpdateSchema,
} from '@neem/contracts';
import { getEnv } from '../../config/env.ts';
import { guard, requireAuth } from '../../middleware/auth.ts';
import { requestContext } from '../../middleware/context.ts';
import {
  exportPilotApplications,
  getPilotApplication,
  listPilotApplications,
  setPilotApplicationStatus,
  submitPilotApplication,
} from './pilot.service.ts';

/**
 * Pilot registration (spec §20 in spirit; the marketing site's front door).
 *
 * The submit route is unauthenticated by design — it is a public form on a
 * public website. It is safe to leave open because a submission creates no
 * account and grants nothing: the row is inert until a person reads it.
 *
 * Everything else here is admin-only, and admins hold mandatory 2FA.
 */

/**
 * Tighter than the global default and looser than account creation.
 *
 * A pharmacy's whole staff can share one NAT address, so a limit of five an
 * hour — what real onboarding uses — would lock out a second colleague filling
 * in the form after the first. Configurable rather than hard-coded, like every
 * other limit.
 */
function submissionLimit() {
  const env = getEnv();
  return { max: env.RATE_LIMIT_PILOT_MAX, timeWindow: env.RATE_LIMIT_PILOT_WINDOW };
}

export async function pilotRoutes(app: FastifyInstance): Promise<void> {
  const pilotAdmin = guard({ roles: ['ADMIN'], permissions: [PERMISSIONS.PILOT_MANAGE] });

  // -------------------------------------------------------------------------
  // Public
  // -------------------------------------------------------------------------

  app.post(
    '/pilot-applications',
    { config: { rateLimit: submissionLimit() } },
    async (request, reply) => {
      const input = pilotApplicationSchema.parse(request.body);
      const result = await submitPilotApplication(input, requestContext(request));

      return reply.status(201).send({
        data: {
          reference: result.reference,
          message:
            'Thank you — we have your details. Someone from the Neem team will be in touch about the pilot.',
        },
        meta: { requestId: request.correlationId },
      });
    },
  );

  // -------------------------------------------------------------------------
  // Admin
  // -------------------------------------------------------------------------

  app.get('/admin/pilot-applications', { preHandler: pilotAdmin }, async (request, reply) => {
    const query = paginationQuerySchema
      .extend({
        role: z.enum(PILOT_APPLICANT_ROLES).optional(),
        status: z.enum(PILOT_APPLICATION_STATUSES).optional(),
        search: z.string().max(120).optional(),
      })
      .parse(request.query);

    const result = await listPilotApplications({
      role: query.role,
      status: query.status,
      search: query.search,
      limit: query.limit,
      cursor: query.cursor,
    });

    return reply.send({
      data: result.items,
      meta: {
        requestId: request.correlationId,
        page: { cursor: result.nextCursor, hasMore: result.hasMore },
      },
    });
  });

  app.get(
    '/admin/pilot-applications/export.csv',
    { preHandler: pilotAdmin },
    async (request, reply) => {
      const query = z
        .object({
          role: z.enum(PILOT_APPLICANT_ROLES).optional(),
          status: z.enum(PILOT_APPLICATION_STATUSES).optional(),
        })
        .parse(request.query);

      const csv = await exportPilotApplications(query);

      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', 'attachment; filename="neem-pilot-applications.csv"')
        .send(csv);
    },
  );

  app.get(
    '/admin/pilot-applications/:publicId',
    { preHandler: pilotAdmin },
    async (request, reply) => {
      const params = z.object({ publicId: z.string().max(32) }).parse(request.params);
      const application = await getPilotApplication(params.publicId);

      return reply.send({ data: application, meta: { requestId: request.correlationId } });
    },
  );

  app.patch(
    '/admin/pilot-applications/:publicId/status',
    { preHandler: pilotAdmin },
    async (request, reply) => {
      const params = z.object({ publicId: z.string().max(32) }).parse(request.params);
      const input = pilotApplicationStatusUpdateSchema.parse(request.body);

      const principal = requireAuth(request);

      const application = await setPilotApplicationStatus(params.publicId, input, {
        adminId: principal.userId,
        correlationId: request.correlationId,
      });

      return reply.send({ data: application, meta: { requestId: request.correlationId } });
    },
  );
}
