import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WherebyVideoProvider } from '../../src/adapters/media/whereby-media.provider.ts';
import { MediaProviderError } from '../../src/adapters/media/media.provider.ts';

/**
 * The Whereby adapter (spec §32, §60, decision D18).
 *
 * Unit tests against a stubbed `fetch`. Whereby's API is not exercised here —
 * that needs a real key and would make the suite depend on a third party being
 * up — so what these assert is everything that is *our* decision: what we ask
 * Whereby for, what we do with the answer, and what we refuse to do at all.
 *
 * The first block is the one that matters most. A consultation must never be
 * recorded, and the strongest statement this codebase can make about that is
 * that the request going over the wire contains no recording instruction.
 */

const ROOM = {
  meetingId: 'mtg_123',
  roomUrl: 'https://neem.whereby.com/neem-abc123',
  hostRoomUrl: 'https://neem.whereby.com/neem-abc123?roomKey=SECRETKEY',
  startDate: '2026-09-06T10:00:00.000Z',
  endDate: '2026-09-06T10:30:00.000Z',
};

let fetchMock: ReturnType<typeof vi.fn>;

function respond(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

/** The parsed body of the nth fetch call. */
function requestBody(call = 0): Record<string, unknown> {
  const init = fetchMock.mock.calls[call]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body ?? '{}'));
}

beforeEach(() => {
  process.env.WHEREBY_API_KEY = 'test-key-not-a-real-one';
  process.env.VIDEO_PROVIDER = 'whereby';

  fetchMock = vi.fn().mockResolvedValue(respond(ROOM));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.WHEREBY_API_KEY;
  delete process.env.VIDEO_PROVIDER;
});

async function createRoom(kind: 'VIDEO' | 'AUDIO' = 'VIDEO') {
  const provider = new WherebyVideoProvider();
  const room = await provider.createRoom({
    consultationPublicId: 'con_public_123',
    kind,
    maxDurationSeconds: 1800,
  });
  return { provider, room };
}

describe('a consultation is never recorded (spec §32)', () => {
  it('sends no recording instruction when creating a room', async () => {
    await createRoom();

    const body = requestBody();

    /**
     * Whereby's `POST /meetings` takes an optional `recording` object. Omitting
     * it is what makes a room unrecorded, so the assertion is about absence —
     * `recording: undefined` would serialise away and pass a truthiness check
     * while a future edit reintroduced it.
     */
    expect(Object.keys(body)).not.toContain('recording');
  });

  it('has no method by which recording could be requested', () => {
    const provider = new WherebyVideoProvider() as unknown as Record<string, unknown>;

    // The capability is absent from `VideoProvider` by design, so a caller
    // cannot ask for it even by mistake. This asserts the adapter did not
    // quietly add one back.
    for (const name of ['startRecording', 'enableRecording', 'record', 'setRecording']) {
      expect(provider[name]).toBeUndefined();
    }
  });
});

describe('what the room is created with', () => {
  it('authenticates with a bearer key and asks for the host URL', async () => {
    await createRoom();

    const [url, init] = fetchMock.mock.calls[0]!;
    const headers = (init as RequestInit).headers as Record<string, string>;

    expect(url).toBe('https://api.whereby.dev/v1/meetings');
    expect(headers.authorization).toBe('Bearer test-key-not-a-real-one');
    expect(requestBody().fields).toEqual(['hostRoomUrl']);
  });

  it('names the room without anything that identifies the consultation', async () => {
    await createRoom();

    const body = requestBody();

    /**
     * The room name appears in a URL a third party controls. Putting Neem's
     * consultation reference there would publish an identifier that could be
     * correlated back to a patient's visit, for no benefit (spec §60).
     */
    expect(body.roomNamePrefix).toBe('neem-');
    expect(JSON.stringify(body)).not.toContain('con_public_123');
  });

  it('sets an end date from the caller, not from a constant', async () => {
    const before = Date.now();
    await createRoom();
    const endDate = new Date(String(requestBody().endDate)).getTime();

    // 1800s was passed in. The room must outlive an overrunning consultation,
    // because the timer never ends one (spec §15).
    expect(endDate).toBeGreaterThanOrEqual(before + 1800 * 1000);
    expect(endDate).toBeLessThan(before + 1800 * 1000 + 5000);
  });

  it('uses the small-room mode, because only two people ever join', async () => {
    await createRoom();
    expect(requestBody().roomMode).toBe('normal');
  });
});

describe('who gets which URL', () => {
  it('gives the doctor the host URL and the patient the plain one', async () => {
    const { provider, room } = await createRoom();

    const doctor = await provider.issueJoinToken({
      providerRoomRef: room.providerRoomRef,
      participant: 'DOCTOR',
      displayName: 'Doctor',
      ttlSeconds: 1800,
    });
    const patient = await provider.issueJoinToken({
      providerRoomRef: room.providerRoomRef,
      participant: 'PATIENT',
      displayName: 'Patient',
      ttlSeconds: 1800,
    });

    expect(doctor.endpoint).toContain('roomKey=SECRETKEY');

    // The room key is host authority — mute, remove, lock. A patient holding
    // it could eject their own doctor.
    expect(patient.endpoint).not.toContain('roomKey');
  });

  it('does not put the room URL in the token field', async () => {
    const { provider, room } = await createRoom();

    const doctor = await provider.issueJoinToken({
      providerRoomRef: room.providerRoomRef,
      participant: 'DOCTOR',
      displayName: 'Doctor',
      ttlSeconds: 1800,
    });

    /**
     * `joinToken` is the field everything treats as an opaque credential, and
     * opaque credentials get logged. The host room key must not travel in it.
     */
    expect(doctor.token).not.toContain('whereby.com');
    expect(doctor.token).not.toContain('SECRETKEY');
  });

  it('carries the generic display name, never a patient name', async () => {
    const { provider, room } = await createRoom();

    const patient = await provider.issueJoinToken({
      providerRoomRef: room.providerRoomRef,
      participant: 'PATIENT',
      displayName: 'Patient',
      ttlSeconds: 1800,
    });

    expect(new URL(patient.endpoint!).searchParams.get('displayName')).toBe('Patient');
  });

  it('starts an audio consultation with the camera off', async () => {
    const { provider, room } = await createRoom('AUDIO');

    const patient = await provider.issueJoinToken({
      providerRoomRef: room.providerRoomRef,
      participant: 'PATIENT',
      displayName: 'Patient',
      ttlSeconds: 1800,
    });

    // The patient chose audio. Starting the camera and expecting them to turn
    // it off is the wrong default in a pharmacy, where other people are close by.
    expect(new URL(patient.endpoint!).searchParams.get('video')).toBe('off');
  });

  it('leaves the camera alone for a video consultation', async () => {
    const { provider, room } = await createRoom('VIDEO');

    const patient = await provider.issueJoinToken({
      providerRoomRef: room.providerRoomRef,
      participant: 'PATIENT',
      displayName: 'Patient',
      ttlSeconds: 1800,
    });

    expect(new URL(patient.endpoint!).searchParams.get('video')).toBeNull();
  });

  it('refuses to issue a credential for a room it does not know', async () => {
    const provider = new WherebyVideoProvider();

    await expect(
      provider.issueJoinToken({
        providerRoomRef: 'mtg_never_created',
        participant: 'DOCTOR',
        displayName: 'Doctor',
        ttlSeconds: 1800,
      }),
    ).rejects.toBeInstanceOf(MediaProviderError);
  });
});

describe('closing the room', () => {
  it('deletes the meeting at Whereby, not just locally', async () => {
    const { provider, room } = await createRoom();

    fetchMock.mockResolvedValueOnce({ ok: true, status: 204, json: async () => undefined });
    await provider.endRoom(room.providerRoomRef);

    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe('https://api.whereby.dev/v1/meetings/mtg_123');
    expect((init as RequestInit).method).toBe('DELETE');
  });

  it('forgets the URLs, so a stale credential cannot be reissued', async () => {
    const { provider, room } = await createRoom();

    fetchMock.mockResolvedValueOnce({ ok: true, status: 204, json: async () => undefined });
    await provider.endRoom(room.providerRoomRef);

    /**
     * A Whereby room URL is a bearer capability that outlives `endDate` by an
     * hour. Once a consultation is complete and its record sealed, nothing
     * should be able to mint a way back into the room.
     */
    await expect(
      provider.issueJoinToken({
        providerRoomRef: room.providerRoomRef,
        participant: 'DOCTOR',
        displayName: 'Doctor',
        ttlSeconds: 1800,
      }),
    ).rejects.toBeInstanceOf(MediaProviderError);
  });

  it('treats an already-deleted room as absent rather than failing', async () => {
    const provider = new WherebyVideoProvider();

    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) });

    // Completion must not fail because the room was already gone.
    await expect(provider.getRoom('mtg_gone')).resolves.toBeNull();
  });
});

describe('when Whereby is unavailable', () => {
  it('reports a timeout as a media error rather than hanging', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    fetchMock.mockRejectedValueOnce(abort);

    const provider = new WherebyVideoProvider();

    await expect(
      provider.createRoom({
        consultationPublicId: 'con_public_123',
        kind: 'VIDEO',
        maxDurationSeconds: 1800,
      }),
    ).rejects.toThrow(/did not respond in time/);
  });

  it('surfaces Whereby’s own message on a rejection', async () => {
    fetchMock.mockResolvedValueOnce(respond({ message: 'Invalid API key' }, 401));

    const provider = new WherebyVideoProvider();

    await expect(
      provider.createRoom({
        consultationPublicId: 'con_public_123',
        kind: 'VIDEO',
        maxDurationSeconds: 1800,
      }),
    ).rejects.toThrow(/Invalid API key/);
  });

  it('fails rather than returning a room with no usable URL', async () => {
    fetchMock.mockResolvedValueOnce(respond({ meetingId: 'mtg_1' }));

    const provider = new WherebyVideoProvider();

    // Half a room is worse than none: the consultation would open onto a pane
    // that can never connect, with the timer running.
    await expect(
      provider.createRoom({
        consultationPublicId: 'con_public_123',
        kind: 'VIDEO',
        maxDurationSeconds: 1800,
      }),
    ).rejects.toThrow(/no usable room/);
  });
});

describe('what this adapter does not claim to be', () => {
  it('is not a mock, and says so', () => {
    const provider = new WherebyVideoProvider();

    // `isMockProvider` drives the "SIMULATED CONNECTION" notice in the UI.
    // Getting this wrong would either hide a real call behind a warning or,
    // far worse, present a simulation as a real consultation (spec §93).
    expect(provider.isMock).toBe(false);
    expect(provider.name).toBe('whereby');
  });
});
