import type { PrismaClient } from '@prisma/client';
import { getPrisma } from '../../db/prisma.ts';
import { getLogger } from '../../lib/logger.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
import { getVideoProvider } from '../../adapters/media/index.ts';
import { recordAudit, AUDIT_ACTIONS } from '../audit/audit.service.ts';
import { getIntSetting } from '../settings/settings.service.ts';
import { SETTING_KEYS } from '../settings/settings.defaults.ts';

/**
 * Warns before the video provider's credential expires (D70).
 *
 * **The incident this exists for.** Whereby issues its API key as a JWT with a
 * thirty-day life. One expired on 7 October 2026 at 16:00:11 UTC. Eleven
 * minutes later a patient paid GHS 1, a doctor accepted, and no room could be
 * created for either of them — because the key was no longer valid. The
 * consultation was swept two hours later and refunded, and the cause took a
 * day and a database query to find.
 *
 * Nothing had warned that the date was coming, and nothing could: the expiry
 * was sitting inside the credential the whole time, and nothing read it.
 *
 * **Why a warning and not a refusal.** This reports; it never stops anything.
 * A key Neem believes is expiring is not the same as one the provider has
 * rejected — clocks differ, keys get rotated without Neem being told, and
 * refusing consultations on a date arithmetic is a worse failure than the one
 * it would prevent. `npm run whereby:check` is what tests whether a key
 * actually works, and a human decides.
 *
 * **What it cannot tell you.** A key can be revoked, have its account
 * suspended, or hit a quota, none of which has a date. Silence here means
 * "no expiry is approaching", never "the provider is fine".
 */

/** How many days ahead to start warning. */
const DEFAULT_WARNING_DAYS = 7;

export interface MediaCredentialStatus {
  /** Null when the credential carries no expiry, or is not readable as one. */
  expiresAt: Date | null;
  /** Whole days until it expires. Negative once it has. Null when unknown. */
  daysRemaining: number | null;
  expired: boolean;
}

/**
 * What the video provider's credential says about its own lifetime.
 *
 * Never calls the provider, so it is safe to read from a health endpoint and
 * from a job, including when the provider is exactly what has stopped working.
 */
export function mediaCredentialStatus(clock: Clock = systemClock): MediaCredentialStatus {
  const provider = getVideoProvider();
  const expiresAt = provider.credentialExpiresAt?.() ?? null;

  /*
   * An unusable date is treated as no date at all.
   *
   * The contract lets any adapter answer this, and a Date that cannot be read
   * — NaN, from a sentinel expiry or a malformed claim — poisons everything
   * downstream silently: every comparison against it is false, so a range
   * check passes it through, and `toISOString()` then throws inside the
   * warning. Caught here as well as in the adapter, because this is the
   * boundary the rest of the system reads.
   */
  if (!expiresAt || Number.isNaN(expiresAt.getTime())) {
    return { expiresAt: null, daysRemaining: null, expired: false };
  }

  const millis = expiresAt.getTime() - clock.now().getTime();

  return {
    expiresAt,
    // Floored, so "0 days remaining" means it goes today rather than that it
    // has gone. Negative once it has.
    daysRemaining: Math.floor(millis / 86_400_000),
    expired: millis <= 0,
  };
}

/**
 * The scheduled check. Returns 1 when it warned, 0 otherwise.
 *
 * Logs at `error` once expired and `warn` while it is approaching, because the
 * two call for different urgency and a log search during an incident should be
 * able to tell them apart. Audited either way, so there is a record of when
 * Neem first knew.
 */
export async function warnExpiringMediaCredential(
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<number> {
  const status = mediaCredentialStatus(clock);

  // Nothing to warn about: no expiry, or not near enough to matter yet.
  if (status.expiresAt === null || status.daysRemaining === null) return 0;

  const warningDays = await getIntSetting(SETTING_KEYS.MEDIA_CREDENTIAL_WARNING_DAYS, db).catch(
    () => DEFAULT_WARNING_DAYS,
  );

  if (status.daysRemaining > warningDays) return 0;

  const provider = getVideoProvider();
  const detail = {
    provider: provider.name,
    expiresAt: status.expiresAt.toISOString(),
    daysRemaining: status.daysRemaining,
  };

  if (status.expired) {
    getLogger().error(
      detail,
      'the video provider credential has EXPIRED — no consultation can open a room until it is replaced',
    );
  } else {
    getLogger().warn(
      detail,
      'the video provider credential expires soon — replace it before consultations stop connecting',
    );
  }

  /*
   * Audited daily rather than once, deliberately.
   *
   * The doctor-licence warning deduplicates because it reaches a person who
   * learns to ignore a repeated message. This reaches a log and an audit
   * trail, where a daily entry is the useful shape: it answers "how long has
   * this been true" at a glance, which is the question somebody asks in the
   * middle of an outage.
   *
   * No part of the credential is recorded. A date and a count of days.
   */
  await recordAudit(
    {
      action: AUDIT_ACTIONS.MEDIA_CREDENTIAL_EXPIRING,
      actorType: 'SYSTEM',
      entityType: 'media_provider',
      entityId: provider.name,
      metadata: detail,
    },
    db,
  ).catch((error: unknown) =>
    getLogger().error({ err: error }, 'could not audit a media credential warning'),
  );

  return 1;
}
