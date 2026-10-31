import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  FACILITY_STATUSES,
  FACILITY_TYPES,
  PERMISSIONS,
  districtCreateSchema,
  facilityCreateSchema,
  facilityStaffCreateSchema,
  facilityStaffStatusSchema,
  facilityUpdateSchema,
  paginationQuerySchema,
  subDistrictCreateSchema,
} from '@neem/contracts';
import { errors } from '../../lib/errors.ts';
import { guard, requireAuth } from '../../middleware/auth.ts';
import {
  createDistrict,
  createFacility,
  createStaffAccount,
  createSubDistrict,
  getFacilityDetail,
  getGeography,
  getOwnFacility,
  listFacilities,
  reissueSetupLink,
  setStaffStatus,
  updateFacility,
} from './facility.service.ts';

/**
 * Health facilities and their staff (CHPS slice 1a, D73) — docs/api.md §14.
 *
 * The /admin routes are Neem administration and need FACILITY_MANAGE. The one
 * /facility route is a staff member reading their own facility, found from
 * their session rather than from anything in the URL, so it cannot be pointed
 * at somebody else's.
 */

const publicIdParams = z.object({ publicId: z.string().min(1).max(32) });
const staffParams = publicIdParams.extend({ userPublicId: z.string().min(1).max(32) });

export async function facilityRoutes(app: FastifyInstance): Promise<void> {
  const facilityAdmin = guard({ roles: ['ADMIN'], permissions: [PERMISSIONS.FACILITY_MANAGE] });
  const facilityStaff = guard({ roles: ['FACILITY'] });

  // -------------------------------------------------------------------------
  // Geography
  // -------------------------------------------------------------------------

  app.get('/admin/geography', { preHandler: facilityAdmin }, async (request, reply) => {
    return reply.send({ data: await getGeography(), meta: { requestId: request.correlationId } });
  });

  app.post('/admin/geography/districts', { preHandler: facilityAdmin }, async (request, reply) => {
    const principal = requireAuth(request);
    const input = districtCreateSchema.parse(request.body);
    const data = await createDistrict(input, {
      adminUserId: principal.userId,
      correlationId: request.correlationId,
    });
    return reply.status(201).send({ data, meta: { requestId: request.correlationId } });
  });

  app.post(
    '/admin/geography/sub-districts',
    { preHandler: facilityAdmin },
    async (request, reply) => {
      const principal = requireAuth(request);
      const input = subDistrictCreateSchema.parse(request.body);
      const data = await createSubDistrict(input, {
        adminUserId: principal.userId,
        correlationId: request.correlationId,
      });
      return reply.status(201).send({ data, meta: { requestId: request.correlationId } });
    },
  );

  // -------------------------------------------------------------------------
  // Facilities
  // -------------------------------------------------------------------------

  app.get('/admin/facilities', { preHandler: facilityAdmin }, async (request, reply) => {
    const query = paginationQuerySchema
      .extend({
        status: z.enum(FACILITY_STATUSES).optional(),
        type: z.enum(FACILITY_TYPES).optional(),
        regionId: z.string().uuid().optional(),
        districtId: z.string().uuid().optional(),
        search: z.string().max(120).optional(),
      })
      .parse(request.query);

    const result = await listFacilities(query);

    return reply.send({
      data: result.items,
      meta: {
        requestId: request.correlationId,
        page: { cursor: result.nextCursor, hasMore: result.hasMore },
      },
    });
  });

  app.post('/admin/facilities', { preHandler: facilityAdmin }, async (request, reply) => {
    const principal = requireAuth(request);
    const input = facilityCreateSchema.parse(request.body);
    const data = await createFacility(input, {
      adminUserId: principal.userId,
      correlationId: request.correlationId,
    });
    return reply.status(201).send({ data, meta: { requestId: request.correlationId } });
  });

  app.get('/admin/facilities/:publicId', { preHandler: facilityAdmin }, async (request, reply) => {
    const { publicId } = publicIdParams.parse(request.params);
    return reply.send({
      data: await getFacilityDetail(publicId),
      meta: { requestId: request.correlationId },
    });
  });

  app.patch(
    '/admin/facilities/:publicId',
    { preHandler: facilityAdmin },
    async (request, reply) => {
      const principal = requireAuth(request);
      const { publicId } = publicIdParams.parse(request.params);
      const input = facilityUpdateSchema.parse(request.body);
      const data = await updateFacility(publicId, input, {
        adminUserId: principal.userId,
        correlationId: request.correlationId,
      });
      return reply.send({ data, meta: { requestId: request.correlationId } });
    },
  );

  // -------------------------------------------------------------------------
  // Staff accounts
  // -------------------------------------------------------------------------

  app.post(
    '/admin/facilities/:publicId/staff',
    { preHandler: facilityAdmin },
    async (request, reply) => {
      const principal = requireAuth(request);
      const { publicId } = publicIdParams.parse(request.params);
      const input = facilityStaffCreateSchema.parse(request.body);
      const data = await createStaffAccount(publicId, input, {
        adminUserId: principal.userId,
        correlationId: request.correlationId,
      });
      return reply.status(201).send({ data, meta: { requestId: request.correlationId } });
    },
  );

  app.post(
    '/admin/facilities/:publicId/staff/:userPublicId/status',
    { preHandler: facilityAdmin },
    async (request, reply) => {
      const principal = requireAuth(request);
      const { publicId, userPublicId } = staffParams.parse(request.params);
      const { status } = facilityStaffStatusSchema.parse(request.body);
      const data = await setStaffStatus(publicId, userPublicId, status, {
        adminUserId: principal.userId,
        correlationId: request.correlationId,
      });
      return reply.send({ data, meta: { requestId: request.correlationId } });
    },
  );

  app.post(
    '/admin/facilities/:publicId/staff/:userPublicId/setup-link',
    { preHandler: facilityAdmin },
    async (request, reply) => {
      const principal = requireAuth(request);
      const { publicId, userPublicId } = staffParams.parse(request.params);
      const data = await reissueSetupLink(publicId, userPublicId, {
        adminUserId: principal.userId,
        correlationId: request.correlationId,
      });
      return reply.send({ data, meta: { requestId: request.correlationId } });
    },
  );

  // -------------------------------------------------------------------------
  // The staff member's own facility
  // -------------------------------------------------------------------------

  app.get('/facility/profile', { preHandler: facilityStaff }, async (request, reply) => {
    const principal = requireAuth(request);
    if (!principal.organisationId) {
      // A FACILITY account with no membership is an orphan nobody should hold.
      throw errors.notFound('This account is not attached to a facility.');
    }
    return reply.send({
      data: await getOwnFacility(principal.organisationId),
      meta: { requestId: request.correlationId },
    });
  });
}
