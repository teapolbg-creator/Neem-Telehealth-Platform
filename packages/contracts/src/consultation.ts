import { z } from 'zod';
import {
  CONSULTATION_STATES,
  CONSULTATION_TYPES,
  FEEDBACK_CATEGORIES,
  PATIENT_SEXES,
} from './enums.ts';
import { ghanaPhoneSchema } from './onboarding.ts';
import { moneySchema } from './common.ts';

/**
 * Consultation and patient-session contracts (spec §10, §34, §71).
 *
 * The shape of these matters as much as the validation: nothing here carries a
 * patient identifier in a query string or a URL, and nothing accepts a
 * client-supplied payment outcome.
 */

// ---------------------------------------------------------------------------
// Pharmacy: creating and paying for a consultation
// ---------------------------------------------------------------------------

/**
 * Creating a consultation takes almost nothing.
 *
 * Notably absent: any patient detail. The Lovable prototype collected name,
 * age and sex at the counter; the specification puts identity capture on the
 * patient's own phone after they scan the QR (spec §10, finding C2). The
 * pharmacy never types the patient's name.
 */
export const createConsultationSchema = z.object({
  /** Optional promotional code, validated server-side (spec §42). */
  promotionCode: z.string().trim().max(40).optional(),
  /** Where the payment prompt should go, if the pharmacy is initiating one. */
  payerPhone: ghanaPhoneSchema.optional(),
});
export type CreateConsultationRequest = z.infer<typeof createConsultationSchema>;

export const initiatePaymentSchema = z.object({
  /**
   * The number to prompt. May differ from the patient's own number, which is
   * explicitly allowed — both are held temporarily and deleted together
   * (spec §36).
   */
  payerPhone: ghanaPhoneSchema.optional(),
  channel: z.enum(['MOBILE_MONEY', 'CARD', 'LINK']).default('MOBILE_MONEY'),
});

export const consultationSummarySchema = z.object({
  publicId: z.string(),
  state: z.enum(CONSULTATION_STATES),
  type: z.enum(CONSULTATION_TYPES).nullable(),
  language: z.object({ code: z.string(), label: z.string() }).nullable(),
  price: moneySchema,
  discount: moneySchema,
  net: moneySchema,
  createdAt: z.string(),
  paymentDeadlineAt: z.string().nullable(),
  activatedAt: z.string().nullable(),
  patientJoinedAt: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  durationSeconds: z.number().int().nullable(),
  outcome: z.string().nullable(),
  hasPrescription: z.boolean(),
  hasReferral: z.boolean(),
  doctor: z.object({ publicId: z.string(), fullName: z.string() }).nullable(),
  /** Present only while the consultation is live (spec §18). */
  patient: z
    .object({
      fullName: z.string(),
      age: z.number().int(),
      sex: z.enum(PATIENT_SEXES),
      phone: z.string(),
    })
    .nullable(),
  isDemo: z.boolean(),
});
export type ConsultationSummary = z.infer<typeof consultationSummarySchema>;

export const cancelConsultationSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

// ---------------------------------------------------------------------------
// Patient: the temporary session
// ---------------------------------------------------------------------------

/**
 * What the patient enters on their own phone (spec §10).
 *
 * Age rather than a birth date: it is what a prescription needs, and it is
 * less identifying. Everything here is deleted at completion, except the name,
 * age and sex copied onto a prescription or referral (spec §11).
 */
export const patientIdentitySchema = z.object({
  fullName: z.string().trim().min(2).max(160),
  age: z
    .number()
    .int()
    .min(0, 'Enter an age')
    .max(120, 'Enter a valid age'),
  sex: z.enum(PATIENT_SEXES),
  phone: ghanaPhoneSchema,
  /** Recorded when the bill was paid from a different number (spec §36). */
  paymentPhone: ghanaPhoneSchema.optional(),
});
export type PatientIdentity = z.infer<typeof patientIdentitySchema>;

export const patientLanguageSchema = z.object({
  languageCode: z.string().min(2).max(12),
});

export const patientModeSchema = z.object({
  type: z.enum(CONSULTATION_TYPES),
});

/**
 * Patient feedback (spec §51).
 *
 * Two ratings, because they answer different questions: the doctor may have
 * been excellent while the connection was unusable, and a platform that
 * collapsed both into one number could not tell those apart.
 *
 * The comment is optional and free text. It is shown to administrators, never
 * to the doctor.
 */
export const patientFeedbackSchema = z
  .object({
    doctorRating: z.number().int().min(1).max(5),
    neemRating: z.number().int().min(1).max(5),
    category: z.enum(FEEDBACK_CATEGORIES),
    /**
     * Which complaint category, when the category is COMPLAINT.
     *
     * Required in that case rather than defaulted, because a complaint filed
     * against "Other" is one an administrator cannot route, and the patient is
     * the only person who knows whether it was the clinician, the connection
     * or the bill.
     */
    complaintCategoryCode: z.string().trim().min(1).max(60).optional(),
    comment: z.string().trim().max(2000).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.category === 'COMPLAINT' && !value.complaintCategoryCode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['complaintCategoryCode'],
        message: 'Choose what the complaint is about.',
      });
    }
  });
export type PatientFeedback = z.infer<typeof patientFeedbackSchema>;

/**
 * What the patient's own screen may show (spec §72).
 *
 * Deliberately excludes queue position mechanics, doctor scores and any
 * performance data — the patient sees status, not internals.
 */
export const patientSessionViewSchema = z.object({
  consultationPublicId: z.string(),
  state: z.enum(CONSULTATION_STATES),
  /** Which step the portal should render next. */
  step: z.enum(['IDENTITY', 'LANGUAGE', 'MODE', 'WAITING', 'IN_CONSULTATION', 'COMPLETE', 'CLOSED']),
  pharmacyName: z.string(),
  identityCaptured: z.boolean(),
  language: z.object({ code: z.string(), label: z.string() }).nullable(),
  type: z.enum(CONSULTATION_TYPES).nullable(),
  doctor: z.object({ fullName: z.string(), specialty: z.string().nullable() }).nullable(),
  waitingSinceSeconds: z.number().int().nullable(),
  /** Consultation length in seconds, so the client can show a timer. */
  consultationDurationSeconds: z.number().int(),
  expiresAt: z.string().nullable(),
  /** Whether the patient has already left feedback on this consultation. */
  feedbackSubmitted: z.boolean(),
});
export type PatientSessionView = z.infer<typeof patientSessionViewSchema>;

export const availableLanguageSchema = z.object({
  code: z.string(),
  label: z.string(),
  subtitle: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// Payment
// ---------------------------------------------------------------------------

/**
 * What the pharmacy is told about a payment.
 *
 * There is no field by which a client can assert success — status always comes
 * from a server-side verification (spec §34).
 */
/** Named ...View to avoid colliding with the PaymentStatus enum. */
export const paymentStatusViewSchema = z.object({
  consultationPublicId: z.string(),
  consultationState: z.enum(CONSULTATION_STATES),
  paymentStatus: z.string(),
  amount: moneySchema,
  /** Seconds left in the payment window before the consultation expires. */
  secondsRemaining: z.number().int().nullable(),
  /** Hosted checkout or prompt target, where the provider offers one. */
  authorizationUrl: z.string().nullable(),
  /** True when a mock adapter is in use — surfaced in the UI, never hidden. */
  isMockProvider: z.boolean(),
  canRetry: z.boolean(),
});
export type PaymentStatusView = z.infer<typeof paymentStatusViewSchema>;

/**
 * The QR payload the pharmacy displays.
 *
 * The image encodes a URL carrying a one-time token and nothing else — no
 * name, no age, no consultation identifier, no price (spec §10, §60).
 */
export const consultationQrSchema = z.object({
  /** PNG data URI, rendered server-side. */
  qrDataUrl: z.string(),
  /** The same URL in text, for reading aloud or copying. */
  url: z.string(),
  expiresAt: z.string(),
  sequence: z.number().int(),
});
