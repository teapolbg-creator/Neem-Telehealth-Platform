import type { DoctorDocumentType } from '@prisma/client';
import { getPrisma, type Db } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { getEnv } from '../../config/env.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit.service.ts';
import { getStorageProvider } from '../../adapters/storage/local-storage.provider.ts';
import {
  ALLOWED_UPLOAD_TYPES,
  buildStorageKey,
  detectedTypeMatches,
} from '../../adapters/storage/storage.provider.ts';

/**
 * Credential document handling (spec §21, §55).
 *
 * These are among the most sensitive files Neem holds — government IDs and
 * practising licences. They are:
 *   - validated by magic bytes, not by the browser's Content-Type
 *   - stored outside any web-served directory under a random key
 *   - readable only through an authorised endpoint, and every read is audited
 *
 * The original filename is deliberately discarded: it is user-supplied and
 * often carries personal information in itself.
 */

export interface UploadInput {
  body: Buffer;
  mimeType: string;
  ownerType: 'doctor' | 'pharmacy';
  ownerId: string;
  documentType: string;
  actor: { type: 'DOCTOR' | 'PHARMACY' | 'ADMIN'; id: string };
  correlationId?: string;
}

export async function uploadDocument(
  input: UploadInput,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<{ id: string; uploadedAt: Date }> {
  const env = getEnv();

  if (input.body.length === 0) {
    throw errors.validation([{ field: 'file', issue: 'The uploaded file is empty' }]);
  }
  if (input.body.length > env.UPLOAD_MAX_BYTES) {
    throw errors.validation([
      {
        field: 'file',
        issue: `Files must be ${Math.floor(env.UPLOAD_MAX_BYTES / 1024 / 1024)} MB or smaller`,
      },
    ]);
  }
  if (!ALLOWED_UPLOAD_TYPES[input.mimeType]) {
    throw errors.validation([{ field: 'file', issue: 'Upload a PDF, JPEG, PNG or WebP file' }]);
  }
  // The declared type must match what the bytes actually are.
  if (!detectedTypeMatches(input.mimeType, input.body)) {
    throw errors.validation([
      { field: 'file', issue: 'That file’s contents do not match its file type' },
    ]);
  }

  const storageKey = buildStorageKey(`${input.ownerType}/${input.ownerId}`, input.mimeType);
  await getStorageProvider().put({ key: storageKey, body: input.body, mimeType: input.mimeType });

  const uploadedAt = clock.now();

  const record =
    input.ownerType === 'doctor'
      ? await db.doctorDocument.create({
          data: {
            doctorId: input.ownerId,
            type: input.documentType as DoctorDocumentType,
            storageKey,
            mimeType: input.mimeType,
            sizeBytes: input.body.length,
            uploadedAt,
          },
        })
      : await db.pharmacyDocument.create({
          data: {
            pharmacyId: input.ownerId,
            type: input.documentType,
            storageKey,
            mimeType: input.mimeType,
            sizeBytes: input.body.length,
            uploadedAt,
          },
        });

  await recordAudit(
    {
      action: AUDIT_ACTIONS.DOCUMENT_UPLOADED,
      actorType: input.actor.type,
      actorId: input.actor.id,
      entityType: `${input.ownerType}_document`,
      entityId: record.id,
      correlationId: input.correlationId,
      // Type and size only — never the filename or the contents.
      metadata: { documentType: input.documentType, sizeBytes: input.body.length },
    },
    db,
  );

  return { id: record.id, uploadedAt };
}

/**
 * Reads a document for an authorised caller.
 *
 * Ownership is checked by the caller (route layer) before this runs; every
 * successful read is audited, because access to a clinician's identity
 * documents is exactly the kind of event a regulator would ask about
 * (spec §61).
 */
export async function readDocument(
  ownerType: 'doctor' | 'pharmacy',
  documentId: string,
  actor: { type: 'DOCTOR' | 'PHARMACY' | 'ADMIN'; id: string },
  correlationId: string | undefined,
  db: Db = getPrisma(),
): Promise<{ body: Buffer; mimeType: string; ownerId: string }> {
  const record =
    ownerType === 'doctor'
      ? await db.doctorDocument.findUnique({ where: { id: documentId } })
      : await db.pharmacyDocument.findUnique({ where: { id: documentId } });

  if (!record) throw errors.notFound('Document not found.');

  const body = await getStorageProvider().get(record.storageKey);

  await recordAudit(
    {
      action: AUDIT_ACTIONS.DOCUMENT_DOWNLOADED,
      actorType: actor.type,
      actorId: actor.id,
      entityType: `${ownerType}_document`,
      entityId: record.id,
      correlationId,
      metadata: { documentType: record.type },
    },
    db,
  );

  return {
    body,
    mimeType: record.mimeType,
    ownerId: 'doctorId' in record ? record.doctorId : record.pharmacyId,
  };
}

/**
 * Records an admin's manual verification decision.
 *
 * "Verified" here means a human looked at the document and accepted it. Neem
 * makes no automated claim about a licence's authenticity (spec §22).
 */
export async function verifyDocument(
  ownerType: 'doctor' | 'pharmacy',
  documentId: string,
  decision: { verified: boolean; note?: string },
  context: { adminId: string; correlationId?: string },
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<void> {
  const verifiedAt = decision.verified ? clock.now() : null;

  const data = {
    verifiedAt,
    verifiedByAdminId: decision.verified ? context.adminId : null,
    note: decision.note ?? null,
  };

  if (ownerType === 'doctor') {
    await db.doctorDocument.update({ where: { id: documentId }, data });
  } else {
    await db.pharmacyDocument.update({ where: { id: documentId }, data });
  }

  await recordAudit(
    {
      action: AUDIT_ACTIONS.DOCUMENT_VERIFIED,
      actorType: 'ADMIN',
      actorId: context.adminId,
      entityType: `${ownerType}_document`,
      entityId: documentId,
      correlationId: context.correlationId,
      outcome: decision.verified ? 'SUCCESS' : 'DENIED',
      metadata: { verified: decision.verified },
    },
    db,
  );
}
