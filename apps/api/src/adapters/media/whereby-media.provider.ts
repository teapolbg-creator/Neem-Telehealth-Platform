import { getEnv } from '../../config/env.ts';
import { addSeconds } from '../../lib/clock.ts';
import {
  MediaProviderError,
  type CreateRoomInput,
  type JoinToken,
  type JoinTokenInput,
  type RoomHandle,
  type VideoProvider,
} from './media.provider.ts';

/**
 * Whereby Embedded (spec §32, decision D18).
 *
 * Replaces the Twilio adapter that was never written. Twilio had announced
 * end-of-life plans for Programmable Video and its status was never confirmed,
 * so Neem shipped on a mock rather than build against a product that might be
 * withdrawn. Whereby is a live, documented product with a published price, and
 * this is the adapter that finally carries real media.
 *
 * Four things about it are worth understanding before changing anything here.
 *
 * **1. It is URL-based, not token-based.** Twilio hands a client an access
 * token for its SDK; Whereby hands out a room URL, and the credential *is* the
 * URL. So `issueJoinToken` returns the URL in `endpoint` — the field
 * `JoinToken` already carries "when the provider needs it explicitly" — and a
 * `token` that is deliberately not a credential. The two participants get
 * different URLs: the patient gets `roomUrl`, the doctor gets `hostRoomUrl`,
 * which carries a `roomKey` granting host controls.
 *
 * **2. The host URL is a secret.** `hostRoomUrl` embeds a room key. It is
 * never logged here, never audited, and never returned to a patient. The
 * error paths below quote status codes and Whereby's message, never a URL.
 *
 * **3. No recording is ever requested.** `POST /meetings` accepts an optional
 * `recording` object. This adapter never sends one, and `VideoProvider` has no
 * method that could ask for it — the capability is absent from the contract
 * rather than defaulted to off (see the note at the top of `media.provider`).
 * `whereby-adapter.test.ts` asserts the request body has no `recording` key.
 *
 * That guarantee covers everything Neem's code does, and stops at Whereby's
 * account boundary: recording can also be enabled from the Whereby dashboard,
 * which no code here can see. That is an operational control, recorded in
 * `docs/security.md` — weaker than an architectural one, and stated plainly
 * rather than papered over.
 *
 * **4. It cannot place a telephone call.** Whereby is browser-to-browser and
 * publishes no PSTN capability, so there is no `WherebyVoiceProvider` in this
 * file. Call Me still has no implementation; `VOICE_PROVIDER=whereby` is
 * refused in `index.ts` rather than quietly falling back to something that
 * cannot dial a handset.
 */

const BASE_URL = 'https://api.whereby.dev/v1';

interface WherebyMeeting {
  meetingId: string;
  roomUrl: string;
  hostRoomUrl?: string;
  startDate?: string;
  endDate?: string;
}

/**
 * What `createRoom` needs to remember between the two calls.
 *
 * Whereby's `GET /meetings/{id}` returns the meeting, not the participant
 * URLs, so the URLs from creation are held here for the join that follows.
 * In-process and deliberately so: a restart loses them, and the caller then
 * gets a clear failure rather than a silently broken room. Sessions are
 * minutes long and the room reference is persisted in `media_sessions`, so the
 * blast radius is one consultation whose participants rejoin.
 */
interface RoomUrls {
  roomUrl: string;
  hostRoomUrl: string;
  expiresAt: Date;
  /**
   * Whether the patient asked for video or audio.
   *
   * Kept here because it is known at creation and needed at join, and
   * `JoinTokenInput` does not carry it — a token-based provider has no use
   * for it. Widening the shared interface to suit one adapter would push a
   * Whereby detail into the mock and into Twilio if it is ever written.
   */
  kind: CreateRoomInput['kind'];
}

export class WherebyVideoProvider implements VideoProvider {
  readonly name = 'whereby';
  readonly isMock = false;

  private readonly urls = new Map<string, RoomUrls>();

  /**
   * Every Whereby call, in one place.
   *
   * Times out rather than hanging. A consultation whose room cannot be created
   * must fail visibly — the doctor and patient are both waiting, and a request
   * that never returns leaves them looking at a spinner while the five-minute
   * timer runs.
   */
  private async call<T>(
    path: string,
    init: { method: 'POST' | 'GET' | 'DELETE'; body?: unknown },
  ): Promise<T | null> {
    const env = getEnv();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), env.WHEREBY_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${BASE_URL}${path}`, {
        method: init.method,
        headers: {
          authorization: `Bearer ${env.WHEREBY_API_KEY}`,
          'content-type': 'application/json',
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      });
    } catch (error) {
      throw new MediaProviderError(
        error instanceof Error && error.name === 'AbortError'
          ? 'The video provider did not respond in time.'
          : 'The video provider could not be reached.',
      );
    } finally {
      clearTimeout(timeout);
    }

    // A deleted or expired meeting. Reported as absence, not failure — the
    // caller decides whether that matters.
    if (response.status === 404) return null;

    // DELETE answers 204 with no body.
    if (response.status === 204) return null;

    const body = (await response.json().catch(() => undefined)) as
      (T & { error?: string; message?: string }) | undefined;

    if (!response.ok) {
      throw new MediaProviderError(
        // Whereby's own words where it gives them. Never the request body: it
        // would put the host room key in a log line.
        body?.message ?? body?.error ?? `Whereby returned ${response.status} for ${path}`,
      );
    }
    if (body === undefined) {
      throw new MediaProviderError(`Whereby returned no body for ${path}`);
    }

    return body;
  }

  async createRoom(input: CreateRoomInput): Promise<RoomHandle> {
    const expiresAt = addSeconds(new Date(), input.maxDurationSeconds);

    const meeting = await this.call<WherebyMeeting>('/meetings', {
      method: 'POST',
      body: {
        /**
         * Required by Whereby. Note that it does **not** evict anyone: the
         * room stays usable until an hour after this, then is deleted within
         * 24 hours. So it is a backstop, not the mechanism — `endRoom` is
         * what actually closes the room at completion.
         *
         * The caller passes six times the consultation length precisely
         * because the timer must never end a consultation (spec §15).
         */
        endDate: expiresAt.toISOString(),

        /**
         * Two participants — the patient and the doctor. The pharmacy does not
         * join. `normal` mode is built for small rooms; `group` is for four or
         * more and lays out a grid nobody here needs.
         */
        roomMode: 'normal',

        /**
         * A neutral prefix, carrying nothing about the consultation.
         *
         * Whereby generates the rest of the room name, so the URL cannot be
         * correlated back to a Neem consultation by anyone who sees it —
         * including Whereby. Putting the consultation reference here would
         * publish an identifier into a third party's URL space for no benefit
         * (spec §60).
         */
        roomNamePrefix: 'neem-',

        // Ask for the host URL; without this the response carries only the
        // participant URL and the doctor gets no host controls.
        fields: ['hostRoomUrl'],

        // No `recording` key. See the note at the top of this file.
      },
    });

    if (!meeting?.meetingId || !meeting.roomUrl) {
      throw new MediaProviderError('Whereby created no usable room.');
    }

    this.urls.set(meeting.meetingId, {
      roomUrl: meeting.roomUrl,
      // A room created without `fields` would have no host URL. Falling back
      // to the participant URL keeps the consultation working, minus the
      // doctor's host controls, rather than failing it outright.
      hostRoomUrl: meeting.hostRoomUrl ?? meeting.roomUrl,
      expiresAt,
      kind: input.kind,
    });

    return { providerRoomRef: meeting.meetingId, status: 'CREATED' };
  }

  async issueJoinToken(input: JoinTokenInput): Promise<JoinToken> {
    const room = this.urls.get(input.providerRoomRef);
    if (!room) {
      throw new MediaProviderError(
        'This room is no longer available on this server. Rejoining will create a fresh one.',
        input.providerRoomRef,
      );
    }

    const base = input.participant === 'DOCTOR' ? room.hostRoomUrl : room.roomUrl;

    return {
      /**
       * Not a credential, and named so it cannot be mistaken for one.
       *
       * Whereby's credential is the URL below. Returning the URL here as well
       * would put a host room key into every field that logs a "token".
       */
      token: `whereby_url_in_endpoint_${input.participant.toLowerCase()}`,
      endpoint: withDisplayOptions(base, input.displayName, room.kind),
      // The room, not the URL, is what expires.
      expiresAt: room.expiresAt,
    };
  }

  async endRoom(providerRoomRef: string): Promise<void> {
    /**
     * Deleting matters more than it looks.
     *
     * A Whereby room URL is a bearer credential: whoever holds it can join.
     * Left alone the room stays reachable for an hour past `endDate`, so a URL
     * copied during a consultation would still open a room after the clinical
     * record had been sealed. Deleting at completion closes that window.
     */
    await this.call(`/meetings/${encodeURIComponent(providerRoomRef)}`, { method: 'DELETE' });
    this.urls.delete(providerRoomRef);
  }

  async getRoom(providerRoomRef: string): Promise<RoomHandle | null> {
    const meeting = await this.call<WherebyMeeting>(
      `/meetings/${encodeURIComponent(providerRoomRef)}`,
      { method: 'GET' },
    );
    if (!meeting) return null;

    return { providerRoomRef, status: 'IN_PROGRESS' };
  }
}

/**
 * The query parameters the room URL is opened with.
 *
 * `video=off` is what makes an audio consultation an audio consultation: the
 * patient chose audio, and the camera must start off rather than be something
 * they have to remember to switch off. `displayName` spares both parties a
 * name prompt — and carries the generic label the caller supplies, never the
 * patient's name (spec §60).
 */
function withDisplayOptions(
  roomUrl: string,
  displayName: string,
  kind: CreateRoomInput['kind'],
): string {
  const url = new URL(roomUrl);

  url.searchParams.set('displayName', displayName);
  // Neem draws its own consultation chrome around the embed; Whereby's own
  // header would be a second, contradictory set of controls.
  url.searchParams.set('minimal', 'on');
  url.searchParams.set('leaveButton', 'off');

  if (kind === 'AUDIO') {
    url.searchParams.set('video', 'off');
  }

  return url.toString();
}
