import nodemailer, { type Transporter } from 'nodemailer';
import { getEnv } from '../../config/env.ts';
import {
  PermanentDeliveryError,
  type NotificationChannel,
  type NotificationProvider,
  type SendMessageInput,
  type SendMessageResult,
} from './notification.provider.ts';

/**
 * Email over SMTP (spec §58, §91).
 *
 * Deliberately SMTP rather than a specific provider's API: every email service
 * speaks it, so a deployment points at SendGrid, Mailgun, Amazon SES or a
 * local relay by changing configuration rather than by writing another
 * adapter. `mailhog` in development is the same code path as production.
 *
 * The transporter is created once and reused. A new connection per message
 * would be slower and would exhaust a relay's connection limit under any real
 * load.
 */
/**
 * Who a message is actually sent to (v2 plan §9).
 *
 * On staging every message goes to one internal inbox, and the subject says
 * who it was meant for — so a tester can still follow a journey, and a test
 * record carrying somebody's real address never reaches them. The config
 * loader requires the redirect on staging and refuses it in production.
 */
export function addressFor(
  input: Pick<SendMessageInput, 'to' | 'subject'>,
  redirect: string | undefined,
): { to: string; subject: string } {
  const subject = input.subject ?? 'Neem';
  if (!redirect) return { to: input.to, subject };

  return { to: redirect, subject: `[staging → ${input.to}] ${subject}` };
}

export type SmtpTarget = 'smtp' | 'mailhog';

/**
 * Where a message actually goes.
 *
 * `mailhog` means the local catcher and nothing else: its own host and port,
 * no credentials, no TLS. The SMTP_* settings are not read at all in that
 * mode, so a development `.env` that also holds a real mailbox's credentials
 * cannot send through it by accident — which is what the mode's name has
 * always promised and, until this function, did not do.
 */
export function smtpTransportOptions(
  target: SmtpTarget,
  env: Pick<
    ReturnType<typeof getEnv>,
    'SMTP_HOST' | 'SMTP_PORT' | 'SMTP_USER' | 'SMTP_PASSWORD' | 'MAILHOG_HOST' | 'MAILHOG_SMTP_PORT'
  >,
) {
  if (target === 'mailhog') {
    return { host: env.MAILHOG_HOST, port: env.MAILHOG_SMTP_PORT, secure: false };
  }

  return {
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    // Implicit TLS on 465; STARTTLS is negotiated on everything else.
    secure: env.SMTP_PORT === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
  };
}

export class SmtpNotificationProvider implements NotificationProvider {
  readonly name: string;
  readonly channel: NotificationChannel = 'EMAIL';
  readonly isMock = false;

  private transporter: Transporter | undefined;

  constructor(private readonly target: SmtpTarget = 'smtp') {
    this.name = target;
  }

  private transport(): Transporter {
    if (this.transporter) return this.transporter;

    this.transporter = nodemailer.createTransport(smtpTransportOptions(this.target, getEnv()));

    return this.transporter;
  }

  async send(input: SendMessageInput): Promise<SendMessageResult> {
    if (!input.to.includes('@')) {
      throw new PermanentDeliveryError(`Not an email address: ${input.to}`);
    }

    const addressed = addressFor(input, getEnv().STAGING_EMAIL_REDIRECT);

    try {
      const info = await this.transport().sendMail({
        from: getEnv().SMTP_FROM,
        to: addressed.to,
        subject: addressed.subject,
        text: input.body,
        headers: {
          // Ties a bounce back to our own notification row without putting
          // anything about the recipient in the header.
          'X-Neem-Reference': input.reference,
        },
      });

      return { providerRef: info.messageId, status: 'ACCEPTED' };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'SMTP send failed';

      /**
       * A rejected recipient is permanent; a refused connection is not.
       *
       * The retry job needs the difference. SMTP says so in its reply code:
       * 5xx is a permanent failure, 4xx a temporary one, and treating a
       * mistyped address as retryable would have the job trying it every
       * minute for ever.
       */
      const code = (error as { responseCode?: number }).responseCode;
      if (code !== undefined && code >= 500 && code < 600) {
        throw new PermanentDeliveryError(message);
      }

      return { status: 'FAILED', failureReason: message };
    }
  }
}
