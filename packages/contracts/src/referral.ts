import { z } from 'zod';

/**
 * Tracked referrals from a CHPS compound (slice 2a, D79, D80).
 *
 * The receiving facility has no Neem account. A referral is ISSUED when the
 * CHO sends the patient, and moves on only when facility staff record what
 * the receiving facility told them, by phone or in person. Neem never assumes
 * a patient arrived.
 */

export const REFERRAL_URGENCIES = ['ROUTINE', 'URGENT', 'EMERGENCY'] as const;
export type ReferralUrgency = (typeof REFERRAL_URGENCIES)[number];

export const REFERRAL_URGENCY_LABELS: Record<ReferralUrgency, string> = {
  ROUTINE: 'Routine',
  URGENT: 'Urgent',
  EMERGENCY: 'Emergency',
};

export const REFERRAL_STATUSES = [
  'ISSUED',
  'ACKNOWLEDGED',
  'ATTENDED',
  'DID_NOT_ARRIVE',
  'CANCELLED',
] as const;
export type ReferralStatus = (typeof REFERRAL_STATUSES)[number];

/** Said as what is known, never as what is hoped. */
export const REFERRAL_STATUS_LABELS: Record<ReferralStatus, string> = {
  ISSUED: 'Sent, not yet confirmed',
  ACKNOWLEDGED: 'Expected by the receiving facility',
  ATTENDED: 'Seen at the receiving facility',
  DID_NOT_ARRIVE: 'Did not arrive',
  CANCELLED: 'Cancelled',
};

/** A referral still waiting for news. */
export const OPEN_REFERRAL_STATUSES: readonly ReferralStatus[] = ['ISSUED', 'ACKNOWLEDGED'];

export const REFERRAL_CONTACT_METHODS = ['PHONE', 'IN_PERSON', 'OTHER'] as const;
export type ReferralContactMethod = (typeof REFERRAL_CONTACT_METHODS)[number];

export const REFERRAL_CONTACT_LABELS: Record<ReferralContactMethod, string> = {
  PHONE: 'By phone',
  IN_PERSON: 'In person',
  OTHER: 'Other',
};

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? null : value))
    .nullish();

export const referralCreateSchema = z
  .object({
    /** A facility from the registry, or a free-text destination below. */
    destinationFacilityPublicId: z.string().max(32).nullish(),
    destinationName: optionalText(200),
    destinationDepartment: optionalText(160),
    urgency: z.enum(REFERRAL_URGENCIES),
    reason: z.string().trim().min(3, 'Say why the patient is being referred').max(2000),
    clinicalSummary: optionalText(4000),
    transport: optionalText(500),
  })
  .refine((input) => input.destinationFacilityPublicId || input.destinationName, {
    path: ['destinationName'],
    message: 'Choose a facility, or type where the patient is going',
  });
export type ReferralCreate = z.infer<typeof referralCreateSchema>;

export const referralAcknowledgeSchema = z.object({
  via: z.enum(REFERRAL_CONTACT_METHODS),
  contact: optionalText(160),
});

export const referralOutcomeSchema = z.object({
  outcome: z.enum(['ATTENDED', 'DID_NOT_ARRIVE']),
  via: z.enum(REFERRAL_CONTACT_METHODS),
  feedback: optionalText(4000),
});

export const referralFeedbackSchema = z.object({
  feedback: z.string().trim().min(3, 'Write what the receiving facility said').max(4000),
});

export const referralCancelSchema = z.object({
  reason: z.string().trim().min(3, 'Say why the referral is cancelled').max(500),
});

export const referralListQuerySchema = z.object({
  status: z.enum(REFERRAL_STATUSES).optional(),
  open: z.enum(['true', 'false']).optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

export interface ReferralView {
  publicId: string;
  status: ReferralStatus;
  urgency: ReferralUrgency;
  destination: { name: string; department: string | null; facilityPublicId: string | null };
  reason: string;
  clinicalSummary: string | null;
  transport: string | null;
  issuedAt: string;
  issuedBy: string;
  /** The doctor whose advice it acts on, when it came from a consultation. */
  doctorName: string | null;
  acknowledged: {
    at: string;
    by: string;
    via: ReferralContactMethod;
    contact: string | null;
  } | null;
  outcomeAt: string | null;
  feedback: { text: string; at: string; by: string } | null;
  cancelled: { at: string; reason: string } | null;
}

/** One row of the referral register. */
export interface ReferralRegisterRow {
  publicId: string;
  status: ReferralStatus;
  urgency: ReferralUrgency;
  destinationName: string;
  issuedAt: string;
  /** Days since issue while still waiting for news; null once resolved. */
  daysOutstanding: number | null;
  patient: { patientNumber: string; fullName: string };
}

export interface ReferralDestination {
  publicId: string;
  name: string;
  type: string;
  district: string;
}
