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
  /** The station's last connection check, or null if it has never run one (D89). */
  link: StationLink | null;
  /** What its browser last reported of the device (D94). */
  device: StationDevice | null;
}

export interface StationDevice {
  /** Null where the browser will not say, which is most tablets but Chrome's. */
  batteryPercent: number | null;
  charging: boolean | null;
  hasCamera: boolean;
  hasMicrophone: boolean;
  browser: string | null;
}

/**
 * A station's connection to Neem, as the station measured it (slice 4b, D89).
 *
 * Measured against Neem's own server, not the video service, so it is a
 * guide to the line rather than a promise about a call. No figure here is
 * judged good or bad by Neem.
 */
export interface StationLink {
  downKbps: number;
  upKbps: number;
  rttMs: number;
  measuredAt: string;
}

/** Bytes the station downloads and uploads to time its connection (D89). */
export const CONNECTION_CHECK_DOWN_BYTES = 256 * 1024;
export const CONNECTION_CHECK_UP_BYTES = 128 * 1024;

export const connectionUploadSchema = z.object({
  sample: z.string().max(CONNECTION_CHECK_UP_BYTES + 1024),
});

export const connectionReportSchema = z.object({
  downKbps: z.number().int().min(0).max(10_000_000),
  upKbps: z.number().int().min(0).max(10_000_000),
  rttMs: z.number().int().min(0).max(600_000),
  device: z
    .object({
      batteryPercent: z.number().int().min(0).max(100).nullable(),
      charging: z.boolean().nullable(),
      hasCamera: z.boolean(),
      hasMicrophone: z.boolean(),
      browser: z.string().trim().max(40).nullable(),
    })
    .optional(),
});
export type ConnectionReport = z.infer<typeof connectionReportSchema>;

/**
 * The facility's choice of lower video quality for its calls (D89): when on,
 * both sides of a CHPS call from this facility join with the video service's
 * low-data mode.
 */
export const videoQualitySchema = z.object({ lowData: z.boolean() });
export type VideoQuality = z.infer<typeof videoQualitySchema>;

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
