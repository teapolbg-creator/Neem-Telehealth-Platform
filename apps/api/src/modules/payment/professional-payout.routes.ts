import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PERMISSIONS } from '@neem/contracts';
import { errors } from '../../lib/errors.ts';
import { queryBoolean } from '../../lib/query.ts';
import { guard, requireAuth } from '../../middleware/auth.ts';
import { systemClock } from '../../lib/clock.ts';
import { earningStatement } from './earnings.service.ts';
import {
  calculateProfessionalPayouts,
  listProfessionalPayouts,
  markProfessionalPayoutPaid,
  reconcile,
} from './professional-payout.service.ts';

/**
 * What a professional earned, and what Neem sent them (v2, plan phase 7).
 *
 * Deliberately absent, exactly as for pharmacies: anything that transfers
 * money. Neem works out what is owed and records that a human sent it.
 */

const periodSchema = z.object({
  periodStart: z.coerce.date(),
  periodEnd: z.coerce.date(),
});

/** The last 30 days, when the caller names no period. */
function defaultPeriod(): { from: Date; to: Date } {
  const to = systemClock.now();
  return { from: new Date(to.getTime() - 30 * 86_400_000), to };
}

export async function professionalPayoutRoutes(app: FastifyInstance): Promise<void> {
  const payoutAdmin = guard({ roles: ['ADMIN'], permissions: [PERMISSIONS.PAYOUT_MANAGE] });

  /**
   * A professional's own statement.
   *
   * Their own lines and nobody else's, and their share only — a professional
   * is not shown Neem's revenue (spec §18 applies the same way here).
   */
  app.get(
    '/doctor/earnings/statement',
    { preHandler: guard({ roles: ['DOCTOR'], permissions: [PERMISSIONS.FINANCE_READ_OWN] }) },
    async (request, reply) => {
      const { organisationId } = requireAuth(request);
      if (!organisationId) throw errors.notFound('Professional not found.');

      const query = z
        .object({
          from: z.string().datetime({ offset: true }).optional(),
          to: z.string().datetime({ offset: true }).optional(),
        })
        .parse(request.query);

      const fallback = defaultPeriod();
      const period = {
        from: query.from ? new Date(query.from) : fallback.from,
        to: query.to ? new Date(query.to) : fallback.to,
      };

      return reply.send({
        data: await earningStatement(organisationId, period),
        meta: { requestId: request.correlationId },
      });
    },
  );

  app.get('/admin/professional-payouts', { preHandler: payoutAdmin }, async (request, reply) => {
    const query = z
      .object({
        pendingOnly: queryBoolean.optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      })
      .parse(request.query);

    return reply.send({
      data: await listProfessionalPayouts({
        pendingOnly: query.pendingOnly,
        limit: query.limit,
      }),
      meta: { requestId: request.correlationId },
    });
  });

  app.post(
    '/admin/professional-payouts/calculate',
    { preHandler: payoutAdmin },
    async (request, reply) => {
      const principal = requireAuth(request);
      const body = periodSchema.parse(request.body);

      return reply.send({
        data: await calculateProfessionalPayouts(
          { periodStart: body.periodStart, periodEnd: body.periodEnd },
          principal.userId,
        ),
        meta: { requestId: request.correlationId },
      });
    },
  );

  app.post(
    '/admin/professional-payouts/:publicId/mark-paid',
    { preHandler: payoutAdmin },
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

      return reply.send({
        data: await markProfessionalPayoutPaid(publicId, principal.userId, body),
        meta: { requestId: request.correlationId },
      });
    },
  );

  /**
   * Collected, earned and paid, side by side.
   *
   * They are three separate records so that they can disagree; this is where a
   * disagreement is meant to be noticed.
   */
  app.get(
    '/admin/professional-payouts/reconciliation',
    { preHandler: payoutAdmin },
    async (request, reply) => {
      const query = periodSchema.parse(request.query);

      return reply.send({
        data: await reconcile({
          periodStart: query.periodStart,
          periodEnd: query.periodEnd,
        }),
        meta: { requestId: request.correlationId },
      });
    },
  );
}
