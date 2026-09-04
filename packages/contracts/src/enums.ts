/**
 * Shared enumerations.
 *
 * These are the single source of truth for values that appear in the database,
 * the API, and the UI. Prisma enums mirror these names exactly; a test in the
 * API package asserts they have not drifted apart.
 */

export const USER_ROLES = ['ADMIN', 'DOCTOR', 'PHARMACY'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** Patients are not users. They hold a consultation-scoped session instead. */
export const PRINCIPAL_KINDS = ['ADMIN', 'DOCTOR', 'PHARMACY', 'PATIENT'] as const;
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];

export const USER_STATUSES = ['ACTIVE', 'SUSPENDED', 'DISABLED'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/** Spec §83 — only ACTIVE doctors may receive consultations. */
export const DOCTOR_STATUSES = [
  'PENDING',
  'UNDER_REVIEW',
  'APPROVED',
  'ACTIVE',
  'SUSPENDED',
  'EXPIRED',
  'REJECTED',
] as const;
export type DoctorStatus = (typeof DOCTOR_STATUSES)[number];

/** Spec §84 — only ACTIVE pharmacies may initiate consultations. */
export const PHARMACY_STATUSES = [
  'PENDING',
  'UNDER_REVIEW',
  'APPROVED',
  'ACTIVE',
  'SUSPENDED',
  'REJECTED',
] as const;
export type PharmacyStatus = (typeof PHARMACY_STATUSES)[number];

/** Spec §81 — see docs/consultation-flow.md for the valid transition table. */
export const CONSULTATION_STATES = [
  'PENDING_PAYMENT',
  'PAYMENT_PROCESSING',
  'PAYMENT_FAILED',
  'PAID',
  'ACTIVATED',
  'WAITING_FOR_PATIENT',
  'PATIENT_JOINED',
  'WAITING_FOR_DOCTOR',
  'ASSIGNED',
  'REASSIGNING',
  'DOCTOR_ACCEPTED',
  'IN_PROGRESS',
  'COMPLETING',
  'COMPLETED',
  'EXPIRED',
  'CANCELLED',
  'ABANDONED',
  'REFUND_REQUESTED',
  'REFUNDED',
] as const;
export type ConsultationState = (typeof CONSULTATION_STATES)[number];

/**
 * The states a consultation never leaves (spec §81).
 *
 * Shared rather than duplicated: the API uses it to decide when to release
 * doctor capacity and seal the clinical record, and the web uses it to decide
 * whether to offer a call at all. Two lists would eventually disagree, and the
 * failure would be a doctor being offered a call into a finished consultation.
 */
export const TERMINAL_CONSULTATION_STATES = [
  'COMPLETED',
  'EXPIRED',
  'CANCELLED',
  'ABANDONED',
  'REFUNDED',
] as const satisfies readonly ConsultationState[];

export function isTerminalConsultationState(state: string): boolean {
  return (TERMINAL_CONSULTATION_STATES as readonly string[]).includes(state);
}

export const CONSULTATION_TYPES = ['AUDIO', 'VIDEO', 'CALL_ME'] as const;
export type ConsultationType = (typeof CONSULTATION_TYPES)[number];

export const CONSULTATION_OUTCOMES = [
  'ADVICE_ONLY',
  'PRESCRIPTION',
  'REFERRAL',
  'EMERGENCY_REFERRAL',
  'OTHER',
] as const;
export type ConsultationOutcome = (typeof CONSULTATION_OUTCOMES)[number];

/** Spec §82 — DISPENSED can never become REVOKED. */
export const PRESCRIPTION_STATES = [
  'DRAFT',
  'ISSUED',
  'ACTIVE',
  'PENDING_SUBSTITUTION',
  'SUBSTITUTION_APPROVED',
  'SUBSTITUTION_REJECTED',
  'DISPENSED',
  'REVOKED',
] as const;
export type PrescriptionState = (typeof PRESCRIPTION_STATES)[number];

export const SUBSTITUTION_STATES = ['PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN'] as const;
export type SubstitutionState = (typeof SUBSTITUTION_STATES)[number];

export const PAYMENT_STATUSES = [
  'PENDING',
  'PROCESSING',
  'SUCCESS',
  'FAILED',
  'ABANDONED',
  'REVERSED',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const REFUND_STATES = [
  'REQUESTED',
  'APPROVED',
  'REJECTED',
  'PROCESSING',
  'COMPLETED',
  'FAILED',
] as const;
export type RefundState = (typeof REFUND_STATES)[number];

export const PAYOUT_STATUSES = ['PENDING', 'PROCESSING', 'PAID', 'FAILED', 'RECONCILED'] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

export const SUBSCRIPTION_STATUSES = [
  'PENDING',
  'ACTIVE',
  'GRACE',
  'EXPIRED',
  'CANCELLED',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const FEEDBACK_CATEGORIES = ['COMPLAINT', 'COMPLIMENT', 'SUGGESTION'] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

export const PATIENT_SEXES = ['FEMALE', 'MALE', 'OTHER'] as const;
export type PatientSex = (typeof PATIENT_SEXES)[number];

export const EMPLOYMENT_TYPES = ['FULL_TIME', 'PART_TIME', 'CONTRACT'] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const NOTIFICATION_CHANNELS = [
  'IN_APP',
  'BROWSER',
  'SMS',
  'EMAIL',
  'WHATSAPP',
  'PUSH',
] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];
