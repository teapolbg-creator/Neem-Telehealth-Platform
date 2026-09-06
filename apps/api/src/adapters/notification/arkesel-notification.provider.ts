import { getEnv } from '../../config/env.ts';
import {
  PermanentDeliveryError,
  type NotificationChannel,
  type NotificationProvider,
  type SendMessageInput,
  type SendMessageResult,
} from './notification.provider.ts';
import { toGhanaMsisdn } from './ghana-msisdn.ts';

/**
 * Arkesel SMS (spec §57, §58, decision D39).
 *
 * Replaces Hubtel as the configured SMS provider. Both adapters work and both
 * remain selectable; this is the one the pilot uses.
 *
 * A patient's consultation reference reaches them by SMS and it is their only
 * route back to their own record (D24). Neem keeps no patient profile, so a
 * message that does not arrive leaves the patient with no way at all to find
 * what happened to them — which is why this adapter refuses to report a send
 * it cannot evidence.
 *
 * **The contract.** `POST https://sms.arkesel.com/api/v2/sms/send`, the key in
 * an `api-key` header, and a JSON body of `sender`, `message` and a
 * `recipients` array. A success is `{"status":"success","data":{"id":…}}`.
 *
 * **Arkesel distinguishes its failures, so this adapter does too.** 401 (bad
 * key), 403 (sender ID not registered) and 422 (malformed number or empty
 * message) will not improve by being retried, and are raised as permanent.
 * 429 and 5xx are transient and left to the retry job. Getting that boundary
 * wrong in either direction is expensive: retrying a permanent failure buries
 * the queue, and giving up on a transient one loses a patient's reference.
 */

const BASE_URL = 'https://sms.arkesel.com/api/v2/sms/send';

interface ArkeselResponse {
  status?: string;
  message?: string;
  data?: { id?: string; credits_used?: number } | Array<{ id?: string }>;
}

/** The message id, wherever Arkesel put it. */
function messageIdOf(body: ArkeselResponse | undefined): string | undefined {
  if (!body?.data) return undefined;

  // A single send has answered with both an object and a single-element array
  // across versions of their API. Both are read rather than assumed.
  if (Array.isArray(body.data)) return body.data[0]?.id;
  return body.data.id;
}

export class ArkeselNotificationProvider implements NotificationProvider {
  readonly name = 'arkesel';
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

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), env.ARKESEL_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(BASE_URL, {
        method: 'POST',
        headers: {
          // Arkesel's own header name. Not `authorization`.
          'api-key': env.ARKESEL_API_KEY!,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          sender: env.ARKESEL_SENDER_ID,
          message: input.body,
          recipients: [to],
        }),
        signal: controller.signal,
      });
    } catch (error) {
      return {
        status: 'FAILED',
        failureReason:
          error instanceof Error && error.name === 'AbortError'
            ? 'Arkesel did not respond in time.'
            : 'Arkesel could not be reached.',
      };
    } finally {
      clearTimeout(timeout);
    }

    const body = (await response.json().catch(() => undefined)) as ArkeselResponse | undefined;
    const detail = body?.message ? `: ${body.message}` : '';

    /**
     * The failures that configuration causes, not weather.
     *
     * 403 is called out separately because it is overwhelmingly the sender ID:
     * Ghana's networks block unregistered alphanumeric senders, and an operator
     * reading "permission denied" would otherwise go looking at the API key.
     */
    if (response.status === 403) {
      throw new PermanentDeliveryError(
        `Arkesel refused the sender (HTTP 403)${detail}. ARKESEL_SENDER_ID is almost ` +
          'certainly not registered with the networks, or the account has no credit.',
      );
    }
    if (response.status === 401) {
      throw new PermanentDeliveryError(
        `Arkesel rejected the API key (HTTP 401)${detail}. Check ARKESEL_API_KEY.`,
      );
    }
    if (response.status === 400 || response.status === 422) {
      // A malformed request or an unusable number. Retrying sends the same
      // thing again, forever.
      throw new PermanentDeliveryError(
        `Arkesel refused the message (HTTP ${response.status})${detail}.`,
      );
    }

    if (!response.ok) {
      // 429 and 5xx. The retry job exists for exactly these.
      return {
        status: 'FAILED',
        failureReason: `Arkesel returned ${response.status}${detail}`,
      };
    }

    /**
     * A 200 is not on its own a send.
     *
     * Arkesel answers 200 with `status: "success"` and an id. Anything else at
     * 200 — a different status, or no id — is recorded FAILED rather than SENT.
     * Recording it as sent would put a lie in the notification log, and a
     * patient whose reference never arrived would be indistinguishable from one
     * who received it.
     */
    const providerRef = messageIdOf(body);
    const reportedSuccess = (body?.status ?? '').toLowerCase() === 'success';

    if (!reportedSuccess || !providerRef) {
      return {
        status: 'FAILED',
        failureReason:
          `Arkesel answered ${response.status} with status="${body?.status ?? 'none'}"` +
          `${providerRef ? '' : ' and no message id'}${detail}. Treated as not sent.`,
      };
    }

    return { providerRef, status: 'ACCEPTED' };
  }
}
