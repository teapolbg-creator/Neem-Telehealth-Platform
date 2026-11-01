import type { Prisma, PrismaClient } from '@prisma/client';
import {
  ENCOUNTER_REQUIRED,
  ENCOUNTER_SECTIONS,
  type ChpsConsultationContext,
  type EncounterContent,
  type EncounterView,
  type PriorVisitView,
  type VisitEncounterSummary,
} from '@neem/contracts';
import { getPrisma, type Db } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { decryptField, decryptNullable, encryptField } from '../../lib/crypto.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
import { isTerminal } from '../../domain/consultation-state.ts';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit.service.ts';
import { staffNames, toTriageView } from '../facility/patient.service.ts';
import { toConsultationView } from '../facility/chps-consultation.service.ts';
import { toAttachmentView } from '../facility/attachment.service.ts';

/**
 * The doctor's side of a CHPS consultation (slice 1e, D78).
 *
 * The doctor reads what the CHO found and the patient's earlier visits, and
 * writes a structured encounter record into the patient's readable CHPS
 * record (D74). That record is never sealed. It is a draft while the call is
 * live, version 1 once the consultation is completed, and every amendment
 * after that needs a reason and adds a version.
 */

interface StoredEncounter {
  content: EncounterContent;
  vitals: Record<string, number | null> | null;
}

function readStored(contentEnc: string): StoredEncounter {
  return JSON.parse(decryptField(contentEnc)) as StoredEncounter;
}

/** The assigned doctor's CHPS consultation, or "not found" for anybody else. */
async function chpsConsultationFor(publicId: string, doctorId: string, db: Db) {
  const consultation = await db.consultation.findUnique({
    where: { publicId },
    include: {
      doctor: { select: { userId: true, fullName: true } },
      encounter: { include: { versions: { orderBy: { version: 'asc' } } } },
    },
  });
  if (
    !consultation ||
    consultation.doctorId !== doctorId ||
    consultation.channel !== 'CHPS' ||
    !consultation.visitId ||
    !consultation.chpsPatientId
  ) {
    throw errors.notFound('Consultation not found.');
  }
  return consultation;
}

async function encounterView(
  encounter: NonNullable<Awaited<ReturnType<typeof chpsConsultationFor>>['encounter']>,
  db: Db,
): Promise<EncounterView> {
  const stored = readStored(encounter.contentEnc);
  const authors = await db.user.findMany({
    where: { id: { in: [...new Set(encounter.versions.map((v) => v.authorUserId))] } },
    select: { id: true, doctor: { select: { fullName: true } } },
  });
  const nameOf = new Map(authors.map((author) => [author.id, author.doctor?.fullName ?? 'Doctor']));
  return {
    content: stored.content,
    vitalsSnapshot: stored.vitals,
    version: encounter.version,
    finalisedAt: encounter.finalisedAt?.toISOString() ?? null,
    updatedAt: encounter.updatedAt.toISOString(),
    versions: encounter.versions.map((version) => ({
      version: version.version,
      author: nameOf.get(version.authorUserId) ?? 'Doctor',
      reason: version.reason,
      createdAt: version.createdAt.toISOString(),
    })),
  };
}

/**
 * Everything the doctor sees from the CHPS compound. Each call is written to
 * the patient's record-access log (D74).
 */
export async function getChpsContext(
  publicId: string,
  doctor: { doctorId: string; userId: string },
  db: Db = getPrisma(),
): Promise<ChpsConsultationContext> {
  const consultation = await chpsConsultationFor(publicId, doctor.doctorId, db);

  const [patient, visit, priorVisits] = await Promise.all([
    db.patient.findUniqueOrThrow({
      where: { id: consultation.chpsPatientId! },
      include: {
        facility: {
          select: {
            name: true,
            community: true,
            district: { select: { name: true, region: { select: { name: true } } } },
          },
        },
      },
    }),
    db.patientVisit.findUniqueOrThrow({
      where: { id: consultation.visitId! },
      include: {
        triages: { orderBy: { recordedAt: 'desc' } },
        attachments: { orderBy: { createdAt: 'asc' } },
      },
    }),
    db.patientVisit.findMany({
      where: { patientId: consultation.chpsPatientId!, NOT: { id: consultation.visitId! } },
      orderBy: { arrivedAt: 'desc' },
      take: 10,
      include: {
        triages: { orderBy: { recordedAt: 'desc' }, take: 1 },
        consultations: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          include: {
            doctor: { select: { fullName: true } },
            language: { select: { label: true } },
            encounter: { select: { contentEnc: true, finalisedAt: true } },
          },
        },
      },
    }),
  ]);

  await db.patientRecordAccess.create({
    data: {
      patientId: patient.id,
      actorUserId: doctor.userId,
      actorRole: 'DOCTOR',
      facilityId: null,
      purpose: 'care',
    },
  });

  const names = await staffNames(
    [
      ...[...visit.triages, ...priorVisits.flatMap((prior) => prior.triages)].map(
        (triage) => triage.recordedByUserId,
      ),
      ...visit.attachments.map((attachment) => attachment.uploadedByUserId),
    ],
    db,
  );
  const triages = visit.triages.map((triage) => toTriageView(triage, names));

  return {
    facility: {
      name: patient.facility.name,
      community: patient.facility.community,
      district: patient.facility.district.name,
      region: patient.facility.district.region.name,
    },
    patient: {
      patientNumber: patient.patientNumber,
      fullName: decryptField(patient.fullNameEnc),
      sex: patient.sex,
      dateOfBirth: patient.dateOfBirth.toISOString().slice(0, 10),
      dobIsEstimated: patient.dobIsEstimated,
      community: patient.community,
      nhisStatus: patient.nhisStatus,
      allergies: decryptNullable(patient.allergiesEnc),
      medications: decryptNullable(patient.medicationsEnc),
      medicalHistory: decryptNullable(patient.medicalHistoryEnc),
    },
    visit: {
      presentingComplaint: decryptField(visit.presentingComplaintEnc),
      arrivedAt: visit.arrivedAt.toISOString(),
      choNote: decryptNullable(consultation.requestNoteEnc),
      triage: triages[0] ?? null,
      triageHistory: triages,
      attachments: visit.attachments.map((attachment) => toAttachmentView(attachment, names)),
    },
    priorVisits: priorVisits.map((prior): PriorVisitView => {
      const priorConsultation = prior.consultations[0];
      const priorEncounter = priorConsultation?.encounter?.finalisedAt
        ? readStored(priorConsultation.encounter.contentEnc).content
        : null;
      return {
        arrivedAt: prior.arrivedAt.toISOString(),
        presentingComplaint: decryptField(prior.presentingComplaintEnc),
        triage: prior.triages[0] ? toTriageView(prior.triages[0], names) : null,
        consultation: priorConsultation ? toConsultationView(priorConsultation) : null,
        encounter: priorEncounter
          ? {
              clinicalAssessment: priorEncounter.clinicalAssessment ?? null,
              diagnosis: priorEncounter.diagnosis ?? null,
              treatmentPlan: priorEncounter.treatmentPlan ?? null,
              followUp: priorEncounter.followUp ?? null,
              doctorName: priorConsultation?.doctor?.fullName ?? null,
            }
          : null,
      };
    }),
    encounter: consultation.encounter ? await encounterView(consultation.encounter, db) : null,
  };
}

/** The CHO's latest readings, copied into the record as they stand when it is saved. */
async function latestVitals(visitId: string, db: Db) {
  const triage = await db.triageRecord.findFirst({
    where: { visitId },
    orderBy: { recordedAt: 'desc' },
    select: { vitalsEnc: true },
  });
  return triage
    ? (JSON.parse(decryptField(triage.vitalsEnc)) as Record<string, number | null>)
    : null;
}

/**
 * Saves the encounter record.
 *
 * Before completion it is a draft, overwritten in place: autosaving a
 * half-written sentence is not a clinical record. After completion it is an
 * amendment, which needs a reason, adds a version, and is audited.
 */
export async function saveEncounter(
  publicId: string,
  doctor: { doctorId: string; userId: string },
  input: { content: EncounterContent; amendmentReason?: string },
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<EncounterView> {
  const consultation = await chpsConsultationFor(publicId, doctor.doctorId, db);
  const existing = consultation.encounter;
  const stored: StoredEncounter = {
    content: input.content,
    vitals: await latestVitals(consultation.visitId!, db),
  };

  if (existing?.finalisedAt) {
    if (!input.amendmentReason) {
      throw errors.businessRule('This record is final. Say why you are amending it.');
    }
    const version = existing.version + 1;
    await db.$transaction(async (tx) => {
      await tx.encounterRecord.update({
        where: { id: existing.id },
        data: { contentEnc: encryptField(JSON.stringify(stored)), version },
      });
      await tx.encounterRecordVersion.create({
        data: {
          encounterId: existing.id,
          version,
          contentEnc: encryptField(JSON.stringify(stored)),
          authorUserId: doctor.userId,
          reason: input.amendmentReason,
          createdAt: clock.now(),
        },
      });
    });
    await recordAudit(
      {
        action: AUDIT_ACTIONS.ENCOUNTER_AMENDED,
        actorType: 'DOCTOR',
        actorId: doctor.userId,
        entityType: 'encounter_record',
        entityId: existing.id,
        metadata: { version, consultation: consultation.publicId },
      },
      db,
    );
  } else {
    if (isTerminal(consultation.state)) {
      throw errors.businessRule(
        'This consultation ended without being completed, so it has no record to write.',
      );
    }
    await db.encounterRecord.upsert({
      where: { consultationId: consultation.id },
      update: { contentEnc: encryptField(JSON.stringify(stored)) },
      create: {
        consultationId: consultation.id,
        chpsPatientId: consultation.chpsPatientId!,
        doctorId: doctor.doctorId,
        contentEnc: encryptField(JSON.stringify(stored)),
      },
    });
  }

  const fresh = await chpsConsultationFor(publicId, doctor.doctorId, db);
  return encounterView(fresh.encounter!, db);
}

/**
 * Called from `completeConsultation`, inside its transaction, for a CHPS
 * consultation: refuses to complete without an assessment and a plan, then
 * finalises the record as version 1 (D78).
 */
export async function assertEncounterComplete(consultationId: string, db: Db): Promise<void> {
  const encounter = await db.encounterRecord.findUnique({ where: { consultationId } });
  const content = encounter ? readStored(encounter.contentEnc).content : null;
  const missing = ENCOUNTER_REQUIRED.filter((key) => !content?.[key]);
  if (missing.length > 0) {
    const labels = missing.map((key) =>
      ENCOUNTER_SECTIONS.find((section) => section.key === key)!.label.toLowerCase(),
    );
    throw errors.businessRule(
      `Write the ${labels.join(' and ')} in the encounter record before completing.`,
    );
  }
}

export async function finaliseEncounter(
  consultationId: string,
  authorUserId: string,
  tx: Prisma.TransactionClient,
  clock: Clock = systemClock,
): Promise<void> {
  const encounter = await tx.encounterRecord.findUniqueOrThrow({ where: { consultationId } });
  if (encounter.finalisedAt) return;
  const now = clock.now();
  await tx.encounterRecord.update({
    where: { id: encounter.id },
    data: { version: 1, finalisedAt: now },
  });
  await tx.encounterRecordVersion.create({
    data: {
      encounterId: encounter.id,
      version: 1,
      contentEnc: encounter.contentEnc,
      authorUserId,
      createdAt: now,
    },
  });
}

/** The facility's view of a finalised record: what the CHO needs to act on. */
export function toEncounterSummary(
  encounter: { contentEnc: string; version: number; finalisedAt: Date | null } | null,
  doctorName: string | null,
): VisitEncounterSummary | null {
  if (!encounter?.finalisedAt) return null;
  const { content } = readStored(encounter.contentEnc);
  return {
    doctorName,
    clinicalAssessment: content.clinicalAssessment ?? null,
    diagnosis: content.diagnosis ?? null,
    treatmentPlan: content.treatmentPlan ?? null,
    referralInstructions: content.referralInstructions ?? null,
    followUp: content.followUp ?? null,
    version: encounter.version,
    finalisedAt: encounter.finalisedAt.toISOString(),
  };
}
