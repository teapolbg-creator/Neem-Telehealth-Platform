import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  DOCTOR_STATUSES,
  PHARMACY_STATUSES,
  PERMISSIONS,
  accountStatusChangeSchema,
  doctorCompensationSchema,
  documentVerificationSchema,
  paginationQuerySchema,
  shiftAssignmentSchema,
} from '@neem/contracts';
import { getPrisma } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { guard, requireAuth } from '../../middleware/auth.ts';
import {
  changeDoctorStatus,
  doctorTransitionOptions,
  listDoctors,
  setDoctorCompensation,
} from '../doctor/doctor.service.ts';
import {
  changePharmacyStatus,
  getPharmacyByPublicId,
  listPharmacies,
  pharmacyTransitionOptions,
} from '../pharmacy/pharmacy.service.ts';
import { readDocument, verifyDocument } from '../documents/documents.service.ts';
import { assignShift, cancelShift, listShiftDefinitions } from '../scheduling/scheduling.service.ts';
import {
  createSubscription,
  findExpiringLicences,
} from '../subscription/subscription.service.ts';

/**
 * Neem administration routes (spec §55).
 *
 * Every route is admin-only, and admins hold mandatory 2FA — an unenrolled
 * admin cannot even hold a session (spec §9), so these endpoints are always
 * behind a second factor.
 */

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  const doctorAdmin = guard({ roles: ['ADMIN'], permissions: [PERMISSIONS.DOCTOR_MANAGE] });
  const pharmacyAdmin = guard({ roles: ['ADMIN'], permissions: [PERMISSIONS.PHARMACY_MANAGE] });
  const shiftAdmin = guard({ roles: ['ADMIN'], permissions: [PERMISSIONS.SHIFT_MANAGE] });

  // -------------------------------------------------------------------------
  // Doctors
  // -------------------------------------------------------------------------

  app.get('/admin/doctors', { preHandler: doctorAdmin }, async (request, reply) => {
    const query = paginationQuerySchema
      .extend({
        status: z.enum(DOCTOR_STATUSES).optional(),
        awaitingReview: z.coerce.boolean().optional(),
        search: z.string().max(120).optional(),
      })
      .parse(request.query);

    const result = await listDoctors({
      status: query.status,
      awaitingReview: query.awaitingReview,
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

  /**
   * Changes a doctor's status. The state machine and its preconditions —
   * verified documents, a captured signature, an unexpired licence — are
   * enforced in the service, not here (spec §83).
   */
  app.post('/admin/doctors/:publicId/status', { preHandler: doctorAdmin }, async (request, reply) => {
    const principal = requireAuth(request);
    const { publicId } = z.object({ publicId: z.string().min(1) }).parse(request.params);
    const body = accountStatusChangeSchema.parse(request.body);

    const status = z.enum(DOCTOR_STATUSES).parse(body.status);

    const result = await changeDoctorStatus(publicId, status, {
      adminId: principal.userId,
      reason: body.reason,
      correlationId: request.correlationId,
    });

    return reply.send({
      data: { publicId, from: result.from, to: result.to },
      meta: { requestId: request.correlationId },
    });
  });

  /** The transitions currently permitted, so the UI offers only valid actions. */
  app.get('/admin/doctors/:publicId/transitions', { preHandler: doctorAdmin }, async (request, reply) => {
    const { publicId } = z.object({ publicId: z.string().min(1) }).parse(request.params);

    const doctor = await getPrisma().doctor.findUnique({
      where: { publicId },
      select: { status: true },
    });
    if (!doctor) throw errors.notFound('Doctor not found.');

    return reply.send({
      data: { current: doctor.status, allowed: doctorTransitionOptions(doctor.status) },
      meta: { requestId: request.correlationId },
    });
  });

  app.patch('/admin/doctors/:publicId/compensation', { preHandler: doctorAdmin }, async (request, reply) => {
    const principal = requireAuth(request);
    const { publicId } = z.object({ publicId: z.string().min(1) }).parse(request.params);
    const body = doctorCompensationSchema.parse(request.body);

    await setDoctorCompensation(publicId, body, {
      adminId: principal.userId,
      correlationId: request.correlationId,
    });

    return reply.send({ data: { publicId }, meta: { requestId: request.correlationId } });
  });

  /** Reads a doctor's credential document. Every read is audited. */
  app.get('/admin/doctors/documents/:id', { preHandler: doctorAdmin }, async (request, reply) => {
    const principal = requireAuth(request);
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);

    const file = await readDocument(
      'doctor',
      id,
      { type: 'ADMIN', id: principal.userId },
      request.correlationId,
    );

    return reply
      .header('content-type', file.mimeType)
      .header('content-disposition', 'inline')
      .header('cache-control', 'private, no-store')
      .send(file.body);
  });

  app.post('/admin/doctors/documents/:id/verify', { preHandler: doctorAdmin }, async (request, reply) => {
    const principal = requireAuth(request);
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = documentVerificationSchema.parse(request.body);

    await verifyDocument('doctor', id, body, {
      adminId: principal.userId,
      correlationId: request.correlationId,
    });

    return reply.send({
      data: { id, verified: body.verified },
      meta: { requestId: request.correlationId },
    });
  });

  /** MDC licences approaching expiry (spec §22). Reporting only. */
  app.get('/admin/doctors/licences/expiring', { preHandler: doctorAdmin }, async (request, reply) => {
    const expiring = await findExpiringLicences();

    return reply.send({
      data: expiring.map((entry) => ({
        publicId: entry.publicId,
        fullName: entry.fullName,
        mdcNumber: entry.mdcNumber,
        mdcExpiresAt: entry.mdcExpiresAt.toISOString(),
        daysRemaining: entry.daysRemaining,
      })),
      meta: { requestId: request.correlationId },
    });
  });

  app.post('/admin/doctors/:publicId/subscription', { preHandler: doctorAdmin }, async (request, reply) => {
    const principal = requireAuth(request);
    const { publicId } = z.object({ publicId: z.string().min(1) }).parse(request.params);

    const result = await createSubscription(publicId, {
      adminId: principal.userId,
      correlationId: request.correlationId,
    });

    return reply.status(201).send({
      data: {
        periodStart: result.periodStart.toISOString(),
        periodEnd: result.periodEnd.toISOString(),
        amountMinor: result.amountMinor,
        // Stated plainly: creating the period is not the same as being paid.
        // Payment collection arrives with Paystack in Phase 7 (spec §93).
        status: 'PENDING',
        note: 'Subscription period created. Payment is not yet collected — the payment provider is integrated in Phase 7.',
      },
      meta: { requestId: request.correlationId },
    });
  });

  // -------------------------------------------------------------------------
  // Pharmacies
  // -------------------------------------------------------------------------

  app.get('/admin/pharmacies', { preHandler: pharmacyAdmin }, async (request, reply) => {
    const query = paginationQuerySchema
      .extend({
        status: z.enum(PHARMACY_STATUSES).optional(),
        awaitingReview: z.coerce.boolean().optional(),
        search: z.string().max(120).optional(),
      })
      .parse(request.query);

    const result = await listPharmacies({
      status: query.status,
      awaitingReview: query.awaitingReview,
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

  app.get('/admin/pharmacies/:publicId', { preHandler: pharmacyAdmin }, async (request, reply) => {
    const { publicId } = z.object({ publicId: z.string().min(1) }).parse(request.params);
    const pharmacy = await getPharmacyByPublicId(publicId);

    return reply.send({
      data: {
        publicId: pharmacy.publicId,
        name: pharmacy.name,
        councilRegistrationNo: pharmacy.councilRegistrationNo,
        ownerName: pharmacy.ownerName,
        responsiblePharmacistName: pharmacy.responsiblePharmacistName,
        responsiblePharmacistLicenceNo: pharmacy.responsiblePharmacistLicenceNo,
        addressLine1: pharmacy.addressLine1,
        addressLine2: pharmacy.addressLine2,
        city: pharmacy.city,
        region: pharmacy.region,
        phone: pharmacy.phone,
        email: pharmacy.email,
        status: pharmacy.status,
        statusReason: pharmacy.statusReason,
        hours: pharmacy.hours,
        capabilities: pharmacy.capabilities,
        documents: pharmacy.documents.map((document) => ({
          id: document.id,
          type: document.type,
          uploadedAt: document.uploadedAt.toISOString(),
          verified: document.verifiedAt !== null,
          note: document.note,
        })),
        accounts: pharmacy.users.map((membership) => membership.user),
        createdAt: pharmacy.createdAt.toISOString(),
        approvedAt: pharmacy.approvedAt?.toISOString() ?? null,
        isDemo: pharmacy.isDemo,
      },
      meta: { requestId: request.correlationId },
    });
  });

  app.post('/admin/pharmacies/:publicId/status', { preHandler: pharmacyAdmin }, async (request, reply) => {
    const principal = requireAuth(request);
    const { publicId } = z.object({ publicId: z.string().min(1) }).parse(request.params);
    const body = accountStatusChangeSchema.parse(request.body);

    const status = z.enum(PHARMACY_STATUSES).parse(body.status);

    const result = await changePharmacyStatus(publicId, status, {
      adminId: principal.userId,
      reason: body.reason,
      correlationId: request.correlationId,
    });

    return reply.send({
      data: { publicId, from: result.from, to: result.to },
      meta: { requestId: request.correlationId },
    });
  });

  app.get('/admin/pharmacies/:publicId/transitions', { preHandler: pharmacyAdmin }, async (request, reply) => {
    const { publicId } = z.object({ publicId: z.string().min(1) }).parse(request.params);

    const pharmacy = await getPrisma().pharmacy.findUnique({
      where: { publicId },
      select: { status: true },
    });
    if (!pharmacy) throw errors.notFound('Pharmacy not found.');

    return reply.send({
      data: { current: pharmacy.status, allowed: pharmacyTransitionOptions(pharmacy.status) },
      meta: { requestId: request.correlationId },
    });
  });

  app.post('/admin/pharmacies/documents/:id/verify', { preHandler: pharmacyAdmin }, async (request, reply) => {
    const principal = requireAuth(request);
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = documentVerificationSchema.parse(request.body);

    await verifyDocument('pharmacy', id, body, {
      adminId: principal.userId,
      correlationId: request.correlationId,
    });

    return reply.send({
      data: { id, verified: body.verified },
      meta: { requestId: request.correlationId },
    });
  });

  // -------------------------------------------------------------------------
  // Shifts (spec §25)
  // -------------------------------------------------------------------------

  app.get('/admin/shifts/definitions', { preHandler: shiftAdmin }, async (request, reply) => {
    const definitions = await listShiftDefinitions();

    return reply.send({
      data: definitions.map((shift) => ({
        code: shift.code,
        label: shift.label,
        startsAt: shift.startsAt,
        endsAt: shift.endsAt,
        crossesMidnight: shift.crossesMidnight,
        isActive: shift.isActive,
      })),
      meta: { requestId: request.correlationId },
    });
  });

  /**
   * Assigns a shift. The 40-hour weekly ceiling is enforced inside the
   * assignment transaction, so this cannot be bypassed by concurrent requests
   * (spec §25).
   */
  app.post('/admin/shifts', { preHandler: shiftAdmin }, async (request, reply) => {
    const principal = requireAuth(request);
    const input = shiftAssignmentSchema.parse(request.body);

    const result = await assignShift(input, {
      adminId: principal.userId,
      correlationId: request.correlationId,
    });

    return reply.status(201).send({ data: result, meta: { requestId: request.correlationId } });
  });

  app.delete('/admin/shifts/:id', { preHandler: shiftAdmin }, async (request, reply) => {
    const principal = requireAuth(request);
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = z.object({ reason: z.string().max(500).optional() }).parse(request.body ?? {});

    await cancelShift(id, {
      actorType: 'ADMIN',
      actorId: principal.userId,
      reason: body.reason,
      correlationId: request.correlationId,
    });

    return reply.send({ data: { id, status: 'CANCELLED' }, meta: { requestId: request.correlationId } });
  });

  // -------------------------------------------------------------------------
  // Audit log (spec §61) — admin-only, read-only
  // -------------------------------------------------------------------------

  app.get('/admin/audit-logs', { preHandler: guard({ roles: ['ADMIN'], permissions: [PERMISSIONS.AUDIT_READ] }) },
    async (request, reply) => {
      const query = paginationQuerySchema
        .extend({
          action: z.string().max(80).optional(),
          entityType: z.string().max(60).optional(),
          entityId: z.string().max(64).optional(),
        })
        .parse(request.query);

      const rows = await getPrisma().auditLog.findMany({
        where: {
          ...(query.action ? { action: query.action } : {}),
          ...(query.entityType ? { entityType: query.entityType } : {}),
          ...(query.entityId ? { entityId: query.entityId } : {}),
        },
        orderBy: { occurredAt: 'desc' },
        take: query.limit,
      });

      return reply.send({
        data: rows.map((entry) => ({
          id: entry.id,
          occurredAt: entry.occurredAt.toISOString(),
          action: entry.action,
          actorType: entry.actorType,
          actorId: entry.actorId,
          entityType: entry.entityType,
          entityId: entry.entityId,
          outcome: entry.outcome,
          metadata: entry.metadata,
        })),
        meta: { requestId: request.correlationId },
      });
    },
  );
}
