import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PERMISSIONS } from '@neem/contracts';
import { getPrisma } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { queryBoolean } from '../../lib/query.ts';
import { guard, requireAuth } from '../../middleware/auth.ts';
import { decideRefund, listRefunds, requestRefund } from './refund.service.ts';

/**
 * Refund routes (spec §41).
 *
 * Deliberately absent: anything that refunds without an administrator. There
 * is no automatic path, no timer, and no self-service approval — a request is
 * a request, and only `POST /admin/refunds/:publicId/decide` moves money.
 */

function requirePharmacy(request: FastifyRequest): { userId: string; pharmacyId: string } {
  const principal = requireAuth(request);

  if (principal.role !== 'PHARMACY' || !principal.organisationId) {
    throw errors.forbidden('This area is for pharmacy accounts.');
  }
  return { userId: principal.userId, pharmacyId: principal.organisationId };
}

export async function refundRoutes(app: FastifyInstance): Promise<void> {
  /**
   * A pharmacy asking on the patient's behalf.
   *
   * The patient is standing at the counter, and by the time a refund is worth
   * asking for they may well have left — the pharmacy took the money and is
   * who they will come back to. The patient can also ask from their own phone
   * (`POST /patient/refund-request`).
   */
  app.post(
    '/pharmacy/consultations/:publicId/refund-request',
    { preHandler: guard({ roles: ['PHARMACY'], permissions: [PERMISSIONS.REFUND_REQUEST] }) },
    async (request, reply) => {
      const { pharmacyId, userId } = requirePharmacy(request);
      const { publicId } = z.object({ publicId: z.string().min(1) }).parse(request.params);
      const { reason } = z
        .object({ reason: z.string().trim().min(3).max(500) })
        .parse(request.body);

      const consultation = await getPrisma().consultation.findUnique({
        where: { publicId },
        select: { id: true, pharmacyId: true },
      });
      // 404 rather than 403: one pharmacy must not learn another's
      // consultation exists (spec §102, decision D13).
      if (!consultation || consultation.pharmacyId !== pharmacyId) {
        throw errors.notFound('Consultation not found.');
      }

      const result = await requestRefund(consultation.id, {
        reason,
        requestedByType: 'PHARMACY',
        requestedByRef: userId,
        correlationId: request.correlationId,
      });

      return reply.status(201).send({ data: result, meta: { requestId: request.correlationId } });
    },
  );

  // -------------------------------------------------------------------------
  // Admin
  // -------------------------------------------------------------------------

  app.get(
    '/admin/refunds',
    { preHandler: guard({ roles: ['ADMIN'], permissions: [PERMISSIONS.REFUND_DECIDE] }) },
    async (request, reply) => {
      const query = z
        .object({
          openOnly: queryBoolean.optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        })
        .parse(request.query);

      return reply.send({
        data: await listRefunds({ openOnly: query.openOnly, limit: query.limit }),
        meta: { requestId: request.correlationId },
      });
    },
  );

  /**
   * The decision.
   *
   * A reason is required for both answers. A rejection the patient cannot be
   * given an explanation for is not a decision anyone can stand behind, and an
   * approval without one leaves the ledger with money moved and nothing saying
   * why (spec §61).
   */
  app.post(
    '/admin/refunds/:publicId/decide',
    { preHandler: guard({ roles: ['ADMIN'], permissions: [PERMISSIONS.REFUND_DECIDE] }) },
    async (request, reply) => {
      const principal = requireAuth(request);
      const { publicId } = z.object({ publicId: z.string().min(1) }).parse(request.params);
      const body = z
        .object({ approve: z.boolean(), note: z.string().trim().min(3).max(500) })
        .parse(request.body);

      const result = await decideRefund(publicId, principal.userId, {
        approve: body.approve,
        note: body.note,
        correlationId: request.correlationId,
      });

      return reply.send({ data: result, meta: { requestId: request.correlationId } });
    },
  );
}
