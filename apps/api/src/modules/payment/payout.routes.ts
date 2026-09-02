import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PERMISSIONS } from '@neem/contracts';
import { errors } from '../../lib/errors.ts';
import { queryBoolean } from '../../lib/query.ts';
import { guard, requireAuth } from '../../middleware/auth.ts';
import {
  calculatePayouts,
  listPayouts,
  markPayoutPaid,
  pharmacyEarnings,
} from './payout.service.ts';

/**
 * Payout and earnings routes (spec §40).
 *
 * Deliberately absent: anything that transfers money to a pharmacy. Neem
 * calculates what is owed and records that a human sent it; the transfer
 * itself happens out of band during the MVP, and no route here pretends
 * otherwise.
 */

function requirePharmacy(request: FastifyRequest): { userId: string; pharmacyId: string } {
  const principal = requireAuth(request);

  if (principal.role !== 'PHARMACY' || !principal.organisationId) {
    throw errors.forbidden('This area is for pharmacy accounts.');
  }
  return { userId: principal.userId, pharmacyId: principal.organisationId };
}

export async function payoutRoutes(app: FastifyInstance): Promise<void> {
  /** A pharmacy's own earnings. Its share only — never Neem's, never another's. */
  app.get(
    '/pharmacy/finance',
    { preHandler: guard({ roles: ['PHARMACY'], permissions: [PERMISSIONS.FINANCE_READ_OWN] }) },
    async (request, reply) => {
      const { pharmacyId } = requirePharmacy(request);

      return reply.send({
        data: await pharmacyEarnings(pharmacyId),
        meta: { requestId: request.correlationId },
      });
    },
  );

  app.get(
    '/admin/payouts',
    { preHandler: guard({ roles: ['ADMIN'], permissions: [PERMISSIONS.PAYOUT_MANAGE] }) },
    async (request, reply) => {
      const query = z
        .object({
          pendingOnly: queryBoolean.optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        })
        .parse(request.query);

      return reply.send({
        data: await listPayouts({ pendingOnly: query.pendingOnly, limit: query.limit }),
        meta: { requestId: request.correlationId },
      });
    },
  );

  /**
   * Works out what is owed for a period.
   *
   * Re-runnable while a payout is still pending, so late allocations and
   * refunds are picked up. A payout already marked paid is left exactly as it
   * was — see `calculatePayouts`.
   */
  app.post(
    '/admin/payouts/calculate',
    { preHandler: guard({ roles: ['ADMIN'], permissions: [PERMISSIONS.PAYOUT_MANAGE] }) },
    async (request, reply) => {
      const principal = requireAuth(request);
      const body = z
        .object({
          periodStart: z.coerce.date(),
          periodEnd: z.coerce.date(),
        })
        .parse(request.body);

      const result = await calculatePayouts(
        { periodStart: body.periodStart, periodEnd: body.periodEnd },
        principal.userId,
      );

      return reply.send({ data: result, meta: { requestId: request.correlationId } });
    },
  );

  /**
   * Records that the money has been sent.
   *
   * Neem does not transfer it — payouts are settled out of band during the
   * MVP (spec §40). This is a record of a human act, which is why it demands
   * a reference that can be traced back to the transfer.
   */
  app.post(
    '/admin/payouts/:publicId/mark-paid',
    { preHandler: guard({ roles: ['ADMIN'], permissions: [PERMISSIONS.PAYOUT_MANAGE] }) },
    async (request, reply) => {
      const principal = requireAuth(request);
      const { publicId } = z.object({ publicId: z.string().min(1) }).parse(request.params);
      const body = z
        .object({
          paymentReference: z.string().trim().min(3).max(200),
          amountPaidMinor: z.number().int().min(0).optional(),
          note: z.string().trim().max(500).optional(),
        })
        .parse(request.body);

      const result = await markPayoutPaid(publicId, principal.userId, body);

      return reply.send({ data: result, meta: { requestId: request.correlationId } });
    },
  );
}
