import { z } from 'zod';
import type { UserRole } from './enums.ts';
import type { StationDevice, StationLink } from './station.ts';

/**
 * System monitoring for Neem operations (slice 3d, D87).
 *
 * Counted from records the system already writes: sessions, doctor presence,
 * station heartbeats, consultation state events, notification attempts,
 * provider webhooks and the audit log. Live figures are now; event counts
 * cover the chosen window. No threshold turns a count into an alarm.
 */

export const MONITORING_WINDOWS = [24, 168] as const;

export const monitoringQuerySchema = z.object({
  hours: z.coerce
    .number()
    .int()
    .refine((value) => (MONITORING_WINDOWS as readonly number[]).includes(value), {
      message: 'Choose 24 or 168 hours',
    })
    .default(24),
});

/** A paired station as it last reported itself (D94). */
export interface MonitoredStation {
  publicId: string;
  label: string;
  facilityName: string;
  facilityPublicId: string;
  online: boolean;
  lastSeenAt: string | null;
  link: StationLink | null;
  device: StationDevice | null;
}

export interface OfflineStation {
  publicId: string;
  label: string;
  facilityName: string;
  facilityPublicId: string;
  /** Null when the station has never been seen since pairing. */
  lastSeenAt: string | null;
}

/** One sign-in or pairing failure, for the super administrator only (D84). */
export interface SecurityEvent {
  occurredAt: string;
  action: string;
  /** In words: "Sign-in failed", "Account locked". */
  label: string;
  /** The account it concerned, when there was one. */
  account: { email: string; role: UserRole } | null;
  /** The recorded reason, such as unknown_account; never a password or code. */
  reason: string | null;
}

export interface SystemMonitoring {
  generatedAt: string;
  windowHours: number;

  /** Live staff sessions: not revoked, not expired. */
  sessions: { active: number; byRole: Partial<Record<UserRole, number>> };

  /** Declared online with a recent heartbeat, and declared online without one (D72). */
  doctors: { online: number; staleHeartbeat: number };

  /** Paired stations, and the ones not seen in the last minute, longest silent first. */
  stations: {
    paired: number;
    online: number;
    offline: OfflineStation[];
    /** Every paired station, with its connection and device (D94). */
    all: MonitoredStation[];
  };
  /** Rooms open right now, whoever is in them (D94). */
  activeVideoSessions: number;

  calls: {
    /** Video or audio rooms opened in the window. */
    roomsOpened: number;
    /** Consultations whose call broke (D57). */
    interruptions: number;
    /** Rooms replaced because the old one could no longer be joined. */
    roomsReplaced: number;
  };

  notifications: { failed: number; byChannel: Record<string, number> };

  webhooks: { received: number; invalidSignatures: number };

  security: {
    loginFailures: number;
    lockouts: number;
    twoFactorFailures: number;
    pairingRefusals: number;
    /** The latest events, newest first; null for those without audit:read. */
    recent: SecurityEvent[] | null;
  };
}
