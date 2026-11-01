import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  PERMISSIONS,
  referralAcknowledgeSchema,
  referralCancelSchema,
  referralCreateSchema,
  referralFeedbackSchema,
  referralListQuerySchema,
  referralOutcomeSchema,
} from '@neem/contracts';
import { guard, requireAuth } from '../../middleware/auth.ts';
import { staffContext } from './patient.service.ts';
import {
  acknowledgeReferral,
  cancelReferral,
  createReferral,
  listDestinations,
  listReferrals,
  recordReferralFeedback,
  recordReferralOutcome,
} from './referral.service.ts';

/**
 * Tracked referrals from a CHPS compound (slice 2a, D80) — docs/api.md §17.
 *
 * Facility staff only, within their own facility. The receiving facility has
 * no route here at all (D79): what it says reaches Neem through the CHO.
 */

const params = z.object({ publicId: z.string().min(1).max(32) });

export async function referralRoutes(app: FastifyInstance): Promise<void> {
  const manage = guard({ roles: ['FACILITY'], permissions: [PERMISSIONS.CHPS_REFERRAL_MANAGE] });
  const ctx = (request: FastifyRequest, write: boolean) =>
    staffContext(requireAuth(request), { write, correlationId: request.correlationId });

  app.get('/facility/referral-destinations', { preHandler: manage }, async (request, reply) => {
    const data = await listDestinations(await ctx(request, false));
    return reply.send({ data, meta: { requestId: request.correlationId } });
  });

  app.get('/facility/referrals', { preHandler: manage }, async (request, reply) => {
    const query = referralListQuerySchema.parse(request.query);
    const data = await listReferrals(await ctx(request, false), {
      status: query.status,
      open: query.open === 'true',
      from: query.from,
      to: query.to,
    });
    return reply.send({ data, meta: { requestId: request.correlationId } });
  });

  app.post(
    '/facility/visits/:publicId/referrals',
    { preHandler: manage },
    async (request, reply) => {
      const { publicId } = params.parse(request.params);
      const input = referralCreateSchema.parse(request.body);
      const data = await createReferral(await ctx(request, true), publicId, input);
      return reply.status(201).send({ data, meta: { requestId: request.correlationId } });
    },
  );

  /*
   * Recording what the receiving facility said is allowed even once the
   * facility is inactive: a patient already sent is still owed the record.
   */
  app.post(
    '/facility/referrals/:publicId/acknowledge',
    { preHandler: manage },
    async (request, reply) => {
      const { publicId } = params.parse(request.params);
      const input = referralAcknowledgeSchema.parse(request.body);
      const data = await acknowledgeReferral(await ctx(request, false), publicId, input);
      return reply.send({ data, meta: { requestId: request.correlationId } });
    },
  );

  app.post(
    '/facility/referrals/:publicId/outcome',
    { preHandler: manage },
    async (request, reply) => {
      const { publicId } = params.parse(request.params);
      const input = referralOutcomeSchema.parse(request.body);
      const data = await recordReferralOutcome(await ctx(request, false), publicId, input);
      return reply.send({ data, meta: { requestId: request.correlationId } });
    },
  );

  app.post(
    '/facility/referrals/:publicId/feedback',
    { preHandler: manage },
    async (request, reply) => {
      const { publicId } = params.parse(request.params);
      const { feedback } = referralFeedbackSchema.parse(request.body);
      const data = await recordReferralFeedback(await ctx(request, false), publicId, feedback);
      return reply.send({ data, meta: { requestId: request.correlationId } });
    },
  );

  app.post(
    '/facility/referrals/:publicId/cancel',
    { preHandler: manage },
    async (request, reply) => {
      const { publicId } = params.parse(request.params);
      const { reason } = referralCancelSchema.parse(request.body);
      const data = await cancelReferral(await ctx(request, false), publicId, reason);
      return reply.send({ data, meta: { requestId: request.correlationId } });
    },
  );
}
