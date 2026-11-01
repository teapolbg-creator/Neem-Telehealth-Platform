import { z } from 'zod';
import type { TriageCategory } from './patient.ts';
import type { ReferralStatus, ReferralUrgency } from './referral.ts';
import type { FacilityStatus } from './facility.ts';
import type { GeoScopeView } from './staff.ts';

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

const reportRange = z.object({ from: isoDate, to: isoDate });
const rangeInOrder = {
  check: (query: { from: string; to: string }) => query.from <= query.to,
  issue: { path: ['to'], message: 'The end date is before the start date' },
};

export const facilityReportQuerySchema = reportRange.refine(rangeInOrder.check, rangeInOrder.issue);

/**
 * The district dashboard's filters (slice 3b, D85). Each narrows the
 * officer's own area and is refused if it lies outside it.
 */
export const districtReportQuerySchema = reportRange
  .extend({
    districtId: z.string().uuid().optional(),
    subDistrictId: z.string().uuid().optional(),
    /** A facility's publicId. */
    facility: z.string().min(1).max(32).optional(),
  })
  .refine(rangeInOrder.check, rangeInOrder.issue);
export type DistrictReportQuery = z.infer<typeof districtReportQuerySchema>;

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

/** Everything in a facility report that can be summed across facilities. */
export type ReportTotals = Omit<
  FacilityReport,
  'facility' | 'from' | 'to' | 'generatedAt' | 'complaints'
>;

/** One facility's line in the district comparison (D85). */
export interface DistrictFacilityRow {
  publicId: string;
  name: string;
  code: string;
  district: string;
  subDistrict: string | null;
  status: FacilityStatus;
  visits: number;
  newPatients: number;
  /** Visits triaged red. */
  red: number;
  emergencies: number;
  consultationsRequested: number;
  consultationsCompleted: number;
  noDoctorAvailable: number;
  medianWaitMinutes: number | null;
  referrals: number;
  followUpsMissed: number;
}

/**
 * The district dashboard (slice 3b, D85): the facility report summed over
 * the CHPS compounds in the officer's area, and compared facility by
 * facility. Counts only: presenting complaints, which are free text about a
 * patient, stay at the facility.
 */
export interface DistrictReport {
  scope: GeoScopeView;
  from: string;
  to: string;
  generatedAt: string;
  /** What the filters narrowed the area to, in words; null when unfiltered. */
  filteredTo: string | null;
  totals: ReportTotals;
  byFacility: DistrictFacilityRow[];
}
