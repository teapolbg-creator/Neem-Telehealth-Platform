/**
 * Video and voice abstractions (spec §32, §33, §91).
 *
 * Twilio is the intended provider, but no business logic knows that. Two rules
 * are baked into the shape of these interfaces rather than left to the
 * implementations:
 *
 *  1. **There is no way to enable recording.** No parameter, no option, no
 *     flag. Consultations are never recorded (spec §32), and the surest way to
 *     guarantee that is for the capability to be absent from the contract an
 *     adapter is written against. A configuration flag can be flipped by
 *     mistake; a method that does not exist cannot be called.
 *
 *  2. **Call Me never exposes a phone number to the other party.** The
 *     provider dials both legs and bridges them, so the doctor never learns
 *     the patient's number and the patient never learns the doctor's
 *     (spec §33).
 */

export type MediaKind = 'VIDEO' | 'AUDIO';

export interface CreateRoomInput {
  /** Our consultation's public id — never a patient identifier. */
  consultationPublicId: string;
  kind: MediaKind;
  /** Seconds after which the provider should tear the room down on its own. */
  maxDurationSeconds: number;
}

export interface RoomHandle {
  providerRoomRef: string;
  /** Whether the provider considers the room live. */
  status: 'CREATED' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
}

export type MediaParticipant = 'PATIENT' | 'DOCTOR';

export interface JoinTokenInput {
  providerRoomRef: string;
  participant: MediaParticipant;
  /**
   * Display name shown to the other party. For the patient this is a generic
   * label, never their name — the doctor sees identity through the clinical
   * record, not the video tile.
   */
  displayName: string;
  ttlSeconds: number;
}

export interface JoinToken {
  /** Opaque credential the client hands to the provider's SDK. */
  token: string;
  expiresAt: Date;
  /** Where the client should connect, when the provider needs it explicitly. */
  endpoint?: string;
}

export interface VideoProvider {
  readonly name: string;
  /** True for adapters that cannot carry real media. Surfaced in the UI. */
  readonly isMock: boolean;

  createRoom(input: CreateRoomInput): Promise<RoomHandle>;
  issueJoinToken(input: JoinTokenInput): Promise<JoinToken>;
  endRoom(providerRoomRef: string): Promise<void>;
  getRoom(providerRoomRef: string): Promise<RoomHandle | null>;

  // Deliberately no startRecording / enableRecording / recordingRules.
  // See the note at the top of this file.
}

export interface BridgedCallInput {
  consultationPublicId: string;
  /**
   * Both numbers stay server-side. They are passed to the provider to dial and
   * are never returned to either client (spec §33, §60).
   */
  patientPhone: string;
  doctorPhone: string;
  maxDurationSeconds: number;
}

export interface CallHandle {
  providerCallRef: string;
  status: 'QUEUED' | 'RINGING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'NO_ANSWER';
  /**
   * The number the patient's handset displays — the platform's own number,
   * never the doctor's.
   */
  callerIdShown: string;
}

export interface VoiceProvider {
  readonly name: string;
  readonly isMock: boolean;

  /**
   * Dials both parties and bridges them.
   *
   * Neither participant's number is disclosed to the other; the provider is
   * the intermediary (spec §33).
   */
  placeBridgedCall(input: BridgedCallInput): Promise<CallHandle>;
  getCall(providerCallRef: string): Promise<CallHandle | null>;
  endCall(providerCallRef: string): Promise<void>;
}

export class MediaProviderError extends Error {
  constructor(
    message: string,
    readonly providerRef?: string,
  ) {
    super(message);
    this.name = 'MediaProviderError';
  }
}
