import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PERMISSIONS, staffAccountCreateSchema, staffAccountStatusSchema } from '@neem/contracts';
import { guard, requireAuth } from '../../middleware/auth.ts';
import {
  createStaffAccount,
  listStaffAccounts,
  reissueStaffSetupLink,
  setStaffAccountStatus,
} from './staff-account.service.ts';

/**
 * Neem's own staff accounts (CHPS slice 3a, D84) — docs/api.md §21.
 *
 * The super administrator's alone: only ADMIN holds STAFF_ACCOUNT_MANAGE, so
 * operations cannot create another administrator or a district officer.
 */

const userParams = z.object({ userPublicId: z.string().min(1).max(32) });

export async function staffAccountRoutes(app: FastifyInstance): Promise<void> {
  const superAdmin = guard({ roles: ['ADMIN'], permissions: [PERMISSIONS.STAFF_ACCOUNT_MANAGE] });

  app.get('/admin/staff', { preHandler: superAdmin }, async (request, reply) => {
    const principal = requireAuth(request);
    return reply.send({
      data: await listStaffAccounts(principal.userId),
      meta: { requestId: request.correlationId },
    });
  });

  app.post('/admin/staff', { preHandler: superAdmin }, async (request, reply) => {
    const principal = requireAuth(request);
    const input = staffAccountCreateSchema.parse(request.body);
    const data = await createStaffAccount(input, {
      adminUserId: principal.userId,
      correlationId: request.correlationId,
    });
    return reply.status(201).send({ data, meta: { requestId: request.correlationId } });
  });

  app.post(
    '/admin/staff/:userPublicId/status',
    { preHandler: superAdmin },
    async (request, reply) => {
      const principal = requireAuth(request);
      const { userPublicId } = userParams.parse(request.params);
      const { status } = staffAccountStatusSchema.parse(request.body);
      const data = await setStaffAccountStatus(userPublicId, status, {
        adminUserId: principal.userId,
        correlationId: request.correlationId,
      });
      return reply.send({ data, meta: { requestId: request.correlationId } });
    },
  );

  app.post(
    '/admin/staff/:userPublicId/setup-link',
    { preHandler: superAdmin },
    async (request, reply) => {
      const principal = requireAuth(request);
      const { userPublicId } = userParams.parse(request.params);
      const data = await reissueStaffSetupLink(userPublicId, {
        adminUserId: principal.userId,
        correlationId: request.correlationId,
      });
      return reply.send({ data, meta: { requestId: request.correlationId } });
    },
  );
}
