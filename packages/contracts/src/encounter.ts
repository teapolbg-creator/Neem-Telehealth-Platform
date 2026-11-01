import { z } from 'zod';
import type { NhisStatus, TriageView, VisitConsultation } from './patient.ts';

/**
 * The doctor's side of a CHPS consultation (slice 1e, D78): what the CHO
 * found, and the structured encounter record the doctor writes.
 */

const section = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? null : value))
    .nullish();

/**
 * The encounter record's sections, in the order the brief lists them (§B4).
 * Vital signs are not typed here: they are the CHO's, shown beside the form
 * and copied into the record as they stood when it was saved.
 */
export const encounterContentSchema = z.object({
  presentingComplaint: section(2000),
  historyOfPresentingComplaint: section(4000),
  relevantHistory: section(4000),
  /** Including what could not be examined remotely. */
  examinationFindings: section(4000),
  clinicalAssessment: section(4000),
  diagnosis: section(2000),
  treatmentPlan: section(4000),
  referralInstructions: section(2000),
  followUp: section(2000),
});
export type EncounterContent = z.infer<typeof encounterContentSchema>;

export const ENCOUNTER_SECTIONS: { key: keyof EncounterContent; label: string; hint?: string }[] = [
  { key: 'presentingComplaint', label: 'Presenting complaint' },
  { key: 'historyOfPresentingComplaint', label: 'History of presenting complaint' },
  { key: 'relevantHistory', label: 'Relevant medical history' },
  {
    key: 'examinationFindings',
    label: 'Examination findings',
    hint: 'Include what could not be examined remotely.',
  },
  { key: 'clinicalAssessment', label: 'Clinical assessment' },
  { key: 'diagnosis', label: 'Diagnosis', hint: 'Where appropriate.' },
  { key: 'treatmentPlan', label: 'Treatment plan' },
  { key: 'referralInstructions', label: 'Referral instructions' },
  { key: 'followUp', label: 'Follow-up' },
];

/** What completing a CHPS consultation requires of the record (D78). */
export const ENCOUNTER_REQUIRED: (keyof EncounterContent)[] = [
  'clinicalAssessment',
  'treatmentPlan',
];

export const encounterSaveSchema = z.object({
  content: encounterContentSchema,
  /** Required once the record is final: every amendment says why. */
  amendmentReason: z.string().trim().min(3).max(500).optional(),
});

export interface EncounterVersionView {
  version: number;
  author: string;
  reason: string | null;
  createdAt: string;
}

export interface EncounterView {
  content: EncounterContent;
  /** The CHO's readings as they stood when the record was last saved. */
  vitalsSnapshot: Record<string, number | null> | null;
  version: number;
  finalisedAt: string | null;
  updatedAt: string;
  versions: EncounterVersionView[];
}

/** An earlier visit, as the doctor sees it: enough to know what happened. */
export interface PriorVisitView {
  arrivedAt: string;
  presentingComplaint: string;
  triage: TriageView | null;
  consultation: VisitConsultation | null;
  encounter: {
    clinicalAssessment: string | null;
    diagnosis: string | null;
    treatmentPlan: string | null;
    followUp: string | null;
    doctorName: string | null;
  } | null;
}

/**
 * Everything the doctor sees from the CHPS compound (D78). Read through one
 * route, and every read is logged against the patient (D74).
 */
export interface ChpsConsultationContext {
  facility: { name: string; community: string; district: string; region: string };
  patient: {
    patientNumber: string;
    fullName: string;
    sex: 'FEMALE' | 'MALE' | 'OTHER';
    dateOfBirth: string;
    dobIsEstimated: boolean;
    community: string;
    nhisStatus: NhisStatus;
    allergies: string | null;
    medications: string | null;
    medicalHistory: string | null;
  };
  visit: {
    presentingComplaint: string;
    arrivedAt: string;
    choNote: string | null;
    triage: TriageView | null;
    triageHistory: TriageView[];
  };
  priorVisits: PriorVisitView[];
  encounter: EncounterView | null;
}

/** What the facility sees of the doctor's record, once it is final. */
export interface VisitEncounterSummary {
  doctorName: string | null;
  clinicalAssessment: string | null;
  diagnosis: string | null;
  treatmentPlan: string | null;
  referralInstructions: string | null;
  followUp: string | null;
  version: number;
  finalisedAt: string;
}
