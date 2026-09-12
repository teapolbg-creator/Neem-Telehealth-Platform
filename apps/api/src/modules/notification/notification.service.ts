import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { getPrisma, type Db } from '../../db/prisma.ts';
import { getEnv } from '../../config/env.ts';
import { getLogger } from '../../lib/logger.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
import { decryptNullable } from '../../lib/crypto.ts';
import {
  getNotificationProvider,
  PermanentDeliveryError,
  type NotificationChannel as ProviderChannel,
} from '../../adapters/notification/index.ts';
import { emitToAdmins, emitToDoctor, emitToPharmacy } from '../realtime/realtime.service.ts';
import { NOTIFICATION_TEMPLATES, type TemplateChannel } from './templates.ts';
import { getBooleanSetting } from '../settings/settings.service.ts';
import { SETTING_KEYS } from '../settings/settings.defaults.ts';

/**
 * Notification dispatch (spec §58, §60).
 *
 * Three properties hold throughout, and each is structural rather than a
 * convention someone has to remember:
 *
 *  1. **No clinical content leaves here.** A template may only interpolate the
 *     variables it declares, and `render` throws on any it was not given. The
 *     catalogue is where that list is reviewed.
 *
 *  2. **The rendered body is never stored.** `notifications` keeps a hash, so
 *     the notification log cannot become a second copy of personal data
 *     (docs/database.md, spec §60). This is why there is no in-app message
 *     archive: see decision D32.
 *
 *  3. **A failure to notify never fails the thing that triggered it.** A
 *     prescription is issued whether or not the SMS goes out. Every dispatch
 *     is caught, recorded and left for the retry job — an unreachable SMS
 *     gateway must not roll back a consultation.
 */

export type Recipient =
  | { type: 'DOCTOR'; doctorId: string }
  | { type: 'PHARMACY'; pharmacyId: string }
  | { type: 'PATIENT'; consultationId: string }
  | { type: 'ADMIN' };

export interface NotifyInput {
  templateCode: string;
  recipient: Recipient;
  variables?: Record<string, string | number>;
  /** Overrides the template's channels. Used by the retry job for one channel. */
  channels?: TemplateChannel[];
  correlationId?: string;
}

/**
 * Fills a template.
 *
 * Refuses an unknown placeholder rather than leaving it in the text or
 * silently blanking it. A message that reaches a patient reading
 * "Your reference is {{consultationReference}}" is worse than one that was
 * never sent, because it looks like the system working.
 */
export function render(body: string, variables: Record<string, string | number>): string {
  return body.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, name: string) => {
    const value = variables[name];
    if (value === undefined) {
      throw new Error(`Notification template used {{${name}}}, which was not supplied.`);
    }
    return String(value);
  });
}

function hashPayload(subject: string | undefined, body: string): string {
  return createHash('sha256')
    .update(`${subject ?? ''}\n${body}`)
    .digest('hex');
}

/** Which channels a provider actually sends; the rest are delivered in-app. */
const PROVIDER_CHANNELS = new Set<TemplateChannel>(['SMS', 'EMAIL', 'WHATSAPP']);

/**
 * Where a message physically goes.
 *
 * Resolved here, once, and handed to the adapter — an adapter never looks a
 * recipient up, so it cannot reach a contact detail nobody meant it to have.
 * Returns null when the channel has no address for this recipient, which is
 * ordinary rather than an error: a pharmacy with no mobile number simply is
 * not sent an SMS.
 */
async function addressFor(
  recipient: Recipient,
  channel: TemplateChannel,
  db: Db,
): Promise<string | null> {
  if (!PROVIDER_CHANNELS.has(channel)) return null;

  switch (recipient.type) {
    case 'DOCTOR': {
      const doctor = await db.doctor.findUnique({
        where: { id: recipient.doctorId },
        select: { phoneEnc: true, user: { select: { email: true } } },
      });
      if (!doctor) return null;
      // The doctor's number is encrypted at rest and never returned to a
      // patient or a pharmacy. Decrypted here and handed straight to the
      // adapter; it is never written to the notification row.
      return channel === 'EMAIL' ? doctor.user.email : decryptNullable(doctor.phoneEnc);
    }
    case 'PHARMACY': {
      const pharmacy = await db.pharmacy.findUnique({
        where: { id: recipient.pharmacyId },
        select: { phone: true, email: true },
      });
      if (!pharmacy) return null;
      return channel === 'EMAIL' ? pharmacy.email : pharmacy.phone;
    }
    case 'PATIENT': {
      /**
       * The patient's number, encrypted at rest.
       *
       * Read after completion on purpose: the message that carries their
       * consultation reference (D24) is sent at exactly that moment, and the
       * session row survives sealing — it is destroyed with the rest of the
       * record when the retention period ends, not when the consultation does.
       *
       * It is decrypted here, handed straight to the adapter, and never
       * written to the notification row, which stores only a hash. Once the
       * record is destroyed this resolves to null and the notification is
       * recorded as suppressed rather than failing.
       */
      const session = await db.patientSession.findUnique({
        where: { consultationId: recipient.consultationId },
        select: { phoneEnc: true },
      });
      return channel === 'EMAIL' ? null : decryptNullable(session?.phoneEnc ?? null);
    }
    case 'ADMIN':
      // Admins are notified in-app and by the operations mailbox, not
      // individually — there is no per-admin contact list to leak.
      return channel === 'EMAIL' ? (process.env.NEEM_OPS_EMAIL ?? null) : null;
  }
}

function recipientRef(recipient: Recipient): string {
  switch (recipient.type) {
    case 'DOCTOR':
      return recipient.doctorId;
    case 'PHARMACY':
      return recipient.pharmacyId;
    case 'PATIENT':
      return recipient.consultationId;
    case 'ADMIN':
      return 'admin';
  }
}

/** Real-time delivery for the channels that have no provider. */
function emitInApp(
  recipient: Recipient,
  templateCode: string,
  subject: string | undefined,
  body: string,
): void {
  const payload = { templateCode, subject, body, at: new Date().toISOString() };

  switch (recipient.type) {
    case 'DOCTOR':
      emitToDoctor(recipient.doctorId, 'notification', payload);
      break;
    case 'PHARMACY':
      emitToPharmacy(recipient.pharmacyId, 'notification', payload);
      break;
    case 'ADMIN':
      emitToAdmins('notification', payload);
      break;
    case 'PATIENT':
      // The patient's screen polls its own session and has no socket room of
      // its own; there is nothing to emit to.
      break;
  }
}

export interface NotifyResult {
  sent: number;
  failed: number;
  suppressed: number;
}

/**
 * The channels a notification actually goes out on, once the pilot's switches
 * are applied.
 *
 * SMS is off for the pilot MVP (`notifications.smsEnabled`, decision D46) and
 * this is the whole of how it is off: the provider, the adapter, the templates
 * and their tests are untouched, and one setting decides whether the channel
 * they declare is the channel used. Turning SMS back on is a toggle in the
 * admin console, not a deploy.
 *
 * **A disabled SMS becomes an email rather than nothing.** The event still
 * happened — a consultation is waiting, a prescription was withdrawn — and
 * dropping it silently because a channel is off is how an operator learns not
 * to trust the notification system. Where the recipient has no email address
 * the send is recorded as suppressed further down, which is visible rather
 * than silent.
 *
 * Deduplicated, and that is not tidiness: `doctor.membership.expiring` and
 * `.suspended` already declare EMAIL alongside SMS, so a naive substitution
 * would send the same doctor the same message twice. Order is preserved so
 * the in-app and browser channels still fire first, which is what the doctor
 * actually looks at.
 */
async function routeChannels(
  declared: readonly TemplateChannel[],
  db: Db,
): Promise<TemplateChannel[]> {
  if (!declared.includes('SMS')) return [...declared];

  /*
   * Two independent reasons SMS may be unavailable, and either is enough.
   *
   * The setting is the pilot's switch, flipped in the admin console. The
   * provider is the deployment's: `SMS_PROVIDER=none` says no SMS gateway is
   * configured at all, which is how production boots without Arkesel
   * credentials for a channel it will never use.
   *
   * The provider is checked first and independently, because a toggle cannot
   * conjure a gateway. Turning the setting on while no provider is configured
   * must not start routing messages at an adapter that does not exist — it
   * leaves them going by email, which is what the deployment can actually do.
   */
  const configured = getEnv().SMS_PROVIDER !== 'none';
  const smsEnabled =
    configured && (await getBooleanSetting(SETTING_KEYS.NOTIFICATIONS_SMS_ENABLED, db));
  if (smsEnabled) return [...declared];

  const routed = declared.map((channel) => (channel === 'SMS' ? 'EMAIL' : channel));
  return [...new Set(routed)];
}

/**
 * Sends a notification on every channel its template declares.
 *
 * Never throws. The caller is a business operation that has already happened —
 * a prescription issued, a shift assigned — and it must not be undone because
 * a gateway was unreachable.
 */
export async function notify(
  input: NotifyInput,
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<NotifyResult> {
  const result: NotifyResult = { sent: 0, failed: 0, suppressed: 0 };

  try {
    const definition = NOTIFICATION_TEMPLATES.find((entry) => entry.code === input.templateCode);
    if (!definition) {
      getLogger().error({ templateCode: input.templateCode }, 'unknown notification template');
      return result;
    }

    // An admin may have edited the wording; the catalogue is the fallback.
    const overrides = await db.notificationTemplate.findMany({
      where: { code: definition.code, isActive: true },
    });

    /*
     * An explicit `channels` override still wins — the retry job passes a
     * single channel to resend exactly what failed, and re-routing it there
     * would retry something other than the message that did not arrive.
     */
    const channels = input.channels ?? (await routeChannels(definition.channels, db));

    for (const channel of channels) {
      const override = overrides.find((row) => row.channel === channel);
      const subject = override?.subject ?? definition.subject ?? undefined;

      let body: string;
      try {
        body = render(override?.body ?? definition.body, input.variables ?? {});
      } catch (error) {
        // A template asking for something it was not given is a bug in the
        // caller, not a delivery failure. Loud, and it stops here.
        getLogger().error(
          { err: error, templateCode: definition.code, channel },
          'notification template could not be rendered',
        );
        result.failed += 1;
        continue;
      }

      const address = await addressFor(input.recipient, channel, db);

      if (PROVIDER_CHANNELS.has(channel) && !address) {
        // Nothing to send to. Recorded so the absence is visible rather than
        // looking like a message that succeeded.
        await db.notification.create({
          data: {
            recipientType: input.recipient.type,
            recipientRef: recipientRef(input.recipient),
            channel,
            templateCode: definition.code,
            renderedPayloadHash: hashPayload(subject, body),
            status: 'SUPPRESSED',
            lastError: 'No address on file for this channel',
          },
        });
        result.suppressed += 1;
        continue;
      }

      const notification = await db.notification.create({
        data: {
          recipientType: input.recipient.type,
          recipientRef: recipientRef(input.recipient),
          channel,
          templateCode: definition.code,
          // The hash, never the body (spec §60).
          renderedPayloadHash: hashPayload(subject, body),
          status: 'SENDING',
          attempts: 1,
        },
      });

      if (!PROVIDER_CHANNELS.has(channel)) {
        emitInApp(input.recipient, definition.code, subject, body);
        await db.notification.update({
          where: { id: notification.id },
          data: { status: 'SENT', sentAt: clock.now() },
        });
        result.sent += 1;
        continue;
      }

      const outcome = await deliver(
        notification.id,
        channel as ProviderChannel,
        { to: address!, subject, body, reference: notification.id },
        db,
        clock,
      );

      if (outcome === 'SENT') result.sent += 1;
      else result.failed += 1;
    }
  } catch (error) {
    // The catch of last resort. Whatever went wrong, the operation that
    // triggered this notification has already succeeded and stays succeeded.
    getLogger().error(
      { err: error, templateCode: input.templateCode },
      'notification dispatch failed',
    );
  }

  return result;
}

/**
 * One delivery attempt.
 *
 * Distinguishes a permanent failure from a transient one, because the retry
 * job needs the difference: a malformed number does not become valid in a
 * minute, and retrying it forever buries the failures worth reading.
 */
async function deliver(
  notificationId: string,
  channel: ProviderChannel,
  message: { to: string; subject?: string; body: string; reference: string },
  db: Db,
  clock: Clock,
): Promise<'SENT' | 'FAILED'> {
  try {
    const outcome = await getNotificationProvider(channel).send(message);

    if (outcome.status === 'ACCEPTED') {
      await db.notification.update({
        where: { id: notificationId },
        data: { status: 'SENT', sentAt: clock.now(), providerRef: outcome.providerRef ?? null },
      });
      return 'SENT';
    }

    await db.notification.update({
      where: { id: notificationId },
      data: { status: 'FAILED', lastError: outcome.failureReason?.slice(0, 500) ?? 'Rejected' },
    });
    return 'FAILED';
  } catch (error) {
    const permanent = error instanceof PermanentDeliveryError;
    const message_ = error instanceof Error ? error.message : 'Delivery failed';

    await db.notification.update({
      where: { id: notificationId },
      data: {
        // SUPPRESSED means "will not be tried again". The retry job looks for
        // FAILED, so a permanent failure is put beyond its reach here rather
        // than relying on it to check the reason.
        status: permanent ? 'SUPPRESSED' : 'FAILED',
        lastError: message_.slice(0, 500),
      },
    });
    return 'FAILED';
  }
}

/**
 * Retries what failed (docs/architecture.md).
 *
 * Bounded, with a widening gap between attempts. A gateway that is down stays
 * down for minutes, and hammering it every sixty seconds helps nobody; a
 * notification that has failed five times is not going to succeed on the
 * sixth, and continuing to try hides it from whoever should look at it.
 */
const MAX_ATTEMPTS = 5;
const BACKOFF_MINUTES = [1, 5, 15, 60];

export async function retryFailedNotifications(
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<number> {
  const now = clock.now();

  const failed = await db.notification.findMany({
    where: { status: 'FAILED', attempts: { lt: MAX_ATTEMPTS } },
    orderBy: { createdAt: 'asc' },
    take: 100,
  });

  let retried = 0;

  for (const notification of failed) {
    const waitMinutes =
      BACKOFF_MINUTES[Math.min(notification.attempts - 1, BACKOFF_MINUTES.length - 1)]!;
    const dueAt = new Date(notification.createdAt.getTime() + waitMinutes * 60_000);
    if (dueAt > now) continue;

    if (!PROVIDER_CHANNELS.has(notification.channel as TemplateChannel)) {
      // An in-app emit that failed cannot be replayed usefully — the socket
      // moment has passed, and the durable surface is the work queue itself.
      await db.notification.update({
        where: { id: notification.id },
        data: { status: 'SUPPRESSED', lastError: 'In-app delivery is not retried' },
      });
      continue;
    }

    /**
     * The body is gone, by design.
     *
     * `notifications` stores a hash, so a retry cannot re-send the original
     * text — there is nothing to re-send. The retry re-renders from the
     * template with the variables it can still resolve, which for the codes
     * that carry no variables is exact, and for the rest is why the row
     * records the hash: a mismatch is visible.
     *
     * Codes that need variables are therefore not retried. Recording that
     * plainly beats sending a message with a placeholder in it.
     */
    const definition = NOTIFICATION_TEMPLATES.find(
      (entry) => entry.code === notification.templateCode,
    );
    if (!definition || definition.variables.length > 0) {
      await db.notification.update({
        where: { id: notification.id },
        data: {
          status: 'SUPPRESSED',
          lastError: 'Cannot be retried: the rendered body is not stored (spec §60)',
        },
      });
      continue;
    }

    const recipient = await resolveRecipient(notification.recipientType, notification.recipientRef);
    if (!recipient) {
      await db.notification.update({
        where: { id: notification.id },
        data: { status: 'SUPPRESSED', lastError: 'Recipient no longer exists' },
      });
      continue;
    }

    const address = await addressFor(recipient, notification.channel as TemplateChannel, db);
    if (!address) {
      await db.notification.update({
        where: { id: notification.id },
        data: { status: 'SUPPRESSED', lastError: 'No address on file for this channel' },
      });
      continue;
    }

    await db.notification.update({
      where: { id: notification.id },
      data: { status: 'SENDING', attempts: { increment: 1 } },
    });

    await deliver(
      notification.id,
      notification.channel as ProviderChannel,
      {
        to: address,
        subject: definition.subject,
        body: definition.body,
        reference: notification.id,
      },
      db,
      clock,
    );
    retried += 1;
  }

  // Anything that has exhausted its attempts stops being retried and starts
  // being visible.
  await db.notification.updateMany({
    where: { status: 'FAILED', attempts: { gte: MAX_ATTEMPTS } },
    data: { status: 'SUPPRESSED', lastError: 'Gave up after repeated failures' },
  });

  return retried;
}

function resolveRecipient(type: string, ref: string): Recipient | null {
  switch (type) {
    case 'DOCTOR':
      return { type: 'DOCTOR', doctorId: ref };
    case 'PHARMACY':
      return { type: 'PHARMACY', pharmacyId: ref };
    case 'PATIENT':
      return { type: 'PATIENT', consultationId: ref };
    case 'ADMIN':
      return { type: 'ADMIN' };
    default:
      return null;
  }
}

/**
 * Sends a notification only if the same one has not gone recently.
 *
 * Three of the notifications wired in Phase 11 are raised by a periodic job
 * rather than by a business event: a licence approaching expiry, a membership
 * approaching expiry, and destruction that has fallen overdue. Each of those
 * conditions stays true for weeks, so the job that notices it would send the
 * same message on every run — a doctor warned sixty times about one licence
 * learns to ignore the warning, which is worse than not sending it.
 *
 * Event-driven notifications do not use this. They fire once because the event
 * happens once, and adding a window to them would silently drop the second of
 * two legitimate messages.
 *
 * The check is against the `notifications` table, so it survives a restart and
 * does not need state of its own. It counts a SUPPRESSED row as having been
 * sent, deliberately: suppression means the recipient has no address on that
 * channel, and retrying daily will not give them one.
 */
export async function notifyOnce(
  input: NotifyInput,
  options: { withinDays: number },
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<NotifyResult | null> {
  const since = new Date(clock.now().getTime() - options.withinDays * 86_400_000);

  const existing = await db.notification.findFirst({
    where: {
      templateCode: input.templateCode,
      recipientType: input.recipient.type,
      recipientRef: recipientRef(input.recipient),
      createdAt: { gte: since },
    },
    select: { id: true },
  });

  if (existing) return null;

  return notify(input, db, clock);
}
