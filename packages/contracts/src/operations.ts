import { z } from 'zod';
import type {
  FacilityConnectivityStatus,
  FacilityEquipmentStatus,
  FacilityStatus,
} from './facility.ts';

/**
 * Neem operations' view of CHPS as it stands now (slice 3c, D86).
 *
 * Live state is read at the moment of the request: nothing is cached, and a
 * figure that cannot be known (a station never seen) is null, not zero.
 * Nothing here is flagged by a threshold Neem made up: the page sorts what
 * needs looking at first and shows the numbers.
 */

/** How far back doctor utilisation looks. Live state is always now. */
export const UTILISATION_PERIODS = [1, 7, 30] as const;

export const chpsOperationsQuerySchema = z.object({
  days: z.coerce
    .number()
    .int()
    .refine((value) => (UTILISATION_PERIODS as readonly number[]).includes(value), {
      message: 'Choose 1, 7 or 30 days',
    })
    .default(1),
});

export interface ChpsFacilityLive {
  publicId: string;
  name: string;
  code: string;
  district: string;
  region: string;
  status: FacilityStatus;
  equipmentStatus: FacilityEquipmentStatus;
  connectivityStatus: FacilityConnectivityStatus;
  stations: {
    paired: number;
    online: number;
    /** The most recent any station of this facility was seen; null if never. */
    lastSeenAt: string | null;
  };
  /** Visits that arrived today (UTC, which is Ghana). */
  visitsToday: number;
  /** Open visits not yet triaged. */
  awaitingTriage: number;
  /** Visits escalated as emergencies and not yet ended. */
  openEmergencies: number;
  /** Doctor requests not yet accepted. */
  waitingForDoctor: number;
  /** The oldest of those, in minutes since it was queued; null when none wait. */
  longestWaitMinutes: number | null;
  /** Consultations a doctor has accepted and not finished. */
  withDoctor: number;
  /** When any of the facility's staff last used Neem; null if never. */
  staffLastActiveAt: string | null;
}

export interface DoctorUtilisation {
  publicId: string;
  name: string;
  /** Online now: declared present, with a recent heartbeat (D72). */
  online: boolean;
  currentLoad: number;
  maxLoad: number;
  /** Consultations completed in the period, by where they came from. */
  completed: { COUNTER: number; DIRECT: number; CHPS: number };
  /** Minutes in completed consultations in the period. */
  consultationMinutes: number;
}

export interface ChpsOperationsOverview {
  generatedAt: string;
  utilisationDays: number;
  totals: {
    facilities: number;
    activeFacilities: number;
    stationsPaired: number;
    stationsOnline: number;
    visitsToday: number;
    openEmergencies: number;
    waitingForDoctor: number;
    withDoctor: number;
    doctorsOnline: number;
    /** All time, across CHPS (D94). */
    doctorsActive: number;
    patientsRegistered: number;
    consultations: number;
    consultationsCompleted: number;
    /** Calls that broke at least once. */
    consultationsInterrupted: number;
    referralsIssued: number;
  };
  /** Open emergencies first, then the longest wait for a doctor, then by name. */
  facilities: ChpsFacilityLive[];
  /** Online doctors and anyone who completed a consultation in the period. */
  doctors: DoctorUtilisation[];
}
