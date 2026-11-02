import { z } from 'zod';

/**
 * A doctor's own consultations, to look back over (slice 5a, brief §B5, D91).
 *
 * Only consultations this doctor took. A CHPS patient is named, because their
 * record stays open to the clinicians who cared for them (D74). A pharmacy or
 * direct patient is not: that record is sealed when the consultation ends (D23).
 */

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-02')
  .optional();

export const doctorHistoryQuerySchema = z.object({
  /** A whole word of the name, or a card number. CHPS patients only. */
  patient: z.string().trim().max(120).optional(),
  facility: z.string().trim().max(32).optional(),
  from: date,
  to: date,
  cursor: z.string().max(64).optional(),
});
export type DoctorHistoryQuery = z.infer<typeof doctorHistoryQuerySchema>;

export interface DoctorHistoryRow {
  publicId: string;
  channel: string;
  state: string;
  type: string | null;
  /** The compound or pharmacy it came from. */
  origin: string | null;
  /** Null where the identity is sealed (D23). */
  patientName: string | null;
  patientNumber: string | null;
  requestedAt: string;
  completedAt: string | null;
}

export interface DoctorWorkload {
  /** Offers open right now. */
  pending: number;
  active: number;
  completedToday: number;
  completedTotal: number;
}

export interface DoctorHistory {
  workload: DoctorWorkload;
  /** The compounds this doctor has seen patients from, for the filter. */
  facilities: Array<{ publicId: string; name: string }>;
  rows: DoctorHistoryRow[];
  nextCursor: string | null;
}
