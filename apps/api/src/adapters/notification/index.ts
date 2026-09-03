import { getEnv } from '../../config/env.ts';
import type { NotificationChannel, NotificationProvider } from './notification.provider.ts';
import { MockNotificationProvider } from './mock-notification.provider.ts';
import { SmtpNotificationProvider } from './smtp-notification.provider.ts';
import { TwilioNotificationProvider } from './twilio-notification.provider.ts';

/**
 * Notification provider selection (spec §91).
 *
 * Business logic asks for a channel and never learns which provider it got.
 * Each channel is configured independently, because a deployment may well have
 * real email and no SMS contract yet, and forcing both or neither would mean
 * sending nothing at all.
 */

const providers = new Map<NotificationChannel, NotificationProvider>();

export function getNotificationProvider(channel: NotificationChannel): NotificationProvider {
  const existing = providers.get(channel);
  if (existing) return existing;

  const env = getEnv();
  const mode =
    channel === 'SMS'
      ? env.SMS_PROVIDER
      : channel === 'EMAIL'
        ? env.EMAIL_PROVIDER
        : env.WHATSAPP_PROVIDER;

  let provider: NotificationProvider;

  switch (mode) {
    case 'mock':
    // `mailhog` is a local catcher: real SMTP, delivered nowhere anyone reads
    // by accident. It is a development mode and the config loader refuses it
    // in production, so it is grouped with the mock rather than treated as a
    // delivery channel.
    case 'mailhog':
      provider =
        mode === 'mailhog'
          ? new SmtpNotificationProvider()
          : new MockNotificationProvider(channel);
      break;
    case 'smtp':
      provider = new SmtpNotificationProvider();
      break;
    case 'twilio':
      provider = new TwilioNotificationProvider(channel);
      break;
    default:
      throw new Error(`Unknown provider mode for ${channel}: ${mode}`);
  }

  providers.set(channel, provider);
  return provider;
}

export function setNotificationProviderForTesting(
  channel: NotificationChannel,
  provider: NotificationProvider | undefined,
): void {
  if (provider) providers.set(channel, provider);
  else providers.delete(channel);
}

/** Clears every cached provider. Used between tests. */
export function resetNotificationProviders(): void {
  providers.clear();
}

export * from './notification.provider.ts';
export { MockNotificationProvider } from './mock-notification.provider.ts';
export { SmtpNotificationProvider } from './smtp-notification.provider.ts';
export { TwilioNotificationProvider } from './twilio-notification.provider.ts';
