import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getPrisma, disconnectPrisma } from '../../src/db/prisma.ts';
import { closeTestApp } from '../helpers/app.ts';
import {
  createTestPharmacy,
  createTestUser,
  resetDatabase,
  setSmsEnabled,
} from '../helpers/database.ts';
import { notify } from '../../src/modules/notification/notification.service.ts';
import { invalidateSettingsCache } from '../../src/modules/settings/settings.service.ts';
import { encryptField, generatePublicId } from '../../src/lib/crypto.ts';

/**
 * SMS switched off for the pilot, email in its place (decision D46).
 *
 * The requirement was to deactivate SMS without deleting it, so what these
 * assert is mostly what did *not* change: the templates still declare SMS, the
 * adapters and provider selection are untouched, and one setting decides
 * whether the declared channel is the channel used. Turning it back on is a
 * toggle, and the last test here is that toggle working.
 *
 * The interesting case is the one that cannot be made to work. Doctors and
 * pharmacies have email addresses; patients do not, and there is no field for
 * one — Neem keeps no patient profile (spec §8.1). So the two patient SMS
 * templates cannot become emails, and the requirement was explicit that a
 * notification which cannot be delivered reliably must not block the pilot.
 * They are recorded as suppressed, which is visible, rather than dropped.
 */

/** A doctor with an email address and a phone number. */
async function makeDoctor() {
  const prisma = getPrisma();
  const suffix = generatePublicId('x').slice(-8).toLowerCase();

  const user = await createTestUser({
    email: `${suffix}@doctor.test`,
    password: 'DoctorPassword123!',
    role: 'DOCTOR',
  });
  const expiry = new Date();
  expiry.setFullYear(expiry.getFullYear() + 1);

  const doctor = await prisma.doctor.create({
    data: {
      publicId: generatePublicId('doc'),
      userId: user.id,
      fullName: 'Dr. Efua Danso',
      mdcNumber: `MDC-SMS-${suffix}`,
      mdcExpiresAt: expiry,
      status: 'ACTIVE',
      isDemo: true,
      phoneEnc: encryptField('0245551234'),
    },
  });

  return { doctorId: doctor.id, email: user.email };
}

const channelsSent = async (templateCode: string) =>
  (
    await getPrisma().notification.findMany({
      where: { templateCode },
      select: { channel: true, status: true },
      orderBy: { createdAt: 'asc' },
    })
  ).map((row) => `${row.channel}:${row.status}`);

beforeEach(async () => {
  await resetDatabase();
  invalidateSettingsCache();
});

afterAll(async () => {
  await closeTestApp();
  await disconnectPrisma();
});

describe('SMS off for the pilot', () => {
  it('sends an email where the template asked for an SMS', async () => {
    await setSmsEnabled(false);
    const doctor = await makeDoctor();

    await notify({
      templateCode: 'doctor.consultation.offered',
      recipient: { type: 'DOCTOR', doctorId: doctor.doctorId },
      variables: { pharmacyName: 'Akosua Pharmacy', seconds: 90 },
    });

    const channels = await channelsSent('doctor.consultation.offered');

    expect(channels.some((entry) => entry.startsWith('EMAIL'))).toBe(true);
    expect(channels.some((entry) => entry.startsWith('SMS'))).toBe(false);
  });

  /**
   * The deduplication case, and the reason routing is a set rather than a map.
   *
   * `doctor.membership.expiring` declares EMAIL *and* SMS. Substituting one
   * for the other without collapsing them sends the same doctor the same
   * message twice, which is the kind of defect that looks like a mail server
   * problem for a week before anyone reads the template.
   */
  it('does not email twice when the template already declared email', async () => {
    await setSmsEnabled(false);
    const doctor = await makeDoctor();

    await notify({
      templateCode: 'doctor.membership.expiring',
      recipient: { type: 'DOCTOR', doctorId: doctor.doctorId },
      variables: { periodEnd: '2026-10-01' },
    });

    const emails = (await channelsSent('doctor.membership.expiring')).filter((entry) =>
      entry.startsWith('EMAIL'),
    );

    expect(emails).toHaveLength(1);
  });

  /**
   * A patient has no email address anywhere in the system, so this one cannot
   * be rerouted. What matters is that it is *recorded* — the requirement was
   * that no event be silently lost because a channel is off.
   */
  it('records a patient notification as suppressed rather than losing it', async () => {
    await setSmsEnabled(false);

    const prisma = getPrisma();
    const pharmacy = await createTestPharmacy(
      `Pharmacy ${generatePublicId('x').slice(-6)}`,
      'ACTIVE',
    );
    const consultation = await prisma.consultation.create({
      data: {
        publicId: generatePublicId('con'),
        pharmacyId: pharmacy.id,
        state: 'COMPLETED',
        // `netMinor` is required and not derived: a discount makes the two
        // differ, so the schema refuses to guess which one a caller meant.
        priceMinor: 4000,
        netMinor: 4000,
      },
    });
    await prisma.patientSession.create({
      data: {
        consultationId: consultation.id,
        fullNameEnc: encryptField('Adwoa Mensah'),
        age: 30,
        sex: 'FEMALE',
        phoneEnc: encryptField('0245551234'),
      },
    });

    await notify({
      templateCode: 'patient.consultation.ready',
      recipient: { type: 'PATIENT', consultationId: consultation.id },
    });

    const rows = await prisma.notification.findMany({
      where: { templateCode: 'patient.consultation.ready' },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('SUPPRESSED');
    expect(rows[0]!.channel).toBe('EMAIL');
    // Visible enough for an operator to understand why nothing was sent.
    expect(rows[0]!.lastError).toBeTruthy();
  });

  /**
   * Nothing was deleted, which was the whole requirement.
   *
   * The templates still declare SMS and the adapters still exist; only the
   * routing changed. Flipping the setting must restore the old behaviour
   * exactly, with no redeploy and no code change.
   */
  it('sends SMS again the moment the setting is turned back on', async () => {
    await setSmsEnabled(true);
    const doctor = await makeDoctor();

    await notify({
      templateCode: 'doctor.consultation.offered',
      recipient: { type: 'DOCTOR', doctorId: doctor.doctorId },
      variables: { pharmacyName: 'Akosua Pharmacy', seconds: 90 },
    });

    const channels = await channelsSent('doctor.consultation.offered');

    expect(channels.some((entry) => entry.startsWith('SMS'))).toBe(true);
    expect(channels.some((entry) => entry.startsWith('EMAIL'))).toBe(false);
  });

  it('leaves templates that never declared SMS alone', async () => {
    await setSmsEnabled(false);
    const doctor = await makeDoctor();

    await notify({
      templateCode: 'doctor.account.approved',
      recipient: { type: 'DOCTOR', doctorId: doctor.doctorId },
    });

    const channels = await channelsSent('doctor.account.approved');

    // One email, from the template's own declaration — not a rerouted SMS.
    expect(channels.filter((entry) => entry.startsWith('EMAIL'))).toHaveLength(1);
  });
});
