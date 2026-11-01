import { z } from 'zod';
import { ghanaPhoneSchema } from './onboarding.ts';

/**
 * CHPS patients, walk-in visits and triage (CHPS slice 1b, D74, D75).
 *
 * A CHPS patient has a lasting record held by the facility that registered
 * them, readable by the clinicians caring for them (D74). Registration must
 * never be a barrier to care: only a name, sex, an age, a community, a
 * presenting complaint and consent are required. Everything else is optional.
 */

export const NHIS_STATUSES = ['ACTIVE', 'EXPIRED', 'NOT_MEMBER', 'UNKNOWN'] as const;
export type NhisStatus = (typeof NHIS_STATUSES)[number];

export const NHIS_STATUS_LABELS: Record<NhisStatus, string> = {
  ACTIVE: 'Active member',
  EXPIRED: 'Membership expired',
  NOT_MEMBER: 'Not a member',
  UNKNOWN: 'Not known',
};

export const CONSENT_GIVEN_BY = ['PATIENT', 'GUARDIAN'] as const;
export type ConsentGivenBy = (typeof CONSENT_GIVEN_BY)[number];

/**
 * What the patient (or guardian) agrees to, read aloud by the CHO.
 *
 * Versioned, and the version is stored with the patient, so a later change to
 * the wording never rewrites what somebody agreed to.
 */
export const CHPS_CONSENT_VERSION = 'chps-2026-10';
export const CHPS_CONSENT_TEXT =
  'Neem will keep a record of your health information from this visit and later visits. ' +
  'The health staff at this facility, and the doctor you speak to through Neem, can read it to ' +
  'care for you. You may speak to a licensed doctor by video on the screen here. The video is ' +
  'not recorded. You can refuse, and you will still be cared for at this facility.';

export const VISIT_STATUSES = [
  'AWAITING_TRIAGE',
  'TRIAGED',
  'ESCALATED',
  'CLOSED',
  'CANCELLED',
] as const;
export type VisitStatus = (typeof VISIT_STATUSES)[number];

export const VISIT_STATUS_LABELS: Record<VisitStatus, string> = {
  AWAITING_TRIAGE: 'Awaiting triage',
  TRIAGED: 'Triaged',
  ESCALATED: 'Emergency',
  CLOSED: 'Completed',
  CANCELLED: 'Cancelled',
};

/** A visit is open until it is closed or cancelled. */
export const OPEN_VISIT_STATUSES: readonly VisitStatus[] = [
  'AWAITING_TRIAGE',
  'TRIAGED',
  'ESCALATED',
];

/**
 * Red, orange, yellow, green (D74).
 *
 * The CHO chooses the category from their own clinical judgement. Neem does
 * not compute one from vital signs, and these descriptions say what each
 * category means for the workflow, not how to decide it.
 */
export const TRIAGE_CATEGORIES = ['RED', 'ORANGE', 'YELLOW', 'GREEN'] as const;
export type TriageCategory = (typeof TRIAGE_CATEGORIES)[number];

export const TRIAGE_CATEGORY_INFO: Record<TriageCategory, { label: string; meaning: string }> = {
  RED: { label: 'Red', meaning: 'Emergency. Start your emergency protocol now; do not queue.' },
  ORANGE: { label: 'Orange', meaning: 'Very urgent.' },
  YELLOW: { label: 'Yellow', meaning: 'Urgent.' },
  GREEN: { label: 'Green', meaning: 'Routine.' },
};

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? null : value))
    .nullish();

const optionalPhone = ghanaPhoneSchema.or(z.literal('').transform(() => null)).nullish();

/**
 * NHIS membership numbers are digits, sometimes written with spaces or
 * hyphens. Stored digits-only so two spellings are one number.
 */
const nhisNumberSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/[\s-]/g, ''))
  .refine((value) => value === '' || /^\d{6,12}$/.test(value), {
    message: 'Enter the NHIS number as digits',
  })
  .transform((value) => (value === '' ? null : value))
  .nullish();

const personSchema = z.object({
  name: z.string().trim().min(2, 'Enter their name').max(160),
  phone: optionalPhone,
  relationship: z.string().trim().min(2, 'Say how they are related').max(60),
});

const patientFields = z.object({
  fullName: z.string().trim().min(2, 'Enter the patient’s name').max(160),
  sex: z.enum(['FEMALE', 'MALE', 'OTHER']),
  /** Exactly one of a date of birth or an age is given. */
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date picker')
    .nullish(),
  ageYears: z.number().int().min(0).max(120).nullish(),
  ageMonths: z.number().int().min(0).max(11).nullish(),
  phone: optionalPhone,
  community: z.string().trim().min(2, 'Enter the community or village').max(160),
  nhisStatus: z.enum(NHIS_STATUSES).default('UNKNOWN'),
  nhisNumber: nhisNumberSchema,
  emergencyContact: personSchema.nullish(),
  allergies: optionalText(2000),
  medications: optionalText(2000),
  medicalHistory: optionalText(4000),
});

export const patientRegistrationSchema = patientFields
  .extend({
    consentGivenBy: z.enum(CONSENT_GIVEN_BY, {
      errorMap: () => ({ message: 'Record who gave consent' }),
    }),
    representative: personSchema.omit({ phone: true }).nullish(),
    /** Starts a visit in the same step, which is how a walk-in arrives. */
    presentingComplaint: z.string().trim().min(2, 'Say why they came today').max(2000),
    clientRequestId: z.string().uuid().optional(),
  })
  .superRefine((input, ctx) => {
    const hasDate = Boolean(input.dateOfBirth);
    const hasAge = input.ageYears !== null && input.ageYears !== undefined;
    if (hasDate === hasAge) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dateOfBirth'],
        message: 'Give either a date of birth or an estimated age',
      });
    }
    if (input.consentGivenBy === 'GUARDIAN' && !input.representative) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['representative'],
        message: 'Record the guardian’s name and relationship',
      });
    }
    if (input.nhisNumber && input.nhisStatus === 'NOT_MEMBER') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['nhisNumber'],
        message: 'A non-member has no NHIS number',
      });
    }
  });
export type PatientRegistration = z.infer<typeof patientRegistrationSchema>;

/** Contact details and history; identity (name, sex, birth date) is fixed after registration. */
export const patientUpdateSchema = patientFields
  .pick({
    phone: true,
    community: true,
    nhisStatus: true,
    nhisNumber: true,
    emergencyContact: true,
    allergies: true,
    medications: true,
    medicalHistory: true,
  })
  .partial();
export type PatientUpdate = z.infer<typeof patientUpdateSchema>;

export const patientSearchSchema = z
  .object({
    name: z.string().trim().max(160).optional(),
    phone: z.string().trim().max(24).optional(),
    nhisNumber: z.string().trim().max(24).optional(),
    patientNumber: z.string().trim().max(16).optional(),
  })
  .refine((input) => input.name || input.phone || input.nhisNumber || input.patientNumber, {
    message: 'Search by name, phone, NHIS number or patient number',
  });

export const visitCreateSchema = z.object({
  presentingComplaint: z.string().trim().min(2, 'Say why they came today').max(2000),
  clientRequestId: z.string().uuid().optional(),
});

/**
 * Readings are optional and range-checked only for plausibility — catching a
 * typed 370 for 37.0 — never against clinical thresholds.
 */
const reading = (min: number, max: number, label: string) =>
  z
    .number({ invalid_type_error: `Enter ${label} as a number` })
    .min(min, `Check ${label}: below ${min} is not plausible`)
    .max(max, `Check ${label}: above ${max} is not plausible`)
    .nullish();

export const vitalSignsSchema = z
  .object({
    bpSystolic: reading(40, 300, 'systolic pressure'),
    bpDiastolic: reading(20, 200, 'diastolic pressure'),
    temperatureC: reading(25, 45, 'temperature'),
    pulseBpm: reading(20, 250, 'pulse'),
    respiratoryRate: reading(4, 80, 'respiratory rate'),
    spo2Percent: reading(40, 100, 'oxygen saturation'),
    weightKg: reading(0.3, 350, 'weight'),
    heightCm: reading(20, 250, 'height'),
    glucoseMmolL: reading(0.5, 50, 'blood glucose'),
  })
  .refine(
    (v) =>
      (v.bpSystolic === null || v.bpSystolic === undefined) ===
      (v.bpDiastolic === null || v.bpDiastolic === undefined),
    { path: ['bpDiastolic'], message: 'Enter both blood pressure numbers' },
  );
export type VitalSigns = z.infer<typeof vitalSignsSchema>;

export const triageCreateSchema = z.object({
  category: z.enum(TRIAGE_CATEGORIES, {
    errorMap: () => ({ message: 'Choose a triage category' }),
  }),
  vitals: vitalSignsSchema.default({}),
  symptoms: optionalText(2000),
  observations: optionalText(2000),
});
export type TriageCreate = z.infer<typeof triageCreateSchema>;

export const visitEscalateSchema = z.object({
  note: z
    .string()
    .trim()
    .min(2, 'Record what you have done: who was called, where they go')
    .max(2000),
});

/** Asking for a Neem doctor for a triaged visit (slice 1c, D76). */
export const chpsConsultationRequestSchema = z.object({
  languageCode: z.string().trim().min(2).max(8),
  type: z.enum(['VIDEO', 'AUDIO']).default('VIDEO'),
  note: z.string().trim().max(1000).optional(),
});
export type ChpsConsultationRequest = z.infer<typeof chpsConsultationRequestSchema>;

export const chpsConsultationCancelSchema = z.object({
  reason: z.string().trim().min(2, 'Say why the request is withdrawn').max(500),
});

/**
 * A consultation's state in words for the facility (D76). Says what is true —
 * "waiting for a doctor" until one has accepted, never sooner.
 */
export const CHPS_CONSULTATION_PROGRESS: Record<string, string> = {
  WAITING_FOR_DOCTOR: 'Waiting for a doctor',
  ASSIGNED: 'Waiting for a doctor',
  REASSIGNING: 'Waiting for a doctor',
  DOCTOR_ACCEPTED: 'Doctor accepted',
  IN_PROGRESS: 'In consultation',
  INTERRUPTED: 'Call interrupted',
  COMPLETING: 'Doctor finishing notes',
  COMPLETED: 'Consultation completed',
  CANCELLED: 'Request withdrawn',
  EXPIRED: 'No doctor was available',
  ABANDONED: 'Consultation ended',
};

export interface VisitConsultation {
  reference: string;
  state: string;
  type: 'VIDEO' | 'AUDIO';
  requestedAt: string;
  /** Only once a doctor has accepted; an offer can still be declined. */
  doctorName: string | null;
  language: string | null;
  /** True until the consultation reaches an end state. */
  active: boolean;
}

export const visitCloseSchema = z.object({
  outcome: z.enum(['CLOSED', 'CANCELLED']),
  note: z.string().trim().min(2, 'Record how the visit ended').max(2000),
});

export interface PatientSummary {
  publicId: string;
  patientNumber: string;
  fullName: string;
  sex: 'FEMALE' | 'MALE' | 'OTHER';
  dateOfBirth: string;
  dobIsEstimated: boolean;
  community: string;
  hasOpenVisit: boolean;
  lastVisitAt: string | null;
}

export interface TriageView {
  id: string;
  category: TriageCategory;
  vitals: VitalSigns;
  symptoms: string | null;
  observations: string | null;
  recordedBy: string;
  recordedAt: string;
}

export interface VisitView {
  publicId: string;
  status: VisitStatus;
  presentingComplaint: string;
  arrivedAt: string;
  escalatedAt: string | null;
  escalationNote: string | null;
  closedAt: string | null;
  closingNote: string | null;
  triage: TriageView | null;
  triageHistory: TriageView[];
  consultation: VisitConsultation | null;
}

export interface PatientRecord extends PatientSummary {
  phone: string | null;
  nhisStatus: NhisStatus;
  nhisNumber: string | null;
  emergencyContact: { name: string; phone: string | null; relationship: string } | null;
  representative: { name: string; relationship: string } | null;
  allergies: string | null;
  medications: string | null;
  medicalHistory: string | null;
  consent: { givenBy: ConsentGivenBy; version: string; at: string };
  registeredAt: string;
  visits: VisitView[];
}

/** One row on the facility's board: enough to act on, no clinical detail beyond the complaint. */
export interface VisitBoardRow {
  publicId: string;
  status: VisitStatus;
  arrivedAt: string;
  presentingComplaint: string;
  triageCategory: TriageCategory | null;
  consultation: VisitConsultation | null;
  patient: {
    patientNumber: string;
    fullName: string;
    sex: 'FEMALE' | 'MALE' | 'OTHER';
    dateOfBirth: string;
  };
}

export interface FacilityDaySummary {
  date: string;
  seenToday: number;
  waiting: number;
  escalatedToday: number;
  closedToday: number;
  /** Requests no doctor has accepted yet (D76). */
  awaitingDoctor: number;
  /** Consultations a doctor has accepted and not yet finished. */
  withDoctor: number;
  board: VisitBoardRow[];
}
