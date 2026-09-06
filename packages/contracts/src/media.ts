import { z } from 'zod';

/**
 * Media and timer contracts (spec §15, §32, §33).
 *
 * There is no recording schema here, and no field on any schema below by which
 * a client could request, start, or retrieve one. Consultations are never
 * recorded (decision D8).
 */

export const mediaSessionViewSchema = z.object({
  kind: z.enum(['VIDEO', 'AUDIO', 'VOICE_BRIDGE']),
  providerRoomRef: z.string().nullable(),
  /** Credential for the provider's SDK. Absent for a bridged voice call. */
  joinToken: z.string().nullable(),
  /**
   * Where the client connects, for a provider that works by URL rather than by
   * SDK token — Whereby's credential *is* the room URL.
   *
   * A bearer capability: whoever holds it can join the consultation, and the
   * doctor's carries a host key. It is returned only to the authenticated
   * participant it was minted for, and must never be logged, put in an audit
   * entry, or shown on a screen either party could photograph (spec §60).
   *
   * Null for a token-based provider and for the mock.
   */
  joinUrl: z.string().nullable(),
  tokenExpiresAt: z.string().nullable(),
  /**
   * True when no real media can flow. The screen says so plainly rather than
   * showing an empty pane that looks like a failed connection (decision D18).
   */
  isMockProvider: z.boolean(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  /** Always false. Present so the absence is visible, not so it can be set. */
  recordingEnabled: z.literal(false),
});
export type MediaSessionView = z.infer<typeof mediaSessionViewSchema>;

/**
 * The consultation timer.
 *
 * Advisory in both directions: it reports elapsed time and warns as the target
 * approaches, and it can never end a consultation. Only the doctor completes
 * one (spec §15, §16).
 */
export const consultationTimerSchema = z.object({
  elapsedSeconds: z.number().int(),
  durationSeconds: z.number().int(),
  remainingSeconds: z.number().int(),
  warning: z.boolean(),
  overrun: z.boolean(),
  overrunSeconds: z.number().int(),
});
export type ConsultationTimer = z.infer<typeof consultationTimerSchema>;

/**
 * The result of placing a Call Me bridge (spec §33).
 *
 * Carries no phone number, by design: the platform dials both parties, so
 * neither ever learns the other's number.
 */
export const callMeResultSchema = z.object({
  providerCallRef: z.string(),
  status: z.string(),
  /** What the patient's handset displays — the platform's number. */
  callerIdShown: z.string(),
  isMockProvider: z.boolean(),
});
export type CallMeResult = z.infer<typeof callMeResultSchema>;
