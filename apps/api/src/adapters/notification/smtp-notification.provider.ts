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
export class SmtpNotificationProvider implements NotificationProvider {
  readonly name = 'smtp';
  readonly channel: NotificationChannel = 'EMAIL';
  readonly isMock = false;

  private transporter: Transporter | undefined;

  private transport(): Transporter {
    if (this.transporter) return this.transporter;

    const env = getEnv();

    this.transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      // Implicit TLS on 465; STARTTLS is negotiated on everything else.
      secure: env.SMTP_PORT === 465,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
    });

    return this.transporter;
  }

  async send(input: SendMessageInput): Promise<SendMessageResult> {
    if (!input.to.includes('@')) {
      throw new PermanentDeliveryError(`Not an email address: ${input.to}`);
    }

    try {
      const info = await this.transport().sendMail({
        from: getEnv().SMTP_FROM,
        to: input.to,
        subject: input.subject ?? 'Neem',
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
