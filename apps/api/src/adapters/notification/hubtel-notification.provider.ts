import { getEnv } from '../../config/env.ts';
import {
  PermanentDeliveryError,
  type NotificationChannel,
  type NotificationProvider,
  type SendMessageInput,
  type SendMessageResult,
} from './notification.provider.ts';

/**
 * Hubtel SMS (spec §57, §58, decision D37).
 *
 * The first real notification provider Neem has had. It matters more than a
 * notification provider usually would: a patient's consultation reference
 * reaches them by SMS, and it is their only route back to their own record
 * (D24). Neem keeps no patient profile, so a message that does not arrive is
 * not an inconvenience — the patient has no other way to find what happened
 * to them.
 *
 * **Ghana-specific things that shaped this adapter.**
 *
 * Hubtel is a Ghanaian provider, so the numbers it is given are Ghanaian and
 * the normalisation below is Ghana's: a local `0244…` becomes `233244…`. A
 * number that cannot be made sense of is a `PermanentDeliveryError` rather
 * than a retry, because a malformed number does not become valid by waiting.
 *
 * The sender ID is an alphanumeric name — "Neem" — not a phone number. Ghana's
 * networks require registered alphanumeric sender IDs and reject numeric
 * international senders outright, so `HUBTEL_SENDER_ID` is required at boot
 * rather than defaulted to something that would be silently dropped.
 *
 * **What is verified here and what is not.** The endpoint, the Basic-auth
 * scheme and the `From`/`To`/`Content` fields are from Hubtel's documented API
 * and their own SDK. Their per-message status codes are **not** verified —
 * their documentation host was unreachable while this was written — so this
 * adapter does not branch on a code it has guessed. It treats a 2xx carrying a
 * message id as accepted, reads any status Hubtel does return into the failure
 * reason, and leaves the mapping to be tightened once a real send has been
 * observed. `npm run hubtel:check` is what observes it.
 */

const BASE_URL = 'https://smsc.hubtel.com/v1/messages/send';

interface HubtelResponse {
  /** Hubtel's own handle for the message, where it gives one. */
  MessageId?: string;
  messageId?: string;
  /** Numeric or string, depending on which Hubtel surface answered. */
  Status?: number | string;
  status?: number | string;
  Message?: string;
  message?: string;
  Rate?: number;
}

/**
 * A Ghanaian mobile number in the form Hubtel expects.
 *
 * Returns null when the input cannot be made into one, which the caller turns
 * into a permanent failure. Deliberately strict: guessing at a number that is
 * nearly right risks sending a patient's consultation reference to a stranger.
 */
export function toGhanaMsisdn(raw: string): string | null {
  const digits = raw.replace(/[\s()+-]/g, '');
  if (!/^\d+$/.test(digits)) return null;

  // 0244123456 — the way a number is written and spoken in Ghana.
  if (/^0\d{9}$/.test(digits)) return `233${digits.slice(1)}`;

  // 233244123456 — already international.
  if (/^233\d{9}$/.test(digits)) return digits;

  /**
   * 244123456 — no trunk zero, as some systems store it.
   *
   * The leading digit must not be zero, and that is not a tidiness rule. A
   * plain `\d{9}` also matches `024412345` — a local number one digit short —
   * and would turn it into `233024412345`: a number that is not the patient's,
   * may well be somebody's, and would receive their consultation reference.
   * Caught by a test rather than by review.
   */
  if (/^[1-9]\d{8}$/.test(digits)) return `233${digits}`;

  return null;
}

export class HubtelNotificationProvider implements NotificationProvider {
  readonly name = 'hubtel';
  readonly channel: NotificationChannel = 'SMS';
  readonly isMock = false;

  async send(input: SendMessageInput): Promise<SendMessageResult> {
    const env = getEnv();

    if (!input.to?.trim()) {
      throw new PermanentDeliveryError('No destination number');
    }

    const to = toGhanaMsisdn(input.to);
    if (!to) {
      throw new PermanentDeliveryError(`Not a usable Ghanaian number: ${input.to}`);
    }

    /**
     * Basic auth over the client id and secret.
     *
     * Hubtel also accepts them as query parameters, which is how most of their
     * examples read. Not here: a query string ends up in access logs, proxy
     * logs and error reports, and these are account credentials.
     */
    const authorization = `Basic ${Buffer.from(
      `${env.HUBTEL_CLIENT_ID}:${env.HUBTEL_CLIENT_SECRET}`,
    ).toString('base64')}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), env.HUBTEL_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(BASE_URL, {
        method: 'POST',
        headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify({
          From: env.HUBTEL_SENDER_ID,
          To: to,
          Content: input.body,
          /**
           * Ask for a delivery report.
           *
           * Nothing consumes one yet — there is no Hubtel callback route, and
           * `notifications` records SENT meaning "the gateway accepted it".
           * Requesting the report anyway costs nothing and means the data
           * exists on Hubtel's side when someone asks why a patient never got
           * their reference.
           */
          RegisteredDelivery: true,
          // Our notification id, so a report can be tied back to a row.
          ClientReference: input.reference,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      // Transient by assumption: the retry job will try again. A network
      // failure is exactly the case retrying exists for.
      return {
        status: 'FAILED',
        failureReason:
          error instanceof Error && error.name === 'AbortError'
            ? 'Hubtel did not respond in time.'
            : 'Hubtel could not be reached.',
      };
    } finally {
      clearTimeout(timeout);
    }

    const body = (await response.json().catch(() => undefined)) as HubtelResponse | undefined;
    const providerRef = body?.MessageId ?? body?.messageId;
    const hubtelStatus = body?.Status ?? body?.status;
    const hubtelMessage = body?.Message ?? body?.message;

    /**
     * 401 and 403 will not improve by being retried.
     *
     * Wrong credentials, or a sender ID that has not been registered with the
     * networks, are both configuration. Retrying either every minute until the
     * queue is full buries the failures worth looking at.
     */
    if (response.status === 401 || response.status === 403) {
      throw new PermanentDeliveryError(
        `Hubtel rejected the credentials or sender ID (HTTP ${response.status})` +
          `${hubtelMessage ? `: ${hubtelMessage}` : ''}. Check HUBTEL_CLIENT_ID, ` +
          'HUBTEL_CLIENT_SECRET, and that HUBTEL_SENDER_ID is registered with the networks.',
      );
    }

    if (!response.ok) {
      return {
        status: 'FAILED',
        failureReason:
          `Hubtel returned ${response.status}` +
          `${hubtelStatus !== undefined ? ` (status ${hubtelStatus})` : ''}` +
          `${hubtelMessage ? `: ${hubtelMessage}` : ''}`,
      };
    }

    /**
     * Accepted, not delivered — and the distinction is the contract's.
     *
     * A message id is the evidence Hubtel took it. Without one, a 200 is not
     * treated as success: an empty body from a gateway is not a send, and
     * reporting SENT for it would put a lie in the notification log.
     */
    if (!providerRef) {
      return {
        status: 'FAILED',
        failureReason:
          `Hubtel answered ${response.status} with no message id` +
          `${hubtelMessage ? `: ${hubtelMessage}` : ''}. Treated as not sent.`,
      };
    }

    return { providerRef, status: 'ACCEPTED' };
  }
}
