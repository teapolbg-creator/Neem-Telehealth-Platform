import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PERMISSIONS } from '@neem/contracts';
import { guard, requireAuth } from '../../middleware/auth.ts';
import {
  RETRIEVAL_PURPOSES,
  endRetrieval,
  listRetrievals,
  retrieveArchivedConsultation,
} from './archived-retrieval.service.ts';
import { overdueDestructions } from './clinical-record.service.ts';

/**
 * Archived Consultation Retrieval (decision D27).
 *
 * **Admin only, and there is no other door.** No doctor route, no pharmacy
 * route, and nothing that accepts a patient name or phone number. A doctor
 * seeing a patient today reaches this consultation and no other — that is the
 * whole architecture, and these routes are the single controlled exception for
 * people who are not treating the patient.
 *
 * Note what is absent: a search, a list by patient, and any endpoint returning
 * more than one consultation. Retrieval takes exactly one reference.
 */
export async function retentionRoutes(app: FastifyInstance): Promise<void> {
  const retentionAdmin = guard({ roles: ['ADMIN'], permissions: [PERMISSIONS.AUDIT_READ] });

  /**
   * Retrieves one archived consultation for a stated lawful reason.
   *
   * POST rather than GET: this creates an access-log entry and constitutes a
   * disclosure. It is an action, not a lookup, and must never be something a
   * browser can perform by following a link or prefetching.
   */
  app.post(
    '/admin/archived-consultations/retrieve',
    {
      preHandler: retentionAdmin,
      // Retrieval is rare and deliberate. A limit this low would obstruct
      // nothing legitimate and makes bulk extraction impractical.
      config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
    },
    async (request, reply) => {
      const principal = requireAuth(request);

      const body = z
        .object({
          consultationPublicId: z.string().min(1).max(64),
          purpose: z.enum(RETRIEVAL_PURPOSES),
          reference: z.string().trim().min(3).max(200),
          authorisedByUserPublicId: z.string().min(1).max(64),
        })
        .parse(request.body);

      const { getPrisma } = await import('../../db/prisma.ts');
      const authoriser = await getPrisma().user.findUnique({
        where: { publicId: body.authorisedByUserPublicId },
        select: { id: true },
      });

      const record = await retrieveArchivedConsultation({
        consultationPublicId: body.consultationPublicId,
        purpose: body.purpose,
        reference: body.reference,
        actor: { userId: principal.userId, role: principal.role },
        // A missing authoriser falls through to the service, which refuses
        // with the same message as an inactive or non-admin one. Nothing here
        // discloses whether that account exists.
        authorisedByUserId: authoriser?.id ?? 'unknown',
        correlationId: request.correlationId,
      });

      return reply.send({ data: record, meta: { requestId: request.correlationId } });
    },
  );

  /** Records that a retrieval session ended (counsel's minimum log fields). */
  app.post(
    '/admin/archived-consultations/retrievals/:id/end',
    { preHandler: retentionAdmin },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
      await endRetrieval(id);

      return reply.send({ data: { id }, meta: { requestId: request.correlationId } });
    },
  );

  /**
   * The retrieval history, for oversight.
   *
   * Returns who opened what and why — never what it said. A screen that
   * rendered the records alongside would be the longitudinal history by
   * another route.
   */
  app.get(
    '/admin/archived-consultations/retrievals',
    { preHandler: retentionAdmin },
    async (request, reply) => {
      const query = z
        .object({
          consultationPublicId: z.string().max(64).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        })
        .parse(request.query);

      return reply.send({
        data: await listRetrievals(query),
        meta: { requestId: request.correlationId },
      });
    },
  );

  /**
   * Retention health.
   *
   * Records held past their destruction date are a compliance failure, and a
   * destruction job that has been quietly failing is exactly what nobody
   * notices. Surfaced rather than left in a log file.
   */
  app.get('/admin/retention/health', { preHandler: retentionAdmin }, async (request, reply) => {
    return reply.send({
      data: { overdueDestructions: await overdueDestructions() },
      meta: { requestId: request.correlationId },
    });
  });
}
