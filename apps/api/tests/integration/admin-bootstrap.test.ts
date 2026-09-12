import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getPrisma, disconnectPrisma } from '../../src/db/prisma.ts';
import { closeTestApp, request } from '../helpers/app.ts';
import { resetDatabase } from '../helpers/database.ts';
import { generatePublicId, hashPassword } from '../../src/lib/crypto.ts';

/**
 * The account shape `scripts/create-admin.ts` writes, and whether it can
 * actually be used.
 *
 * The script exists because nothing in production could create an
 * administrator: `role: 'ADMIN'` was assigned only inside the demo seed, which
 * production refuses (spec §76), and there is no admin-creation route. So a
 * deployed API had reference data and nobody who could sign in.
 *
 * What is asserted here is the claim the script rests on — that writing the
 * `users` and `admins` rows is *all* that was missing, because TOTP enrolment
 * is self-service on first sign-in. If that were untrue the script would leave
 * an account nobody could use, and the failure would surface at the worst
 * moment: an operator, at a terminal, locked out of their own deployment.
 *
 * The interactive prompt is deliberately not exercised — it needs a TTY, and
 * the script now refuses anything else rather than half-reading a pipe. What
 * matters more is that the row it produces works, and that is what this covers.
 */

const PASSWORD = 'AdminBootstrapPassword123!';

/** Exactly the rows `create-admin.ts` writes, in the same shape. */
async function createAdminAccount(email: string) {
  return getPrisma().user.create({
    data: {
      publicId: generatePublicId('usr'),
      email,
      passwordHash: await hashPassword(PASSWORD),
      role: 'ADMIN',
      status: 'ACTIVE',
      isDemo: false,
      // twoFactorEnabledAt deliberately absent — this is the whole point.
      admin: { create: { fullName: 'Neem Administrator', title: 'Platform Administrator' } },
    },
    select: { id: true, email: true },
  });
}

beforeEach(resetDatabase);
afterAll(async () => {
  await closeTestApp();
  await disconnectPrisma();
});

describe('the account create-admin writes', () => {
  it('can sign in, and is told to enrol rather than let through', async () => {
    const admin = await createAdminAccount('bootstrap@neemtelehealth.test');

    const login = await request<{
      status: string;
      challengeId: string;
      enrollmentRequired: boolean;
    }>('/auth/login', {
      method: 'POST',
      payload: { email: admin.email, password: PASSWORD },
    });

    expect(login.status).toBe(200);
    expect(login.body.data!.status).toBe('TWO_FACTOR_REQUIRED');
    expect(login.body.data!.enrollmentRequired).toBe(true);
    expect(login.body.data!.challengeId).toBeTruthy();
  });

  it('can complete enrolment with the challenge from that sign-in', async () => {
    const admin = await createAdminAccount('enrol@neemtelehealth.test');

    const login = await request<{ challengeId: string }>('/auth/login', {
      method: 'POST',
      payload: { email: admin.email, password: PASSWORD },
    });

    const enrol = await request<{ qrDataUrl: string; secret?: string; recoveryCodes?: string[] }>(
      '/auth/2fa/enroll',
      { method: 'POST', payload: { challengeId: login.body.data!.challengeId } },
    );

    expect(enrol.status).toBe(200);
    // A QR the operator can scan, produced server-side.
    expect(enrol.body.data!.qrDataUrl.startsWith('data:image/png;base64,')).toBe(true);
  });

  /**
   * The guard that keeps a bootstrap tool from becoming a back door, asserted
   * against the database rather than against the script's own output: a second
   * administrator must be a deliberate act, so the count the script checks has
   * to actually see the first one.
   */
  it('is visible to the existing-administrator check the script performs', async () => {
    expect(await getPrisma().user.count({ where: { role: 'ADMIN' } })).toBe(0);

    await createAdminAccount('first@neemtelehealth.test');

    expect(await getPrisma().user.count({ where: { role: 'ADMIN' } })).toBe(1);
  });

  /**
   * `db:reset-2fa` clears enrolment for `isDemo` administrators so the e2e
   * suite can enrol afresh. A real administrator must not be reachable that
   * way, which is why the script sets isDemo false explicitly rather than
   * relying on a default.
   */
  it('is not a demo account, so reset-2fa cannot clear its enrolment', async () => {
    const admin = await createAdminAccount('real@neemtelehealth.test');

    const row = await getPrisma().user.findUniqueOrThrow({
      where: { id: admin.id },
      select: { isDemo: true },
    });

    expect(row.isDemo).toBe(false);
  });
});
