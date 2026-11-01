import { addHours } from 'date-fns';
import { getEnv } from '../../config/env.ts';
import { getNotificationProvider } from '../../adapters/notification/index.ts';
import type { Db } from '../../db/prisma.ts';
import { generateToken, hashToken } from '../../lib/crypto.ts';
import type { Clock } from '../../lib/clock.ts';

/**
 * One-time set-up links for accounts an administrator creates: CHPS staff
 * (D73), operations administrators and district officers (D84).
 *
 * Nobody registers themselves into these roles. The administrator creates the
 * account with a password nobody knows and hands over this link, so no
 * password ever passes through anybody but its owner.
 */

/**
 * How long a set-up link lasts. Longer than a password reset's hour, because
 * it may be handed over on paper at a district meeting and used days later on
 * the facility's own device.
 */
export const STAFF_SETUP_LINK_HOURS = 72;

export interface IssuedSetupLink {
  setupPath: string;
  setupExpiresAt: Date;
  emailed: boolean;
}

/**
 * Issues a fresh link, ending any earlier one still open.
 *
 * `createdFor` finishes the sentence "A Neem account has been created for
 * you …", and `whoToTell` the one about an unexpected email.
 */
export async function issueSetupLink(
  user: { id: string; email: string },
  wording: { createdFor: string; whoToTell: string },
  db: Db,
  clock: Clock,
): Promise<IssuedSetupLink> {
  const now = clock.now();
  await db.passwordResetToken.updateMany({
    where: { userId: user.id, usedAt: null, expiresAt: { gt: now } },
    data: { expiresAt: now },
  });

  const token = generateToken();
  const setupExpiresAt = addHours(now, STAFF_SETUP_LINK_HOURS);
  await db.passwordResetToken.create({
    data: { userId: user.id, tokenHash: hashToken(token), expiresAt: setupExpiresAt },
  });

  const setupPath = `/auth/reset?token=${token}`;

  /*
   * Emailed only where email is really delivered (as the reset route
   * decides). Elsewhere the administrator hands the link over, and the
   * screen says so rather than claiming a message went out.
   */
  const emailed = getEnv().EMAIL_PROVIDER === 'smtp';
  if (emailed) {
    void getNotificationProvider('EMAIL')
      .send({
        to: user.email,
        subject: 'Set up your Neem account',
        body:
          `A Neem account has been created for you ${wording.createdFor}.\n\n` +
          `Choose your password here:\n${getEnv().WEB_ORIGIN}${setupPath}\n\n` +
          `The link can be used once and expires in ${STAFF_SETUP_LINK_HOURS} hours. ` +
          `If you were not expecting this, ignore it and tell ${wording.whoToTell}.`,
        reference: `staffsetup_${token.slice(0, 8)}`,
      })
      .catch(() => {
        // The administrator still holds the link; a failed email loses nothing.
      });
  }

  return { setupPath, setupExpiresAt, emailed };
}
