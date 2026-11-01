import type { VisitAttachmentView } from '@neem/contracts';
import { getEnv } from '../../config/env.ts';
import { getStorageProvider } from '../../adapters/storage/local-storage.provider.ts';
import {
  ALLOWED_UPLOAD_TYPES,
  buildStorageKey,
  detectedTypeMatches,
} from '../../adapters/storage/storage.provider.ts';
import { getPrisma, type Db } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { decryptField, encryptField, generatePublicId } from '../../lib/crypto.ts';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit.service.ts';
import type { StaffContext } from './patient.service.ts';

/**
 * Files kept with a CHPS visit (slice 2d, D83).
 *
 * Checked the way every upload is (size, declared type, and that the bytes
 * really are that type), then encrypted before they reach storage: the local
 * storage adapter writes plain files, and a photographed result is clinical.
 * Every download is audited.
 */

const STORAGE_MIME = 'application/octet-stream';

export async function addAttachment(
  ctx: StaffContext,
  visitPublicId: string,
  input: { label: string; mimeType: string; body: Buffer },
  db: Db = getPrisma(),
): Promise<VisitAttachmentView> {
  const visit = await db.patientVisit.findUnique({ where: { publicId: visitPublicId } });
  if (!visit || visit.facilityId !== ctx.facilityId) throw errors.notFound('Visit not found.');

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
  if (!detectedTypeMatches(input.mimeType, input.body)) {
    throw errors.validation([
      { field: 'file', issue: 'That file’s contents do not match its file type' },
    ]);
  }

  const storageKey = buildStorageKey(`visits/${visit.id}`, input.mimeType);
  await getStorageProvider().put({
    key: storageKey,
    body: Buffer.from(encryptField(input.body.toString('base64')), 'utf8'),
    mimeType: STORAGE_MIME,
  });

  const attachment = await db.visitAttachment.create({
    data: {
      publicId: generatePublicId('att'),
      facilityId: ctx.facilityId,
      patientId: visit.patientId,
      visitId: visit.id,
      label: input.label,
      contentType: input.mimeType,
      sizeBytes: input.body.length,
      storageKey,
      uploadedByUserId: ctx.userId,
    },
  });
  await recordAudit(
    {
      action: AUDIT_ACTIONS.ATTACHMENT_ADDED,
      actorType: 'FACILITY',
      actorId: ctx.userId,
      entityType: 'visit_attachment',
      entityId: attachment.id,
      correlationId: ctx.correlationId,
      metadata: { contentType: input.mimeType, sizeBytes: input.body.length },
    },
    db,
  );

  const member = await db.facilityUser.findUnique({
    where: { userId: ctx.userId },
    select: { fullName: true },
  });
  return toAttachmentView(attachment, new Map([[ctx.userId, member?.fullName ?? '']]));
}

export function toAttachmentView(
  row: {
    publicId: string;
    label: string;
    contentType: string;
    sizeBytes: number;
    createdAt: Date;
    uploadedByUserId: string;
  },
  names: Map<string, string>,
): VisitAttachmentView {
  return {
    publicId: row.publicId,
    label: row.label,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    uploadedAt: row.createdAt.toISOString(),
    uploadedBy: names.get(row.uploadedByUserId) ?? 'Former staff member',
  };
}

/**
 * Reads an attachment for somebody already shown to be allowed: the
 * facility's staff, or the doctor of a consultation on the visit. The caller
 * decides who that is; this decrypts and audits.
 */
export async function readAttachment(
  publicId: string,
  allowed: (attachment: { facilityId: string; visitId: string }) => Promise<boolean>,
  actor: { type: 'FACILITY' | 'DOCTOR'; userId: string; correlationId?: string },
  db: Db = getPrisma(),
): Promise<{ body: Buffer; contentType: string; label: string }> {
  const attachment = await db.visitAttachment.findUnique({ where: { publicId } });
  if (!attachment || !(await allowed(attachment))) {
    throw errors.notFound('Attachment not found.');
  }
  const stored = await getStorageProvider().get(attachment.storageKey);
  const body = Buffer.from(decryptField(stored.toString('utf8')), 'base64');

  await recordAudit(
    {
      action: AUDIT_ACTIONS.ATTACHMENT_DOWNLOADED,
      actorType: actor.type,
      actorId: actor.userId,
      entityType: 'visit_attachment',
      entityId: attachment.id,
      correlationId: actor.correlationId,
    },
    db,
  );
  return { body, contentType: attachment.contentType, label: attachment.label };
}
