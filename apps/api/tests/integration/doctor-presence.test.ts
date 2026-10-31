import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getPrisma, disconnectPrisma } from '../../src/db/prisma.ts';
import { closeTestApp } from '../helpers/app.ts';
import { createTestUser, resetDatabase } from '../helpers/database.ts';
import {
  HEARTBEAT_STALE_SECONDS,
  getPresence,
  goOffline,
  goOnline,
  heartbeat,
  reapStalePresence,
} from '../../src/modules/queue/presence.service.ts';
import { generatePublicId, encryptField } from '../../src/lib/crypto.ts';

/**
 * Whether a doctor is online, and who gets to decide (D72).
 *
 * Reported from the pilot: doctors kept going offline by themselves. The
 * heartbeat ran on one screen and the stale window was ninety seconds, so
 * opening a consultation or letting a phone sleep took a working doctor out of
 * the queue, silently. The fix has to pull in two directions at once — a
 * doctor who is working must stay online through quiet minutes, and a doctor
 * who has declared a break must stay offline through a tab they forgot to
 * close. These cover both, because getting either one alone is easy.
 */

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeTestApp();
  await disconnectPrisma();
});

async function aDoctor(): Promise<string> {
  const prisma = getPrisma();
  const suffix = generatePublicId('x').slice(-8).toLowerCase();
  const user = await createTestUser({
    email: `${suffix}@presence.test`,
    password: 'DoctorPassword123!',
    role: 'DOCTOR',
  });
  const expiry = new Date();
  expiry.setFullYear(expiry.getFullYear() + 1);

  const doctor = await prisma.doctor.create({
    data: {
      publicId: generatePublicId('doc'),
      userId: user.id,
      fullName: 'Dr. Presence',
      mdcNumber: `MDC-P-${suffix}`,
      qualification: 'MB ChB',
      practiceAddress: 'Ridge Clinic, Accra',
      mdcExpiresAt: expiry,
      status: 'ACTIVE',
      isDemo: true,
      phoneEnc: encryptField('+233240000333'),
    },
  });

  return doctor.id;
}

/** Backdates the heartbeat, which is how a doctor becomes stale in real life. */
async function lastSeenSecondsAgo(doctorId: string, seconds: number): Promise<void> {
  await getPrisma().doctorPresence.update({
    where: { doctorId },
    data: { lastHeartbeatAt: new Date(Date.now() - seconds * 1000) },
  });
}

describe('a doctor at work', () => {
  it('stays online through a quiet few minutes', async () => {
    const doctorId = await aDoctor();
    await goOnline(doctorId);

    // Long enough to have been reaped under the old ninety-second window —
    // which is the length of reading one document.
    await lastSeenSecondsAgo(doctorId, 120);
    expect(await reapStalePresence()).toBe(0);
    expect((await getPresence(doctorId)).online).toBe(true);
  });

  it('is reaped only after the full stale window', async () => {
    const doctorId = await aDoctor();
    await goOnline(doctorId);

    await lastSeenSecondsAgo(doctorId, HEARTBEAT_STALE_SECONDS + 60);
    expect(await reapStalePresence()).toBe(1);
    expect((await getPresence(doctorId)).online).toBe(false);
  });

  it('comes back by itself when the next heartbeat arrives', async () => {
    const doctorId = await aDoctor();
    await goOnline(doctorId);
    await lastSeenSecondsAgo(doctorId, HEARTBEAT_STALE_SECONDS + 60);
    await reapStalePresence();

    // The doctor never left. A sleeping laptop is not a decision, so the first
    // sign of life restores them rather than waiting for them to notice.
    await heartbeat(doctorId);
    expect((await getPresence(doctorId)).online).toBe(true);
  });
});

describe('a doctor on a break', () => {
  it('stays offline no matter how long a forgotten tab keeps beating', async () => {
    const doctorId = await aDoctor();
    await goOnline(doctorId);
    await goOffline(doctorId);

    // The fault this prevents: a browser left open on the queue screen would
    // otherwise drag a doctor back on duty seconds after they declared a
    // break, and start handing them patients.
    for (let i = 0; i < 5; i += 1) await heartbeat(doctorId);

    expect((await getPresence(doctorId)).online).toBe(false);
  });

  it('is distinguishable from a reaped doctor in the data', async () => {
    const prisma = getPrisma();
    const resting = await aDoctor();
    const reaped = await aDoctor();

    await goOnline(resting);
    await goOffline(resting);

    await goOnline(reaped);
    await lastSeenSecondsAgo(reaped, HEARTBEAT_STALE_SECONDS + 60);
    await reapStalePresence();

    // This is what makes the rule above enforceable without a new column: a
    // break clears both timestamps, a reaping clears only `onlineSince`.
    const restingRow = await prisma.doctorPresence.findUniqueOrThrow({
      where: { doctorId: resting },
    });
    const reapedRow = await prisma.doctorPresence.findUniqueOrThrow({
      where: { doctorId: reaped },
    });

    expect(restingRow.onlineSince).toBeNull();
    expect(restingRow.lastHeartbeatAt).toBeNull();
    expect(reapedRow.onlineSince).toBeNull();
    expect(reapedRow.lastHeartbeatAt).not.toBeNull();
  });

  it('does not come online through a heartbeat before ever going online', async () => {
    const doctorId = await aDoctor();

    // No presence row at all. A heartbeat must not create one: going on duty
    // is a thing a doctor does, and the shift checks happen there.
    await heartbeat(doctorId);
    expect((await getPresence(doctorId)).online).toBe(false);
  });
});
