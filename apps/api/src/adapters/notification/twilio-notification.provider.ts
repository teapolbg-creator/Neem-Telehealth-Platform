import { getEnv } from '../../config/env.ts';
import {
  PermanentDeliveryError,
  type NotificationChannel,
  type NotificationProvider,
  type SendMessageInput,
  type SendMessageResult,
} from './notification.provider.ts';

/**
 * SMS and WhatsApp over Twilio (spec §58, §91).
 *
 * One class serves both, because on Twilio they are the same Messages API
 * with a differently-prefixed sender — a separate WhatsApp adapter would be
 * the same file twice.
 *
 * No SDK. The call is one form POST, and the Paystack adapter established the
 * pattern: a dependency that exists to wrap a single HTTP request is a
 * dependency to keep updated for no benefit.
 */

/**
 * Twilio error codes that will not improve on a retry.
 *
 * The distinction matters to the retry job: an unroutable number does not
 * become routable in a minute, and retrying it forever buries the failures
 * worth reading. Anything not listed is treated as transient, which is the
 * safe direction — a message retried unnecessarily costs a request, whereas
 * one abandoned wrongly is a notification nobody receives.
 */
const PERMANENT_CODES = new Set([
  21211, // invalid 'To' number
  21408, // permission to send to this region is not enabled
  21610, // recipient has unsubscribed
  21614, // 'To' number is not mobile
  63024, // invalid WhatsApp number
]);

export class TwilioNotificationProvider implements NotificationProvider {
  readonly name: string;
  readonly isMock = false;

  constructor(readonly channel: NotificationChannel) {
    if (channel === 'EMAIL') {
      throw new Error('Twilio is not the email provider — use SMTP.');
    }
    this.name = `twilio-${channel.toLowerCase()}`;
  }

  async send(input: SendMessageInput): Promise<SendMessageResult> {
    const env = getEnv();
    const accountSid = env.TWILIO_ACCOUNT_SID ?? '';

    const from =
      this.channel === 'WHATSAPP'
        ? `whatsapp:${env.TWILIO_WHATSAPP_NUMBER ?? ''}`
        : (env.TWILIO_SMS_NUMBER ?? '');
    const to = this.channel === 'WHATSAPP' ? `whatsapp:${input.to}` : input.to;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), env.TWILIO_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
        {
          method: 'POST',
          headers: {
            authorization: `Basic ${Buffer.from(
              `${accountSid}:${env.TWILIO_AUTH_TOKEN ?? ''}`,
            ).toString('base64')}`,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ From: from, To: to, Body: input.body }),
          signal: controller.signal,
        },
      );
    } catch (error) {
      // Unreachable, not undeliverable. Left for the retry job.
      return {
        status: 'FAILED',
        failureReason:
          error instanceof Error && error.name === 'AbortError'
            ? 'Twilio did not respond in time'
            : 'Twilio could not be reached',
      };
    } finally {
      clearTimeout(timeout);
    }

    const body = (await response.json().catch(() => undefined)) as
      | { sid?: string; code?: number; message?: string }
      | undefined;

    if (!response.ok) {
      const message = body?.message ?? `Twilio returned ${response.status}`;

      if (body?.code !== undefined && PERMANENT_CODES.has(body.code)) {
        throw new PermanentDeliveryError(`${message} (Twilio ${body.code})`);
      }
      return { status: 'FAILED', failureReason: message };
    }

    return { providerRef: body?.sid, status: 'ACCEPTED' };
  }
}
