import type { ActorType } from '@prisma/client';
import { getPrisma, Prisma, type Db } from '../../db/prisma.ts';
import { getLogger } from '../../lib/logger.ts';

/**
 * Audit log.
 *
 * Append-only. There is deliberately no update or delete method on this
 * service, and the production database account used for this table holds only
 * INSERT and SELECT (docs/security.md §7).
 *
 * The audit log must NOT become a back-door medical history (spec §61). The
 * metadata sanitiser below is the enforcement point: any key that could carry
 * clinical or personal content is dropped before the row is written, and a
 * test asserts it.
 */

export const AUDIT_ACTIONS = {
  LOGIN_SUCCEEDED: 'auth.login.succeeded',
  LOGIN_FAILED: 'auth.login.failed',
  LOGIN_LOCKED: 'auth.login.locked',
  LOGOUT: 'auth.logout',
  TWO_FACTOR_ENROLLED: 'auth.2fa.enrolled',
  TWO_FACTOR_SUCCEEDED: 'auth.2fa.succeeded',
  TWO_FACTOR_FAILED: 'auth.2fa.failed',
  PASSWORD_RESET_REQUESTED: 'auth.password-reset.requested',
  PASSWORD_RESET_COMPLETED: 'auth.password-reset.completed',
  PASSWORD_CHANGED: 'auth.password.changed',
  SESSION_REVOKED: 'auth.session.revoked',

  DOCTOR_REGISTERED: 'doctor.registered',
  DOCTOR_STATUS_CHANGED: 'doctor.status-changed',
  DOCTOR_APPROVED: 'doctor.approved',
  DOCTOR_SUSPENDED: 'doctor.suspended',
  DOCTOR_REJECTED: 'doctor.rejected',
  DOCTOR_SIGNATURE_CAPTURED: 'doctor.signature.captured',
  DOCTOR_COMPENSATION_CHANGED: 'doctor.compensation.changed',
  DOCTOR_LICENCE_EXPIRING: 'doctor.licence.expiring',

  PHARMACY_REGISTERED: 'pharmacy.registered',
  PHARMACY_STATUS_CHANGED: 'pharmacy.status-changed',
  PHARMACY_APPROVED: 'pharmacy.approved',
  PHARMACY_SUSPENDED: 'pharmacy.suspended',

  DOCUMENT_UPLOADED: 'document.uploaded',
  DOCUMENT_VERIFIED: 'document.verified',
  DOCUMENT_DOWNLOADED: 'document.downloaded',

  SHIFT_ASSIGNED: 'shift.assigned',
  SHIFT_CONFIRMED: 'shift.confirmed',
  SHIFT_CANCELLED: 'shift.cancelled',
  SHIFT_LIMIT_BLOCKED: 'shift.limit-blocked',

  QUEUE_NO_LANGUAGE_MATCH: 'queue.no-language-match',
  QUEUE_DELAY: 'queue.delay',

  SUBSCRIPTION_CREATED: 'subscription.created',
  SUBSCRIPTION_EXPIRED: 'subscription.expired',
  SUBSCRIPTION_RENEWED: 'subscription.renewed',

  CONSULTATION_CREATED: 'consultation.created',
  CONSULTATION_STATE_CHANGED: 'consultation.state-changed',
  CONSULTATION_TOKEN_ISSUED: 'consultation.token.issued',
  CONSULTATION_TOKEN_REISSUED: 'consultation.token.reissued',
  CONSULTATION_COMPLETED: 'consultation.completed',

  PAYMENT_CONFIRMED: 'payment.confirmed',
  PAYMENT_ANOMALY: 'payment.anomaly',
  REFUND_REQUESTED: 'refund.requested',
  REFUND_DECIDED: 'refund.decided',
  PAYOUT_MARKED_PAID: 'payout.marked-paid',

  DOCTOR_ASSIGNED: 'queue.doctor.assigned',
  DOCTOR_MISSED_RESPONSE: 'queue.doctor.missed-response',

  PRESCRIPTION_ISSUED: 'prescription.issued',
  PRESCRIPTION_REVOKED: 'prescription.revoked',
  PRESCRIPTION_DISPENSED: 'prescription.dispensed',
  SUBSTITUTION_REQUESTED: 'substitution.requested',
  SUBSTITUTION_DECIDED: 'substitution.decided',
  REFERRAL_GENERATED: 'referral.generated',

  SETTING_CHANGED: 'settings.changed',
  SENSITIVE_RECORD_ACCESSED: 'access.sensitive-record',
  RETENTION_PURGE_EXECUTED: 'retention.purge.executed',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

/**
 * Keys never permitted in audit metadata. Blocking by key name is coarse, but
 * it is the right default here: a missing audit detail is recoverable, a
 * clinical note leaked into a permanent append-only table is not.
 */
const FORBIDDEN_METADATA_KEYS = new Set([
  'notes',
  'clinicalnotes',
  'note',
  'diagnosis',
  'treatment',
  'symptoms',
  'patientname',
  'fullname',
  'name',
  'phone',
  'phonenumber',
  'paymentphone',
  'medication',
  'medications',
  'dose',
  'frequency',
  'instructions',
  'password',
  'passwordhash',
  'token',
  'tokenhash',
  'secret',
  'signature',
  'signaturedata',
  'vitals',
  'testresult',
  'resulttext',
  'comment',
  'reasontext',
]);

const MAX_METADATA_STRING = 300;

export function sanitiseAuditMetadata(
  input: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!input) return undefined;

  const output: Record<string, unknown> = {};
  const dropped: string[] = [];

  for (const [key, value] of Object.entries(input)) {
    if (FORBIDDEN_METADATA_KEYS.has(key.toLowerCase())) {
      dropped.push(key);
      continue;
    }

    if (value === null || typeof value === 'boolean' || typeof value === 'number') {
      output[key] = value;
    } else if (typeof value === 'string') {
      output[key] = value.slice(0, MAX_METADATA_STRING);
    } else if (value instanceof Date) {
      output[key] = value.toISOString();
    } else if (Array.isArray(value)) {
      // Only scalar arrays — nested objects are where content hides.
      output[key] = value
        .filter((v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
        .slice(0, 25);
    } else {
      dropped.push(key);
    }
  }

  if (dropped.length > 0) {
    output._droppedKeys = dropped;
  }

  return Object.keys(output).length > 0 ? output : undefined;
}

export interface AuditEntry {
  action: AuditAction;
  actorType: ActorType;
  actorId?: string | null;
  entityType?: string;
  entityId?: string;
  correlationId?: string;
  ipHash?: string | null;
  userAgent?: string | null;
  outcome?: 'SUCCESS' | 'FAILURE' | 'DENIED';
  metadata?: Record<string, unknown>;
}

/**
 * Writes an audit entry.
 *
 * When a transaction client is supplied the entry is part of that transaction,
 * so an audited action and its record either both happen or neither does.
 */
export async function recordAudit(entry: AuditEntry, db: Db = getPrisma()): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        action: entry.action,
        actorType: entry.actorType,
        actorId: entry.actorId ?? null,
        entityType: entry.entityType ?? null,
        entityId: entry.entityId ?? null,
        correlationId: entry.correlationId ?? null,
        ipHash: entry.ipHash ?? null,
        userAgent: entry.userAgent?.slice(0, 512) ?? null,
        outcome: entry.outcome ?? 'SUCCESS',
        // Sanitised above; the cast is only to satisfy Prisma's Json input type.
        metadata: (sanitiseAuditMetadata(entry.metadata) as Prisma.InputJsonValue) ?? undefined,
      },
    });
  } catch (error) {
    // An audit write failing must not take down the user-facing operation, but
    // it is a serious condition and is logged at error level for alerting.
    getLogger().error(
      { err: error, action: entry.action, entityType: entry.entityType },
      'failed to write audit log entry',
    );
  }
}
