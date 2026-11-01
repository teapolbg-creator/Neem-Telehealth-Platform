import { z } from 'zod';

/**
 * Follow-ups: patients the facility expects to see again (slice 2b, D81).
 *
 * The doctor and the receiving facility say "come back in two weeks" in
 * words; the CHO turns that into a date. A follow-up past its date is
 * overdue, never missed, until the CHO records that it was.
 */

export const FOLLOW_UP_STATUSES = ['DUE', 'DONE', 'MISSED', 'CANCELLED'] as const;
export type FollowUpStatus = (typeof FOLLOW_UP_STATUSES)[number];

export const FOLLOW_UP_STATUS_LABELS: Record<FollowUpStatus, string> = {
  DUE: 'Due',
  DONE: 'Seen',
  MISSED: 'Missed',
  CANCELLED: 'Cancelled',
};

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a date');

export const followUpCreateSchema = z.object({
  dueDate: isoDate,
  instructions: z.string().trim().min(3, 'Say what the follow-up is for').max(2000),
  /** When the follow-up was asked for in a referral's feedback. */
  referralPublicId: z.string().max(16).nullish(),
});
export type FollowUpCreate = z.infer<typeof followUpCreateSchema>;

const optionalNote = z
  .string()
  .trim()
  .max(2000)
  .transform((value) => (value === '' ? null : value))
  .nullish();

export const followUpCompleteSchema = z.object({
  note: optionalNote,
  /** The visit at which the patient was seen; their open visit, if omitted. */
  visitPublicId: z.string().max(32).nullish(),
});

export const followUpMissedSchema = z.object({
  note: z.string().trim().min(3, 'Say what happened: called, no answer, moved away…').max(2000),
});

export const followUpCancelSchema = z.object({
  reason: z.string().trim().min(3, 'Say why it is no longer needed').max(500),
});

export const followUpListQuerySchema = z.object({
  /** due: due today or overdue. upcoming: due in the next 14 days. */
  view: z.enum(['due', 'upcoming', 'all']).default('due'),
});

export interface FollowUpView {
  publicId: string;
  status: FollowUpStatus;
  dueDate: string;
  /** True while DUE and the date has passed. */
  overdue: boolean;
  instructions: string;
  createdAt: string;
  createdBy: string;
  referralPublicId: string | null;
  resolved: { at: string; by: string; note: string | null; visitPublicId: string | null } | null;
}

/** One row on the facility's follow-up list. */
export interface FollowUpListRow {
  publicId: string;
  status: FollowUpStatus;
  dueDate: string;
  overdue: boolean;
  instructions: string;
  patient: {
    patientNumber: string;
    fullName: string;
    phone: string | null;
    community: string;
    hasOpenVisit: boolean;
  };
}
