import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PERMISSIONS } from '@neem/contracts';
import { queryBoolean } from '../../lib/query.ts';
import { guard, requireAuth } from '../../middleware/auth.ts';
import { createPromotion, deactivatePromotion, listPromotions } from './promotion.service.ts';

/**
 * Promotion management routes (spec §42).
 *
 * Validation of a code at redemption lives in consultation creation, on the
 * server, where a client cannot supply a discount amount. These routes are the
 * other half: creating and withdrawing the codes that validation checks
 * against.
 *
 * Deliberately absent: a DELETE. Consultations reference promotions and the
 * discount they were given has to stay explainable, so withdrawal deactivates.
 */

export async function promotionRoutes(app: FastifyInstance): Promise<void> {
  const adminOnly = guard({ roles: ['ADMIN'], permissions: [PERMISSIONS.PROMOTION_MANAGE] });

  app.get('/admin/promotions', { preHandler: adminOnly }, async (request, reply) => {
    const query = z
      .object({
        activeOnly: queryBoolean.optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      })
      .parse(request.query);

    return reply.send({
      data: await listPromotions({ activeOnly: query.activeOnly, limit: query.limit }),
      meta: { requestId: request.correlationId },
    });
  });

  app.post('/admin/promotions', { preHandler: adminOnly }, async (request, reply) => {
    const principal = requireAuth(request);

    const body = z
      .object({
        code: z.string().trim().min(3).max(40),
        type: z.enum(['PERCENT', 'FIXED']),
        valueBp: z.number().int().min(1).max(10_000).optional(),
        valueMinor: z.number().int().min(1).optional(),
        startsAt: z.coerce.date(),
        endsAt: z.coerce.date(),
        maxUses: z.number().int().min(1).optional(),
        pharmacyPublicId: z.string().min(1).optional(),
        campaign: z.string().trim().max(120).optional(),
        minAmountMinor: z.number().int().min(0).optional(),
      })
      .parse(request.body);

    const result = await createPromotion(body, principal.userId);

    return reply.status(201).send({ data: result, meta: { requestId: request.correlationId } });
  });

  /**
   * Withdraws a code.
   *
   * Deliberately not a DELETE: consultations reference the promotion and the
   * discount they were given has to stay explainable, so it is deactivated.
   */
  app.post(
    '/admin/promotions/:code/deactivate',
    { preHandler: adminOnly },
    async (request, reply) => {
      const principal = requireAuth(request);
      const { code } = z.object({ code: z.string().min(1) }).parse(request.params);

      return reply.send({
        data: await deactivatePromotion(code.toUpperCase(), principal.userId),
        meta: { requestId: request.correlationId },
      });
    },
  );
}
