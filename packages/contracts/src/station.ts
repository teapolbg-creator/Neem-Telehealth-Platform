import { z } from 'zod';

/**
 * Consultation stations: the screen at a CHPS compound a patient speaks to the
 * doctor on (CHPS slice 1d, D77).
 *
 * A station is paired once with a code a CHO generates, and from then on can
 * only show what it has been given: a welcome, a "your doctor will be with you
 * shortly", or the call. It never holds a patient record.
 */

/** Header every station request that changes something must carry (D77). */
export const STATION_HEADER = 'x-neem-station';

/** How long a pairing code is good for. */
export const STATION_PAIRING_MINUTES = 15;

export const stationCreateSchema = z.object({
  label: z.string().trim().min(2, 'Name the station, e.g. Consulting room tablet').max(80),
});

/** Pairing codes are read off one screen and typed into another, so they forgive. */
export const stationPairSchema = z.object({
  code: z
    .string()
    .trim()
    .min(6)
    .max(16)
    .transform((value) => value.toUpperCase().replace(/[^0-9A-Z]/g, '')),
});

export const stationAssignSchema = z.object({
  stationPublicId: z.string().min(1).max(32),
});

export interface StationSummary {
  publicId: string;
  label: string;
  status: 'AWAITING_PAIRING' | 'PAIRED' | 'REVOKED';
  /** Seen within the last minute. A station polls every few seconds while open. */
  online: boolean;
  lastSeenAt: string | null;
  pairedAt: string | null;
  /** What it is showing, for the CHO's eyes only. */
  current: { visitPublicId: string; patientName: string; consultationState: string } | null;
}

export interface StationPairing {
  station: StationSummary;
  /** Shown once, typed into the station. */
  pairingCode: string;
  pairingExpiresAt: string;
}

/**
 * What the station screen may know (D77). Deliberately thin: a first name to
 * greet, a doctor's name once they have accepted, and nothing else about the
 * patient.
 */
export type StationMode = 'IDLE' | 'WAITING_FOR_DOCTOR' | 'READY';

export interface StationState {
  station: { label: string };
  facility: { name: string };
  mode: StationMode;
  /** Changes with each consultation, so the screen knows when one ended. */
  sessionKey: string | null;
  patientFirstName: string | null;
  doctorName: string | null;
  kind: 'VIDEO' | 'AUDIO' | null;
}
