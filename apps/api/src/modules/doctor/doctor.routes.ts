import type { FastifyInstance, FastifyRequest } from 'fastify';
import { doctorSignatureSchema, DOCTOR_DOCUMENT_TYPES } from '@neem/contracts';
import { z } from 'zod';
import { getPrisma } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { systemClock } from '../../lib/clock.ts';
import { requestContext } from '../../middleware/context.ts';
import { guard, requireAuth } from '../../middleware/auth.ts';
import { captureSignature, getDoctorByPublicId } from './doctor.service.ts';
import { uploadDocument, readDocument } from '../documents/documents.service.ts';
import {
  confirmShift,
  getServiceHours,
  listShiftsForDoctor,
} from '../scheduling/scheduling.service.ts';
import { getCurrentSubscription } from '../subscription/subscription.service.ts';

/**
 * Doctor self-service routes.
 *
 * Every route is scoped to the authenticated doctor's own record — there is no
 * parameter by which one doctor could address another (spec §102).
 *
 * Deliberately absent: any route returning ratings or the internal quality
 * score. Doctors must not see either (spec §24, §52).
 */

function requireDoctor(request: FastifyRequest) {
  const principal = requireAuth(request);

  if (principal.role !== 'DOCTOR' || !principal.organisationId) {
    throw errors.forbidden('This area is for doctor accounts.');
  }
  return { principal, doctorId: principal.organisationId };
}

export async function doctorRoutes(app: FastifyInstance): Promise<void> {
  const doctorOnly = guard({ roles: ['DOCTOR'] });

  /** The doctor's own profile, credential status and onboarding progress. */
  app.get('/doctor/profile', { preHandler: doctorOnly }, async (request, reply) => {
    const { doctorId } = requireDoctor(request);
    const prisma = getPrisma();

    const doctor = await prisma.doctor.findUniqueOrThrow({
      where: { id: doctorId },
      include: {
        languages: { include: { language: { select: { code: true, label: true } } } },
        documents: {
          select: { id: true, type: true, uploadedAt: true, verifiedAt: true, note: true, mimeType: true, sizeBytes: true },
          orderBy: { uploadedAt: 'desc' },
        },
        signatures: { where: { isActive: true }, select: { capturedAt: true } },
      },
    });

    const subscription = await getCurrentSubscription(doctorId, prisma);
    const serviceHours = await getServiceHours(doctorId, systemClock.now(), prisma);

    return reply.send({
      data: {
        publicId: doctor.publicId,
        fullName: doctor.fullName,
        mdcNumber: doctor.mdcNumber,
        mdcExpiresAt: doctor.mdcExpiresAt?.toISOString() ?? null,
        specialty: doctor.specialty,
        bio: doctor.bio,
        yearsExperience: doctor.yearsExperience,
        status: doctor.status,
        statusReason: doctor.statusReason,
        languages: doctor.languages.map((entry) => ({
          code: entry.language.code,
          label: entry.language.label,
          isPrimary: entry.isPrimary,
        })),
        // Compensation the admin configured. Shown so the doctor knows their
        // arrangement; the system never derives or pays it (spec §26).
        employmentType: doctor.employmentType,
        contractedHoursPerWeek: doctor.contractedHoursPerWeek,
        documents: doctor.documents.map((document) => ({
          id: document.id,
          type: document.type,
          uploadedAt: document.uploadedAt.toISOString(),
          verified: document.verifiedAt !== null,
          note: document.note,
          sizeBytes: document.sizeBytes,
        })),
        signatureCapturedAt: doctor.signatures[0]?.capturedAt.toISOString() ?? null,
        subscription: subscription
          ? {
              status: subscription.status,
              periodStart: subscription.periodStart.toISOString(),
              periodEnd: subscription.periodEnd.toISOString(),
              amountMinor: subscription.amountMinor,
              currency: subscription.currency,
            }
          : null,
        serviceHours,
      },
      meta: { requestId: request.correlationId },
    });
  });

  /** Uploads a credential document (spec §21). */
  app.post('/doctor/documents', { preHandler: doctorOnly }, async (request, reply) => {
    const { principal, doctorId } = requireDoctor(request);

    const data = await request.file();
    if (!data) {
      throw errors.validation([{ field: 'file', issue: 'No file was uploaded' }]);
    }

    const documentType = String(
      (data.fields.documentType as { value?: string } | undefined)?.value ?? 'OTHER',
    );
    if (!DOCTOR_DOCUMENT_TYPES.includes(documentType as never)) {
      throw errors.validation([{ field: 'documentType', issue: 'Unknown document type' }]);
    }

    const body = await data.toBuffer();
    const result = await uploadDocument({
      body,
      mimeType: data.mimetype,
      ownerType: 'doctor',
      ownerId: doctorId,
      documentType,
      actor: { type: 'DOCTOR', id: principal.userId },
      correlationId: request.correlationId,
    });

    return reply.status(201).send({
      data: { id: result.id, uploadedAt: result.uploadedAt.toISOString(), verified: false },
      meta: { requestId: request.correlationId },
    });
  });

  /** Streams back one of the doctor's own documents. */
  app.get('/doctor/documents/:id', { preHandler: doctorOnly }, async (request, reply) => {
    const { principal, doctorId } = requireDoctor(request);
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);

    const document = await getPrisma().doctorDocument.findUnique({ where: { id } });
    // 404 rather than 403 — confirming another doctor's document exists would
    // itself be a disclosure.
    if (!document || document.doctorId !== doctorId) {
      throw errors.notFound('Document not found.');
    }

    const file = await readDocument(
      'doctor',
      id,
      { type: 'DOCTOR', id: principal.userId },
      request.correlationId,
    );

    return reply
      .header('content-type', file.mimeType)
      .header('content-disposition', 'inline')
      .header('cache-control', 'private, no-store')
      .send(file.body);
  });

  /** Captures the drawn digital signature (spec §23). */
  app.post('/doctor/signature', { preHandler: doctorOnly }, async (request, reply) => {
    const { doctorId } = requireDoctor(request);
    const input = doctorSignatureSchema.parse(request.body);

    const result = await captureSignature(doctorId, input.signatureDataUrl, requestContext(request));

    return reply.send({
      data: { capturedAt: result.capturedAt.toISOString() },
      meta: { requestId: request.correlationId },
    });
  });

  /** Assigned shifts, with the weekly hours position (spec §25). */
  app.get('/doctor/shifts', { preHandler: doctorOnly }, async (request, reply) => {
    const { doctorId } = requireDoctor(request);

    const query = z
      .object({ from: z.string().date().optional(), to: z.string().date().optional() })
      .parse(request.query);

    const now = systemClock.now();
    const from = query.from ? new Date(`${query.from}T00:00:00.000Z`) : now;
    const to = query.to
      ? new Date(`${query.to}T00:00:00.000Z`)
      : new Date(now.getTime() + 28 * 86_400_000);

    const shifts = await listShiftsForDoctor(doctorId, { from, to });
    const serviceHours = await getServiceHours(doctorId, now);

    return reply.send({
      data: {
        serviceHours,
        shifts: shifts.map((assignment) => ({
          id: assignment.id,
          serviceDate: assignment.serviceDate.toISOString().slice(0, 10),
          status: assignment.status,
          minutesPlanned: assignment.minutesPlanned,
          confirmedAt: assignment.confirmedAt?.toISOString() ?? null,
          shift: {
            code: assignment.shiftDefinition.code,
            label: assignment.shiftDefinition.label,
            startsAt: assignment.shiftDefinition.startsAt,
            endsAt: assignment.shiftDefinition.endsAt,
          },
        })),
      },
      meta: { requestId: request.correlationId },
    });
  });

  app.post('/doctor/shifts/:id/confirm', { preHandler: doctorOnly }, async (request, reply) => {
    const { doctorId } = requireDoctor(request);
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);

    await confirmShift(id, doctorId, { correlationId: request.correlationId });

    return reply.send({
      data: { id, status: 'CONFIRMED' },
      meta: { requestId: request.correlationId },
    });
  });

  /** Public-facing doctor summary, used by admin screens. */
  app.get('/doctors/:publicId', { preHandler: guard({ roles: ['ADMIN'] }) }, async (request, reply) => {
    const { publicId } = z.object({ publicId: z.string().min(1) }).parse(request.params);
    const doctor = await getDoctorByPublicId(publicId);

    return reply.send({
      data: {
        publicId: doctor.publicId,
        fullName: doctor.fullName,
        mdcNumber: doctor.mdcNumber,
        mdcExpiresAt: doctor.mdcExpiresAt?.toISOString() ?? null,
        qualifiedAt: doctor.qualifiedAt?.toISOString() ?? null,
        yearsExperience: doctor.yearsExperience,
        specialty: doctor.specialty,
        bio: doctor.bio,
        status: doctor.status,
        statusReason: doctor.statusReason,
        email: doctor.user.email,
        lastLoginAt: doctor.user.lastLoginAt?.toISOString() ?? null,
        languages: doctor.languages.map((entry) => ({
          code: entry.language.code,
          label: entry.language.label,
          isPrimary: entry.isPrimary,
        })),
        documents: doctor.documents.map((document) => ({
          id: document.id,
          type: document.type,
          mimeType: document.mimeType,
          sizeBytes: document.sizeBytes,
          uploadedAt: document.uploadedAt.toISOString(),
          verified: document.verifiedAt !== null,
          note: document.note,
        })),
        hasSignature: doctor.signatures.length > 0,
        employmentType: doctor.employmentType,
        contractedHoursPerWeek: doctor.contractedHoursPerWeek,
        hourlyRateMinor: doctor.hourlyRateMinor,
        monthlySalaryMinor: doctor.monthlySalaryMinor,
        subscription: doctor.subscriptions[0]
          ? {
              status: doctor.subscriptions[0].status,
              periodEnd: doctor.subscriptions[0].periodEnd.toISOString(),
            }
          : null,
        createdAt: doctor.createdAt.toISOString(),
        isDemo: doctor.isDemo,
      },
      meta: { requestId: request.correlationId },
    });
  });
}
