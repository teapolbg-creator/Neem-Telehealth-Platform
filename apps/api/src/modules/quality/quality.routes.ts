import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PERMISSIONS } from '@neem/contracts';
import { guard, requireAuth } from '../../middleware/auth.ts';
import { decideComplaint, listComplaints, qualityBoard } from './complaint.service.ts';
import { recomputeQualityScores } from './quality.service.ts';

/**
 * Complaints and quality review (spec §51, §52, §55).
 *
 * Deliberately absent: any route that returns a quality score or a patient
 * rating to a doctor. The whole area is admin-only, and a doctor principal is
 * refused rather than filtered — a score a clinician can watch becomes a
 * target they optimise, and the queue already declines to tell them why they
 * were chosen (spec §24, §52).
 *
 * Also absent: a way to delete a complaint. It is resolved or dismissed, both
 * with a written outcome, and both leave the row in place.
 */
export async function qualityRoutes(app: FastifyInstance): Promise<void> {
  const complaintAdmin = guard({
    roles: ['ADMIN'],
    permissions: [PERMISSIONS.COMPLAINT_MANAGE],
  });
  const qualityAdmin = guard({ roles: ['ADMIN'], permissions: [PERMISSIONS.QUALITY_READ] });

  app.get('/admin/complaints', { preHandler: complaintAdmin }, async (request, reply) => {
    const query = z
      .object({
        openOnly: z.enum(['true', 'false']).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      })
      .parse(request.query);

    return reply.send({
      data: await listComplaints({ openOnly: query.openOnly === 'true', limit: query.limit }),
      meta: { requestId: request.correlationId },
    });
  });

  app.post(
    '/admin/complaints/:publicId/decide',
    { preHandler: complaintAdmin },
    async (request, reply) => {
      const principal = requireAuth(request);
      const { publicId } = z.object({ publicId: z.string().min(1) }).parse(request.params);
      const body = z
        .object({
          state: z.enum(['UNDER_REVIEW', 'RESOLVED', 'DISMISSED']),
          note: z.string().trim().max(2000).optional(),
        })
        .parse(request.body);

      // The service requires a note when closing; a complaint dismissed with
      // no reason is indistinguishable from one ignored.
      const result = await decideComplaint(publicId, principal.userId, body);

      return reply.send({ data: result, meta: { requestId: request.correlationId } });
    },
  );

  app.get('/admin/quality', { preHandler: qualityAdmin }, async (request, reply) => {
    return reply.send({
      data: await qualityBoard(),
      meta: { requestId: request.correlationId },
    });
  });

  /**
   * Recomputes every doctor's score now.
   *
   * The nightly job does this on its own; this exists for the case where an
   * administrator has just changed a quality weight and needs to see the
   * effect before deciding whether to keep it.
   */
  app.post(
    '/admin/quality/recompute',
    { preHandler: guard({ roles: ['ADMIN'], permissions: [PERMISSIONS.SETTINGS_MANAGE] }) },
    async (request, reply) => {
      const result = await recomputeQualityScores();

      return reply.send({
        data: { scored: result.scored },
        meta: { requestId: request.correlationId },
      });
    },
  );
}
