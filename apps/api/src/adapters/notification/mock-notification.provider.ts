import { randomBytes } from 'node:crypto';
import { getLogger } from '../../lib/logger.ts';
import {
  PermanentDeliveryError,
  type NotificationChannel,
  type NotificationProvider,
  type SendMessageInput,
  type SendMessageResult,
} from './notification.provider.ts';

/**
 * Development notification adapters.
 *
 * These are simulators, not pretences. Nothing is delivered, and that fact is
 * visible everywhere it matters: `isMock` is true, the config loader refuses
 * to boot production with one selected, and every message is logged so a
 * developer can read what would have been sent (spec §77, §93).
 *
 * They still enforce the checks a real provider would. An SMS to a malformed
 * number fails here exactly as it would at a real gateway, so the failure path is
 * exercised in development rather than discovered in production.
 */
export class MockNotificationProvider implements NotificationProvider {
  readonly isMock = true;
  readonly name: string;

  /** Every message this process has "sent". Read by tests; cleared on restart. */
  private readonly outbox: Array<SendMessageInput & { at: Date }> = [];

  constructor(readonly channel: NotificationChannel) {
    this.name = `mock-${channel.toLowerCase()}`;
  }

  async send(input: SendMessageInput): Promise<SendMessageResult> {
    /**
     * Validated as a real provider would.
     *
     * A permanent failure is distinguished from a transient one here, because
     * the retry job needs the difference: an unroutable address will not
     * become routable, and retrying it forever hides the failures worth
     * reading.
     */
    if (!input.to.trim()) {
      throw new PermanentDeliveryError('No destination address');
    }
    if (this.channel === 'EMAIL' && !input.to.includes('@')) {
      throw new PermanentDeliveryError(`Not an email address: ${input.to}`);
    }
    if (this.channel !== 'EMAIL' && !/^\+?[0-9]{7,15}$/.test(input.to.replace(/[\s-]/g, ''))) {
      throw new PermanentDeliveryError(`Not a usable phone number: ${input.to}`);
    }

    this.outbox.push({ ...input, at: new Date() });

    /**
     * Logged in full, deliberately.
     *
     * Notification bodies are not stored — the `notifications` table keeps a
     * hash so history cannot become a shadow copy of personal data (spec §60)
     * — so a development log is the only way to see what a template produced.
     * This adapter never runs in production, where the same line would be a
     * disclosure.
     */
    getLogger().info(
      { channel: this.channel, to: input.to, subject: input.subject, body: input.body },
      'mock notification — nothing was actually sent',
    );

    return { providerRef: `mock_${randomBytes(8).toString('hex')}`, status: 'ACCEPTED' };
  }

  /** Test helper: what this adapter was asked to send. */
  sent(): ReadonlyArray<SendMessageInput & { at: Date }> {
    return this.outbox;
  }

  clear(): void {
    this.outbox.length = 0;
  }
}
