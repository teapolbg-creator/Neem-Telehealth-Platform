import { z } from 'zod';
import type { TriageCategory } from './patient.ts';
import type { ReferralStatus, ReferralUrgency } from './referral.ts';

/**
 * A CHPS facility's daily and monthly report (slice 2c, brief §A8, D82).
 *
 * Every figure is counted from records the facility already keeps; nothing
 * is estimated. Presenting complaints are listed as written, never counted
 * by type, because there is no coded list to count against (D79).
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

/** At most a quarter at once: a facility report, not a data export. */
export const REPORT_MAX_DAYS = 92;

export const facilityReportQuerySchema = z
  .object({ from: isoDate, to: isoDate })
  .refine((query) => query.from <= query.to, {
    path: ['to'],
    message: 'The end date is before the start date',
  });

export interface ReportDay {
  date: string;
  visits: number;
  newPatients: number;
  consultationsRequested: number;
  consultationsCompleted: number;
  referrals: number;
}

export interface FacilityReport {
  facility: { name: string; code: string };
  from: string;
  to: string;
  generatedAt: string;

  attendance: {
    /** Walk-in visits that arrived in the period. */
    visits: number;
    /** Patients registered for the first time in the period. */
    newPatients: number;
    /** Distinct patients seen. */
    patientsSeen: number;
    byTriage: Record<TriageCategory | 'NOT_TRIAGED', number>;
    emergencies: number;
    /** How visits that arrived in the period ended; OPEN is not ended yet. */
    outcomes: { CLOSED: number; REFERRED: number; CANCELLED: number; OPEN: number };
  };

  consultations: {
    requested: number;
    completed: number;
    /** Withdrawn by the facility before a doctor accepted. */
    withdrawn: number;
    /** Ended because no doctor took them in time. */
    noDoctorAvailable: number;
    /** Still open at the time of the report. */
    inProgress: number;
    /**
     * Minutes from request to a doctor accepting, for requests a doctor
     * accepted. Null when there were none.
     */
    waitMinutes: { median: number | null; average: number | null; longest: number | null };
    /** Median consultation length in minutes, for completed consultations. */
    medianDurationMinutes: number | null;
  };

  doctors: { name: string; completed: number; medianDurationMinutes: number | null }[];

  referrals: {
    issued: number;
    byUrgency: Record<ReferralUrgency, number>;
    byStatus: Record<ReferralStatus, number>;
    destinations: { name: string; count: number }[];
  };

  followUps: {
    /** Follow-ups whose due date fell in the period. */
    due: number;
    done: number;
    missed: number;
    cancelled: number;
    /** Due in the period and still not resolved. */
    stillDue: number;
  };

  /** Presenting complaints as the CHO wrote them, newest first (D79). */
  complaints: { date: string; text: string }[];

  days: ReportDay[];
}
