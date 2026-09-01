import type { PrismaClient } from '@prisma/client';
import { getPrisma, type Db } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { decryptField, decryptNullable } from '../../lib/crypto.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit.service.ts';
import type { VitalsReadings } from './clinical-record.service.ts';

/**
 * Archived Consultation Retrieval (decision D27).
 *
 * Counsel's instruction was explicit: *"Do NOT build a conventional patient
 * history feature. Instead, build an Archived Consultation Retrieval
 * mechanism."* The name matters. "Break-glass" implies a treating clinician
 * reaching past a barrier in an emergency, which is exactly what this is not.
 * This is controlled administrative retrieval of one archived encounter, for a
 * stated lawful reason, by people who are not treating the patient.
 *
 * Four properties hold it together:
 *
 *  1. **Encounter-scoped.** One consultation reference at a time. There is no
 *     query by patient, because there is no patient to query by (D24).
 *  2. **The reference identifies; it does not authorise.** Quoting it says
 *     which record is meant. Opening it requires everything below. Otherwise a
 *     discarded prescription slip is a key to someone's clinical record.
 *  3. **Two people.** A single administrator cannot unseal a record alone.
 *  4. **Everything is logged, before the fact.** Purpose and reference are
 *     recorded when access is requested, not written up afterwards.
 *
 * Deliberately absent: any route a doctor or pharmacy can reach, anything that
 * takes a patient name or phone number, and anything that returns more than one
 * consultation. If a formal clinical break-glass workflow is later required,
 * it becomes another authorisation path into this same mechanism rather than a
 * redesign.
 */

/** The closed list from counsel (D27). Anything else is refused. */
export const RETRIEVAL_PURPOSES = [
  'LEGAL_OR_REGULATORY_PROCEEDING',
  'PATIENT_DATA_ACCESS_REQUEST',
  'AUTHORISED_CLINICAL_RECORD_REQUEST',
  'QUALITY_OR_SAFETY_INVESTIGATION',
  'INTERNAL_INVESTIGATION_OR_AUDIT',
] as const;

export type RetrievalPurpose = (typeof RETRIEVAL_PURPOSES)[number];

export const RETRIEVAL_PURPOSE_LABELS: Record<RetrievalPurpose, string> = {
  LEGAL_OR_REGULATORY_PROCEEDING: 'Legal or regulatory proceeding',
  PATIENT_DATA_ACCESS_REQUEST: 'Patient data-access request',
  AUTHORISED_CLINICAL_RECORD_REQUEST: 'Authorised clinical-record request',
  QUALITY_OR_SAFETY_INVESTIGATION: 'Quality or safety investigation',
  INTERNAL_INVESTIGATION_OR_AUDIT: 'Internal investigation or audit',
};

/**
 * Counsel also permits an approved research purpose, preferably de-identified.
 * It is **deliberately not in the list above** and is not built.
 *
 * Research over a sealed archive is the single most likely route by which this
 * design quietly becomes the longitudinal history it exists to avoid, and it
 * needs a lawful basis and a consent mechanism that do not yet exist (G7d).
 * When it is built it will be a separate, de-identifying, aggregate export —
 * not a purpose code bolted onto a mechanism that returns one patient's
 * identifiable record.
 */
export const RESEARCH_IS_DELIBERATELY_UNSUPPORTED = true;

export interface RetrievalRequest {
  /** The consultation reference, as printed on the patient's documents. */
  consultationPublicId: string;
  purpose: RetrievalPurpose;
  /** Case, inquiry or ticket reference. Recorded before access. */
  reference: string;
  /** The administrator performing the retrieval. */
  actor: { userId: string; role: string };
  /** A second administrator authorising it. Must not be the same person. */
  authorisedByUserId: string;
  correlationId?: string;
}

export interface ArchivedConsultation {
  consultationPublicId: string;
  /** When the record was sealed, and when it is due for destruction. */
  sealedAt: string;
  destroyAt: string | null;
  /** Operational context, which was never sealed. */
  encounter: {
    date: string;
    pharmacyName: string;
    doctorName: string | null;
    type: string | null;
    language: string | null;
    durationSeconds: number | null;
    outcome: string | null;
  };
  patient: { fullName: string; age: number | null; sex: string | null; phone: string | null } | null;
  clinical: {
    notes: string | null;
    diagnosis: string | null;
    treatment: string | null;
    vitals: VitalsReadings | null;
    tests: Array<{ code: string; label: string; result: string }>;
  };
  /** The id of the log entry this retrieval created, for closing it. */
  accessLogId: string;
}

/**
 * Retrieves one archived consultation.
 *
 * Every refusal below is deliberate, and each one is the reason a
 * corresponding test exists.
 */
export async function retrieveArchivedConsultation(
  input: RetrievalRequest,
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<ArchivedConsultation> {
  if (!RETRIEVAL_PURPOSES.includes(input.purpose)) {
    throw errors.businessRule('That is not a permitted reason for retrieving a clinical record.');
  }
  if (!input.reference?.trim()) {
    throw errors.businessRule(
      'A case or inquiry reference is required. Retrieval is recorded against a stated matter, not performed on request.',
    );
  }

  /**
   * Two people, and two different people.
   *
   * An administrator authorising their own retrieval is a single-person
   * action wearing a second hat, which defeats the control entirely.
   */
  if (input.authorisedByUserId === input.actor.userId) {
    throw errors.businessRule(
      'A second administrator must authorise this retrieval. You cannot authorise your own.',
    );
  }

  const authoriser = await db.user.findUnique({
    where: { id: input.authorisedByUserId },
    select: { id: true, role: true, status: true },
  });
  if (!authoriser || authoriser.role !== 'ADMIN' || authoriser.status !== 'ACTIVE') {
    throw errors.businessRule('The authorising account must be an active administrator.');
  }

  const consultation = await db.consultation.findUnique({
    where: { publicId: input.consultationPublicId },
    include: {
      pharmacy: { select: { name: true } },
      doctor: { select: { fullName: true } },
      language: { select: { label: true } },
      patientSession: true,
      clinicalNotes: true,
      vitals: { orderBy: { recordedAt: 'desc' }, take: 1 },
      tests: { orderBy: { recordedAt: 'desc' } },
      retentionJobs: { where: { status: 'SCHEDULED' }, take: 1 },
    },
  });

  if (!consultation) {
    throw errors.notFound('No consultation exists with that reference.');
  }
  if (!consultation.clinicalSealedAt) {
    // A live consultation is the treating doctor's business, not an
    // archivist's. Retrieval is for records that are closed.
    throw errors.businessRule(
      'That consultation is still in progress. Archived retrieval applies to sealed records only.',
    );
  }

  const records: string[] = [];
  if (consultation.clinicalNotes) records.push('clinical_notes');
  if (consultation.vitals.length > 0) records.push('vitals');
  if (consultation.tests.length > 0) records.push('tests');
  if (consultation.patientSession) records.push('patient_identity');

  /**
   * The log entry is written **before** the record is returned, in the same
   * transaction as nothing else. If writing the log fails, the retrieval does
   * not happen — an unlogged disclosure is worse than a refused one.
   */
  const logEntry = await db.clinicalRecordAccessLog.create({
    data: {
      consultationId: consultation.id,
      actorUserId: input.actor.userId,
      actorRole: input.actor.role,
      authorisedByUserId: input.authorisedByUserId,
      purpose: input.purpose,
      reference: input.reference.trim().slice(0, 200),
      recordsAccessed: records,
      accessedAt: clock.now(),
    },
  });

  await recordAudit(
    {
      action: AUDIT_ACTIONS.CLINICAL_RECORD_RETRIEVED,
      actorType: 'ADMIN',
      actorId: input.actor.userId,
      entityType: 'consultation',
      entityId: consultation.id,
      correlationId: input.correlationId,
      // Purpose and scope, never content. The audit log must not become a
      // second copy of the archive (spec §13, §61).
      metadata: { purpose: input.purpose, records, authorisedBy: input.authorisedByUserId },
    },
    db,
  );

  const vitals = consultation.vitals[0];

  return {
    consultationPublicId: consultation.publicId,
    sealedAt: consultation.clinicalSealedAt.toISOString(),
    destroyAt: consultation.retentionJobs[0]?.scheduledFor.toISOString() ?? null,
    encounter: {
      date: consultation.createdAt.toISOString(),
      pharmacyName: consultation.pharmacy.name,
      doctorName: consultation.doctor?.fullName ?? null,
      type: consultation.type,
      language: consultation.language?.label ?? null,
      durationSeconds: consultation.durationSeconds,
      outcome: consultation.outcome,
    },
    patient: consultation.patientSession
      ? {
          fullName: decryptNullable(consultation.patientSession.fullNameEnc) ?? '',
          age: consultation.patientSession.age,
          sex: consultation.patientSession.sex,
          phone: decryptNullable(consultation.patientSession.phoneEnc),
        }
      : null,
    clinical: {
      notes: decryptNullable(consultation.clinicalNotes?.notesEnc),
      diagnosis: decryptNullable(consultation.clinicalNotes?.diagnosisEnc),
      treatment: decryptNullable(consultation.clinicalNotes?.treatmentEnc),
      vitals: vitals ? (JSON.parse(decryptField(vitals.readingsEnc)) as VitalsReadings) : null,
      tests: consultation.tests.map((test) => ({
        code: test.testCode,
        label: test.testLabel,
        result: decryptField(test.resultEnc),
      })),
    },
    accessLogId: logEntry.id,
  };
}

/**
 * Closes a retrieval, recording when access ended (counsel's minimum list).
 *
 * Idempotent, and never reopens a closed entry — the log is append-only in
 * spirit, and this is the one field that may be filled in afterwards because
 * it cannot be known in advance.
 */
export async function endRetrieval(
  accessLogId: string,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<void> {
  await db.clinicalRecordAccessLog.updateMany({
    where: { id: accessLogId, accessEndedAt: null },
    data: { accessEndedAt: clock.now() },
  });
}

/**
 * The retrieval history for oversight.
 *
 * Deliberately reads the log and nothing else: this answers "who opened what,
 * and why", not "what did it say". An oversight screen that rendered the
 * records alongside would be the history feature by another route.
 */
export async function listRetrievals(
  filters: { consultationPublicId?: string; limit?: number } = {},
  db: Db = getPrisma(),
) {
  const consultation = filters.consultationPublicId
    ? await db.consultation.findUnique({
        where: { publicId: filters.consultationPublicId },
        select: { id: true },
      })
    : null;

  const entries = await db.clinicalRecordAccessLog.findMany({
    where: consultation ? { consultationId: consultation.id } : {},
    include: { consultation: { select: { publicId: true } } },
    orderBy: { accessedAt: 'desc' },
    take: Math.min(filters.limit ?? 50, 200),
  });

  return entries.map((entry) => ({
    id: entry.id,
    consultationPublicId: entry.consultation.publicId,
    actorUserId: entry.actorUserId,
    actorRole: entry.actorRole,
    authorisedByUserId: entry.authorisedByUserId,
    purpose: entry.purpose,
    reference: entry.reference,
    recordsAccessed: entry.recordsAccessed,
    accessedAt: entry.accessedAt.toISOString(),
    accessEndedAt: entry.accessEndedAt?.toISOString() ?? null,
  }));
}
