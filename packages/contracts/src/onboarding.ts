import { z } from 'zod';
import { passwordSchema, emailSchema } from './auth.ts';
import {
  DOCTOR_STATUSES,
  PHARMACY_STATUSES,
  EMPLOYMENT_TYPES,
} from './enums.ts';

/**
 * Pharmacy and doctor onboarding contracts (spec §20, §21).
 *
 * Shared by the API (enforcement) and the web forms (immediate feedback), so
 * the two cannot disagree about what is valid.
 */

/** Ghanaian mobile numbers, accepted in local or international form. */
export const ghanaPhoneSchema = z
  .string()
  .trim()
  .regex(
    /^(?:\+233|0)[235][0-9]{8}$/,
    'Enter a Ghanaian phone number, for example 024 000 0000 or +233 24 000 0000',
  )
  .transform((value) => (value.startsWith('0') ? `+233${value.slice(1)}` : value));

const timeOfDaySchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'Use 24-hour time, for example 08:00');

// ---------------------------------------------------------------------------
// Pharmacy
// ---------------------------------------------------------------------------

export const pharmacyHoursSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  opensAt: timeOfDaySchema,
  closesAt: timeOfDaySchema,
});

export const pharmacyRegistrationSchema = z.object({
  // Account
  email: emailSchema,
  password: passwordSchema,

  // Business identity — Pharmacy Council registration is verified manually by
  // an admin; the system makes no automated claim about it (spec §20).
  name: z.string().trim().min(2).max(200),
  councilRegistrationNo: z.string().trim().min(3).max(80),
  ownerName: z.string().trim().min(2).max(160),
  responsiblePharmacistName: z.string().trim().min(2).max(160),
  responsiblePharmacistLicenceNo: z.string().trim().max(80).optional(),

  // Location
  addressLine1: z.string().trim().min(3).max(200),
  addressLine2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(2).max(120),
  region: z.string().trim().min(2).max(120),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),

  // Contact
  phone: ghanaPhoneSchema,

  openingHours: z.array(pharmacyHoursSchema).max(7).default([]),

  /** Capability codes the pharmacy declares — drives the point-of-care UI. */
  tests: z.array(z.string().max(60)).max(40).default([]),
  equipment: z.array(z.string().max(60)).max(40).default([]),
  services: z.array(z.string().max(60)).max(40).default([]),
});
export type PharmacyRegistration = z.infer<typeof pharmacyRegistrationSchema>;

export const pharmacyProfileUpdateSchema = pharmacyRegistrationSchema
  .omit({ email: true, password: true, councilRegistrationNo: true })
  .partial();

export const pharmacySummarySchema = z.object({
  publicId: z.string(),
  name: z.string(),
  councilRegistrationNo: z.string(),
  city: z.string(),
  region: z.string(),
  status: z.enum(PHARMACY_STATUSES),
  statusReason: z.string().nullable(),
  createdAt: z.string(),
  approvedAt: z.string().nullable(),
  documentCount: z.number().int(),
  verifiedDocumentCount: z.number().int(),
  isDemo: z.boolean(),
});
export type PharmacySummary = z.infer<typeof pharmacySummarySchema>;

// ---------------------------------------------------------------------------
// Doctor
// ---------------------------------------------------------------------------

/**
 * Minimum post-qualification experience. Seeded as a system setting
 * (`doctor.minYearsExperience`, default 3) — this is the client-side mirror,
 * and the server re-checks against the live setting.
 */
export const DOCTOR_MIN_YEARS_EXPERIENCE = 3;

export const doctorRegistrationSchema = z.object({
  email: emailSchema,
  password: passwordSchema,

  fullName: z.string().trim().min(2).max(160),
  /** Verified manually. Neem performs NO automated MDC lookup (spec §22). */
  mdcNumber: z.string().trim().min(3).max(60),
  mdcIssuedAt: z.string().date().optional(),
  mdcExpiresAt: z.string().date(),
  qualifiedAt: z.string().date(),
  yearsExperience: z
    .number()
    .int()
    .min(0)
    .max(70),
  specialty: z.string().trim().max(160).optional(),
  bio: z.string().trim().max(2000).optional(),
  phone: ghanaPhoneSchema,

  /** Language codes the doctor can consult in; the first is primary. */
  languageCodes: z
    .array(z.string().min(2).max(12))
    .min(1, 'Select at least one language you can consult in'),
});
export type DoctorRegistration = z.infer<typeof doctorRegistrationSchema>;

export const doctorProfileUpdateSchema = doctorRegistrationSchema
  .omit({ email: true, password: true, mdcNumber: true })
  .partial();

/**
 * The signature is drawn during onboarding (spec §23, decision from answers
 * doc Q18). It is submitted as a PNG data URI from a canvas, stored encrypted,
 * and never exposed at a public URL.
 */
export const doctorSignatureSchema = z.object({
  signatureDataUrl: z
    .string()
    .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/, 'Signature must be a PNG image')
    .max(2_000_000, 'Signature image is too large'),
});

export const doctorSummarySchema = z.object({
  publicId: z.string(),
  fullName: z.string(),
  mdcNumber: z.string(),
  mdcExpiresAt: z.string().nullable(),
  specialty: z.string().nullable(),
  yearsExperience: z.number().int().nullable(),
  status: z.enum(DOCTOR_STATUSES),
  statusReason: z.string().nullable(),
  languages: z.array(z.object({ code: z.string(), label: z.string(), isPrimary: z.boolean() })),
  employmentType: z.enum(EMPLOYMENT_TYPES).nullable(),
  contractedHoursPerWeek: z.number().int().nullable(),
  hasSignature: z.boolean(),
  documentCount: z.number().int(),
  verifiedDocumentCount: z.number().int(),
  subscriptionStatus: z.string().nullable(),
  subscriptionEndsAt: z.string().nullable(),
  createdAt: z.string(),
  approvedAt: z.string().nullable(),
  isDemo: z.boolean(),
});
export type DoctorSummary = z.infer<typeof doctorSummarySchema>;

// ---------------------------------------------------------------------------
// Admin verification actions
// ---------------------------------------------------------------------------

export const DOCTOR_DOCUMENT_TYPES = [
  'MDC_LICENCE',
  'GOVERNMENT_ID',
  'EMPLOYMENT_VERIFICATION',
  'PRACTICE_EVIDENCE',
  'OTHER',
] as const;

/**
 * Documents a pharmacy is asked to supply.
 *
 * These are the categories the verification workflow offers — **not** a claim
 * about what Ghanaian law requires. Neem performs no automated check against
 * any registry; an administrator looks at each file and decides (spec §20,
 * §78). Which documents are sufficient is an operational policy for Neem to
 * set, and the register of open regulatory questions covers whether a formal
 * list exists.
 */
export const PHARMACY_DOCUMENT_TYPES = [
  'COUNCIL_REGISTRATION',
  'SUPERINTENDENT_LICENCE',
  'BUSINESS_REGISTRATION',
  'PREMISES_EVIDENCE',
  'OTHER',
] as const;
export type PharmacyDocumentType = (typeof PHARMACY_DOCUMENT_TYPES)[number];

export const PHARMACY_DOCUMENT_LABELS: Record<PharmacyDocumentType, string> = {
  COUNCIL_REGISTRATION: 'Pharmacy Council registration certificate',
  SUPERINTENDENT_LICENCE: 'Superintendent pharmacist’s practising licence',
  BUSINESS_REGISTRATION: 'Business registration certificate',
  PREMISES_EVIDENCE: 'Evidence of premises',
  OTHER: 'Other supporting document',
};

export const documentVerificationSchema = z.object({
  verified: z.boolean(),
  note: z.string().trim().max(500).optional(),
});

/**
 * Suspension, rejection and expiry require a reason — these are adverse
 * actions against a real clinician or business, and the audit trail must be
 * able to answer "why" (spec §96).
 */
export const accountStatusChangeSchema = z
  .object({
    status: z.string(),
    reason: z.string().trim().max(500).optional(),
  })
  .refine(
    (value) => !['SUSPENDED', 'REJECTED', 'EXPIRED'].includes(value.status) || Boolean(value.reason),
    { path: ['reason'], message: 'A reason is required when suspending, rejecting or expiring an account' },
  );
export type AccountStatusChange = z.infer<typeof accountStatusChangeSchema>;

/**
 * Doctor compensation. Every field is optional because the part-time formula
 * is NOT decided, and must not be invented (spec §26). The system records what
 * an admin configures and calculates from it; it never derives a rate itself,
 * and it never transfers a salary payment.
 */
/**
 * A doctor's employment terms (spec §26, decision D28).
 *
 * Pay is **derived, never entered**. The rate and the monthly figure used to be
 * free inputs here, from when no part-time formula had been settled. Now that
 * one has — full-time monthly pay scaled by contracted hours over a full week —
 * accepting a typed salary alongside it would make the formula decorative and
 * let two doctors on identical terms be paid differently.
 */
export const doctorCompensationSchema = z.object({
  employmentType: z.enum(EMPLOYMENT_TYPES),
  contractedHoursPerWeek: z.number().int().min(0).max(168),
});

/** What the formula produced, returned so an admin sees it before saving. */
export const compensationResultSchema = z.object({
  monthlyMinor: z.number().int(),
  currency: z.string(),
  fraction: z.number(),
  isFullTime: z.boolean(),
  /** Fortieths of a pesewa lost to rounding — zero at the seeded values. */
  remainderNumerator: z.number().int(),
  fullTimeMonthlyMinor: z.number().int(),
  fullTimeHoursPerWeek: z.number().int(),
});
export type CompensationResult = z.infer<typeof compensationResultSchema>;

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

export const shiftAssignmentSchema = z.object({
  doctorPublicId: z.string(),
  shiftCode: z.string().min(2).max(40),
  /** ISO date, e.g. 2026-09-01. */
  serviceDate: z.string().date(),
});
export type ShiftAssignmentRequest = z.infer<typeof shiftAssignmentSchema>;

export const shiftAssignmentResultSchema = z.object({
  id: z.string(),
  serviceDate: z.string(),
  shift: z.object({ code: z.string(), label: z.string(), startsAt: z.string(), endsAt: z.string() }),
  status: z.string(),
  minutesPlanned: z.number().int(),
  weeklyMinutesScheduled: z.number().int(),
  weeklyLimitMinutes: z.number().int(),
});

export const serviceHoursSummarySchema = z.object({
  isoYear: z.number().int(),
  isoWeek: z.number().int(),
  minutesScheduled: z.number().int(),
  minutesServed: z.number().int(),
  limitMinutes: z.number().int(),
  remainingMinutes: z.number().int(),
});
