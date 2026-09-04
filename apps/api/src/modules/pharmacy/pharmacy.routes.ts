import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PHARMACY_DOCUMENT_TYPES } from '@neem/contracts';
import { getPrisma } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { guard, requireAuth } from '../../middleware/auth.ts';
import { readDocument, uploadDocument } from '../documents/documents.service.ts';

/**
 * Pharmacy self-service routes (spec §20, §55).
 *
 * Every route is scoped to the authenticated pharmacy's own record — there is
 * no parameter by which one pharmacy could address another (spec §102).
 *
 * These exist because a registered pharmacy previously had no way to see its
 * own application, and no way to supply the documents an administrator is
 * supposed to verify before activating it. Verification was therefore
 * necessarily happening without documents.
 */

function requirePharmacy(request: FastifyRequest) {
  const principal = requireAuth(request);

  if (principal.role !== 'PHARMACY' || !principal.organisationId) {
    throw errors.forbidden('This area is for pharmacy accounts.');
  }
  return { principal, pharmacyId: principal.organisationId };
}

export async function pharmacyRoutes(app: FastifyInstance): Promise<void> {
  const pharmacyOnly = guard({ roles: ['PHARMACY'] });

  /**
   * The pharmacy's own profile and onboarding progress.
   *
   * Deliberately mirrors `/doctor/profile`: what has been supplied, what an
   * administrator has verified, and what is still outstanding — so an
   * applicant is never left guessing why they cannot yet operate.
   */
  app.get('/pharmacy/profile', { preHandler: pharmacyOnly }, async (request, reply) => {
    const { pharmacyId } = requirePharmacy(request);

    const pharmacy = await getPrisma().pharmacy.findUniqueOrThrow({
      where: { id: pharmacyId },
      include: {
        documents: {
          select: { id: true, type: true, uploadedAt: true, verifiedAt: true, note: true },
          orderBy: { uploadedAt: 'desc' },
        },
        hours: { orderBy: { dayOfWeek: 'asc' } },
        capabilities: true,
      },
    });

    const documents = pharmacy.documents.map((document) => ({
      id: document.id,
      type: document.type,
      uploadedAt: document.uploadedAt.toISOString(),
      verified: document.verifiedAt !== null,
      // The administrator's note, shown to the pharmacy: a rejected document
      // is useless feedback without the reason.
      note: document.note,
    }));

    const verifiedCount = documents.filter((document) => document.verified).length;

    return reply.send({
      data: {
        publicId: pharmacy.publicId,
        name: pharmacy.name,
        councilRegistrationNo: pharmacy.councilRegistrationNo,
        ownerName: pharmacy.ownerName,
        responsiblePharmacistName: pharmacy.responsiblePharmacistName,
        city: pharmacy.city,
        region: pharmacy.region,
        phone: pharmacy.phone,
        email: pharmacy.email,
        status: pharmacy.status,
        statusReason: pharmacy.statusReason,
        documents,
        documentCount: documents.length,
        verifiedDocumentCount: verifiedCount,
        /**
         * What still stands between this pharmacy and operating. Computed from
         * the same rule the activation check enforces, so the screen and the
         * server can never disagree about what is required.
         */
        outstanding: buildOutstanding(pharmacy.status, verifiedCount),
        createdAt: pharmacy.createdAt.toISOString(),
        approvedAt: pharmacy.approvedAt?.toISOString() ?? null,
        isDemo: pharmacy.isDemo,
      },
      meta: { requestId: request.correlationId },
    });
  });

  /**
   * Uploads a registration or licence document (spec §20).
   *
   * Neem performs no automated check against any registry. An administrator
   * looks at the file and decides; nothing here asserts a document is genuine.
   */
  app.post('/pharmacy/documents', { preHandler: pharmacyOnly }, async (request, reply) => {
    const { principal, pharmacyId } = requirePharmacy(request);

    const data = await request.file();
    if (!data) {
      throw errors.validation([{ field: 'file', issue: 'No file was uploaded' }]);
    }

    const documentType = String(
      (data.fields.documentType as { value?: string } | undefined)?.value ?? 'OTHER',
    );
    if (!PHARMACY_DOCUMENT_TYPES.includes(documentType as never)) {
      throw errors.validation([{ field: 'documentType', issue: 'Unknown document type' }]);
    }

    const body = await data.toBuffer();
    const result = await uploadDocument({
      body,
      mimeType: data.mimetype,
      ownerType: 'pharmacy',
      ownerId: pharmacyId,
      documentType,
      actor: { type: 'PHARMACY', id: principal.userId },
      correlationId: request.correlationId,
    });

    return reply.status(201).send({
      data: { id: result.id, uploadedAt: result.uploadedAt.toISOString(), verified: false },
      meta: { requestId: request.correlationId },
    });
  });

  /** Streams back one of the pharmacy's own documents. */
  app.get('/pharmacy/documents/:id', { preHandler: pharmacyOnly }, async (request, reply) => {
    const { principal, pharmacyId } = requirePharmacy(request);
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);

    const document = await getPrisma().pharmacyDocument.findUnique({ where: { id } });
    // 404 rather than 403 — confirming another pharmacy's document exists
    // would itself be a disclosure (spec §102).
    if (!document || document.pharmacyId !== pharmacyId) {
      throw errors.notFound('Document not found.');
    }

    const file = await readDocument(
      'pharmacy',
      id,
      { type: 'PHARMACY', id: principal.userId },
      request.correlationId,
    );

    return reply
      .header('content-type', file.mimeType)
      .header('content-disposition', 'inline')
      .header('cache-control', 'private, no-store')
      .send(file.body);
  });
}

/**
 * What the pharmacy still needs to do, in their own words.
 *
 * Kept beside the activation rule it mirrors. If that rule gains a
 * requirement, this list has to gain a line — the integration test asserts
 * they agree.
 */
function buildOutstanding(status: string, verifiedDocumentCount: number): string[] {
  const outstanding: string[] = [];

  if (verifiedDocumentCount === 0) {
    outstanding.push(
      'Upload your Pharmacy Council registration and supporting documents. A Neem administrator verifies each one by hand.',
    );
  }
  if (status === 'PENDING' || status === 'UNDER_REVIEW') {
    outstanding.push(
      'Wait for Neem to complete verification. No pharmacy is activated automatically.',
    );
  }
  if (status === 'SUSPENDED' || status === 'REJECTED') {
    outstanding.push('Contact Neem administration about the status of this account.');
  }

  return outstanding;
}
