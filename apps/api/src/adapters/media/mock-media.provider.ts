import { randomBytes } from 'node:crypto';
import { addSeconds } from '../../lib/clock.ts';
import type {
  BridgedCallInput,
  CallHandle,
  CreateRoomInput,
  JoinToken,
  JoinTokenInput,
  RoomHandle,
  VideoProvider,
  VoiceProvider,
} from './media.provider.ts';

/**
 * Development video and voice adapters (decision D18).
 *
 * These implement the **session lifecycle** faithfully — rooms are created,
 * join credentials are issued and expire, rooms end, calls transition through
 * ringing to completed — so every code path around media is genuinely
 * exercised.
 *
 * What they do NOT do is carry media. Two people cannot see or hear each
 * other, and no telephone rings. `isMock` is true, the UI says so on the
 * screen where a remote participant would appear, and the config loader
 * refuses to boot production with a mock selected.
 *
 * The client pairs this with the browser's real camera and microphone for the
 * local preview, so permission prompts, device selection and the mute and
 * camera controls are exercised against real hardware rather than drawn.
 */

interface MockRoom {
  consultationPublicId: string;
  status: RoomHandle['status'];
  createdAt: Date;
  expiresAt: Date;
}

export class MockVideoProvider implements VideoProvider {
  readonly name = 'mock';
  readonly isMock = true;

  private readonly rooms = new Map<string, MockRoom>();

  async createRoom(input: CreateRoomInput): Promise<RoomHandle> {
    const providerRoomRef = `mockroom_${randomBytes(10).toString('hex')}`;
    const now = new Date();

    this.rooms.set(providerRoomRef, {
      consultationPublicId: input.consultationPublicId,
      status: 'CREATED',
      createdAt: now,
      expiresAt: addSeconds(now, input.maxDurationSeconds),
    });

    return { providerRoomRef, status: 'CREATED' };
  }

  async issueJoinToken(input: JoinTokenInput): Promise<JoinToken> {
    const room = this.rooms.get(input.providerRoomRef);
    if (!room) {
      // Matching production behaviour matters most in the failure cases.
      throw new Error(`Unknown room: ${input.providerRoomRef}`);
    }

    room.status = 'IN_PROGRESS';

    return {
      // Deliberately not a JWT and not usable by any SDK: nothing should be
      // able to mistake this for a credential that carries media.
      token: `mocktoken_${input.participant.toLowerCase()}_${randomBytes(12).toString('hex')}`,
      expiresAt: addSeconds(new Date(), input.ttlSeconds),
    };
  }

  async endRoom(providerRoomRef: string): Promise<void> {
    const room = this.rooms.get(providerRoomRef);
    if (room) room.status = 'COMPLETED';
  }

  async getRoom(providerRoomRef: string): Promise<RoomHandle | null> {
    const room = this.rooms.get(providerRoomRef);
    if (!room) return null;

    return { providerRoomRef, status: room.status };
  }
}

interface MockCall {
  consultationPublicId: string;
  status: CallHandle['status'];
  startedAt: Date;
}

export class MockVoiceProvider implements VoiceProvider {
  readonly name = 'mock';
  readonly isMock = true;

  private readonly calls = new Map<string, MockCall>();

  async placeBridgedCall(input: BridgedCallInput): Promise<CallHandle> {
    const providerCallRef = `mockcall_${randomBytes(10).toString('hex')}`;

    this.calls.set(providerCallRef, {
      consultationPublicId: input.consultationPublicId,
      status: 'RINGING',
      startedAt: new Date(),
    });

    // Neither number is echoed back. Even in a mock, returning them would
    // establish a shape that leaks them in production (spec §33).
    return {
      providerCallRef,
      status: 'RINGING',
      callerIdShown: 'Neem',
    };
  }

  async getCall(providerCallRef: string): Promise<CallHandle | null> {
    const call = this.calls.get(providerCallRef);
    if (!call) return null;

    return { providerCallRef, status: call.status, callerIdShown: 'Neem' };
  }

  async endCall(providerCallRef: string): Promise<void> {
    const call = this.calls.get(providerCallRef);
    if (call) call.status = 'COMPLETED';
  }

  /**
   * Development-only: advances a simulated call.
   *
   * Not part of `VoiceProvider` — no business logic may call it, and the real
   * adapter has no equivalent.
   */
  simulateAnswer(providerCallRef: string): boolean {
    const call = this.calls.get(providerCallRef);
    if (!call) return false;

    call.status = 'IN_PROGRESS';
    return true;
  }
}
