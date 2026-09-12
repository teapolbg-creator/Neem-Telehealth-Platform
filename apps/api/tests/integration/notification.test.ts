import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPrisma, disconnectPrisma } from '../../src/db/prisma.ts';
import { closeTestApp, request, signIn } from '../helpers/app.ts';
import {
  createTestPharmacy,
  createTestUser,
  resetDatabase,
  setSmsEnabled,
} from '../helpers/database.ts';
import { encryptField, generatePublicId } from '../../src/lib/crypto.ts';
import {
  MockNotificationProvider,
  resetNotificationProviders,
  setNotificationProviderForTesting,
} from '../../src/adapters/notification/index.ts';
import {
  notify,
  retryFailedNotifications,
} from '../../src/modules/notification/notification.service.ts';
import { fixedClock } from '../../src/lib/clock.ts';

/**
 * Notification dispatch (spec §58, §60).
 *
 * Beyond "does it send", these assert the three properties the module is built
 * around: nothing clinical leaves, the rendered body is never stored, and a
 * failure to notify never fails the operation that triggered it.
 */

const sms = new MockNotificationProvider('SMS');
const email = new MockNotificationProvider('EMAIL');

async function setUpPharmacy(phone = '0244000111') {
  const prisma = getPrisma();
  const pharmacy = await createTestPharmacy('Notify Pharmacy', 'ACTIVE');
  await prisma.pharmacy.update({ where: { id: pharmacy.id }, data: { phone } });
  return pharmacy;
}

async function setUpDoctor(phone: string | null = '0244000222') {
  const prisma = getPrisma();
  const user = await createTestUser({
    email: 'doctor@notify.test',
    password: 'DoctorPassword123!',
    role: 'DOCTOR',
  });

  const expiry = new Date();
  expiry.setFullYear(expiry.getFullYear() + 1);

  return prisma.doctor.create({
    data: {
      publicId: generatePublicId('doc'),
      userId: user.id,
      fullName: 'Dr. Notify',
      mdcNumber: `MDC-NT-${generatePublicId('x').slice(-8)}`,
      mdcExpiresAt: expiry,
      status: 'ACTIVE',
      isDemo: true,
      phoneEnc: phone ? encryptField(phone) : null,
    },
  });
}

beforeEach(async () => {
  await resetDatabase();
  // This file covers the SMS capability, which is switched off for the pilot
  // (D46) and deliberately kept rather than deleted. Asking for it explicitly
  // is what keeps it proven while it is off in production.
  await setSmsEnabled(true);

  sms.clear();
  email.clear();
  setNotificationProviderForTesting('SMS', sms);
  setNotificationProviderForTesting('EMAIL', email);
});

afterEach(() => {
  resetNotificationProviders();
});

afterAll(async () => {
  await closeTestApp();
  await disconnectPrisma();
});

// ---------------------------------------------------------------------------

describe('dispatch', () => {
  it('sends on every channel the template declares', async () => {
    const doctor = await setUpDoctor();

    const result = await notify({
      templateCode: 'doctor.membership.suspended',
      recipient: { type: 'DOCTOR', doctorId: doctor.id },
    });

    // IN_APP, EMAIL and SMS.
    expect(result.sent).toBe(3);
    expect(sms.sent()).toHaveLength(1);
    expect(email.sent()).toHaveLength(1);

    const rows = await getPrisma().notification.findMany({
      where: { recipientRef: doctor.id },
    });
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.status === 'SENT')).toBe(true);
  });

  /**
   * The property that makes the notification log safe to keep.
   *
   * `notifications` stores a hash so history cannot become a second copy of
   * personal data (spec §60). If the body were ever persisted, this would be
   * the test that noticed.
   */
  it('stores a hash and never the rendered body', async () => {
    const pharmacy = await setUpPharmacy();

    await notify({
      templateCode: 'pharmacy.prescription.issued',
      recipient: { type: 'PHARMACY', pharmacyId: pharmacy.id },
      variables: { consultationReference: 'NEEM-TEST-0001-0001' },
    });

    const row = await getPrisma().notification.findFirstOrThrow({
      where: { recipientRef: pharmacy.id },
    });

    const serialised = JSON.stringify(row);
    expect(serialised).not.toContain('NEEM-TEST-0001-0001');
    expect(serialised).not.toContain('ready to dispense');

    // And the hash is a real hash of what was sent.
    expect(row.renderedPayloadHash).toHaveLength(64);
    expect(row.renderedPayloadHash).toBe(
      createHash('sha256')
        .update(
          'A prescription is ready\nA prescription has been issued for consultation NEEM-TEST-0001-0001 and is ready to dispense.',
        )
        .digest('hex'),
    );
  });

  it('records a channel it has no address for as suppressed, not sent', async () => {
    const doctor = await setUpDoctor(null);

    const result = await notify({
      templateCode: 'doctor.membership.suspended',
      recipient: { type: 'DOCTOR', doctorId: doctor.id },
    });

    // No number on file: the SMS is suppressed rather than counted as sent.
    expect(result.suppressed).toBe(1);
    expect(sms.sent()).toHaveLength(0);

    const row = await getPrisma().notification.findFirstOrThrow({
      where: { recipientRef: doctor.id, channel: 'SMS' },
    });
    expect(row.status).toBe('SUPPRESSED');
    expect(row.lastError).toContain('No address');
  });

  it('decrypts the recipient’s number without storing it anywhere', async () => {
    const doctor = await setUpDoctor('0244555666');

    await notify({
      templateCode: 'doctor.membership.suspended',
      recipient: { type: 'DOCTOR', doctorId: doctor.id },
    });

    expect(sms.sent()[0]?.to).toBe('0244555666');

    const rows = await getPrisma().notification.findMany({ where: { recipientRef: doctor.id } });
    expect(JSON.stringify(rows)).not.toContain('0244555666');
  });

  /**
   * The rule that keeps a gateway outage from becoming an outage.
   *
   * A consultation is completed, a prescription issued, a shift assigned —
   * none of it may be undone because a notification could not be sent.
   */
  it('never throws, whatever goes wrong', async () => {
    await expect(
      notify({
        templateCode: 'this.template.does.not.exist',
        recipient: { type: 'ADMIN' },
      }),
    ).resolves.toEqual({ sent: 0, failed: 0, suppressed: 0 });

    const doctor = await setUpDoctor();
    // A template that needs a variable it was not given.
    await expect(
      notify({
        templateCode: 'doctor.membership.expiring',
        recipient: { type: 'DOCTOR', doctorId: doctor.id },
      }),
    ).resolves.toMatchObject({ sent: 0 });
  });

  it('uses an administrator’s edited wording over the catalogue', async () => {
    const pharmacy = await setUpPharmacy();

    // The row is seeded from the catalogue, so an administrator edits rather
    // than creates — which is exactly what this is testing.
    await getPrisma().notificationTemplate.update({
      where: {
        code_channel_locale: {
          code: 'pharmacy.prescription.issued',
          channel: 'IN_APP',
          locale: 'en',
        },
      },
      data: {
        subject: 'Edited subject',
        body: 'Edited body for {{consultationReference}}.',
      },
    });

    await notify({
      templateCode: 'pharmacy.prescription.issued',
      recipient: { type: 'PHARMACY', pharmacyId: pharmacy.id },
      variables: { consultationReference: 'NEEM-EDIT-0001-0001' },
    });

    const row = await getPrisma().notification.findFirstOrThrow({
      where: { recipientRef: pharmacy.id, channel: 'IN_APP' },
    });

    expect(row.renderedPayloadHash).toBe(
      createHash('sha256')
        .update('Edited subject\nEdited body for NEEM-EDIT-0001-0001.')
        .digest('hex'),
    );
  });
});

// ---------------------------------------------------------------------------

describe('failure and retry', () => {
  it('marks a permanently undeliverable address suppressed, beyond the retry job', async () => {
    const doctor = await setUpDoctor('not-a-phone-number');

    await notify({
      templateCode: 'doctor.membership.suspended',
      recipient: { type: 'DOCTOR', doctorId: doctor.id },
    });

    const row = await getPrisma().notification.findFirstOrThrow({
      where: { recipientRef: doctor.id, channel: 'SMS' },
    });

    // SUPPRESSED, not FAILED: the retry job looks for FAILED, so a number that
    // will never work is put beyond its reach rather than tried for ever.
    expect(row.status).toBe('SUPPRESSED');
    expect(await retryFailedNotifications()).toBe(0);
  });

  it('waits before retrying, then retries', async () => {
    const prisma = getPrisma();
    const doctor = await setUpDoctor();

    const notification = await prisma.notification.create({
      data: {
        recipientType: 'DOCTOR',
        recipientRef: doctor.id,
        channel: 'SMS',
        templateCode: 'doctor.membership.suspended',
        renderedPayloadHash: 'x'.repeat(64),
        status: 'FAILED',
        attempts: 1,
        lastError: 'Gateway timeout',
      },
    });

    // Too soon: the first backoff is a minute.
    expect(await retryFailedNotifications(prisma, fixedClock(new Date(Date.now() + 10_000)))).toBe(
      0,
    );

    // Past it.
    expect(await retryFailedNotifications(prisma, fixedClock(new Date(Date.now() + 120_000)))).toBe(
      1,
    );

    const after = await prisma.notification.findUniqueOrThrow({ where: { id: notification.id } });
    expect(after.attempts).toBe(2);
    expect(after.status).toBe('SENT');
  });

  /**
   * The body is not stored, so a retry cannot re-send the original text.
   *
   * For templates with no variables the catalogue body is exact and the retry
   * is faithful. For the rest it would be a guess, so it is not attempted —
   * recording why beats sending a message with a placeholder in it.
   */
  it('will not retry a template whose body it cannot reproduce', async () => {
    const prisma = getPrisma();
    const pharmacy = await setUpPharmacy();

    const notification = await prisma.notification.create({
      data: {
        recipientType: 'PHARMACY',
        recipientRef: pharmacy.id,
        channel: 'SMS',
        // Needs {{consultationReference}}, which the row does not hold.
        templateCode: 'pharmacy.prescription.revoked',
        renderedPayloadHash: 'x'.repeat(64),
        status: 'FAILED',
        attempts: 1,
      },
    });

    await retryFailedNotifications(prisma, fixedClock(new Date(Date.now() + 120_000)));

    const after = await prisma.notification.findUniqueOrThrow({ where: { id: notification.id } });
    expect(after.status).toBe('SUPPRESSED');
    expect(after.lastError).toContain('not stored');
  });

  it('gives up after repeated failures rather than retrying for ever', async () => {
    const prisma = getPrisma();
    const doctor = await setUpDoctor();

    const notification = await prisma.notification.create({
      data: {
        recipientType: 'DOCTOR',
        recipientRef: doctor.id,
        channel: 'SMS',
        templateCode: 'doctor.membership.suspended',
        renderedPayloadHash: 'x'.repeat(64),
        status: 'FAILED',
        attempts: 5,
      },
    });

    await retryFailedNotifications(prisma, fixedClock(new Date(Date.now() + 86_400_000)));

    const after = await prisma.notification.findUniqueOrThrow({ where: { id: notification.id } });
    expect(after.status).toBe('SUPPRESSED');
    expect(after.lastError).toContain('Gave up');
  });
});

// ---------------------------------------------------------------------------

describe('triggers (spec §58)', () => {
  it('sends the patient their consultation reference when it completes', async () => {
    // Asserted through the template rather than a full consultation, which
    // consultation.test.ts already drives end to end. What matters here is
    // that the reference is the only thing the message carries.
    const prisma = getPrisma();
    const pharmacy = await setUpPharmacy();

    const consultation = await prisma.consultation.create({
      data: {
        publicId: 'NEEM-ABCD-EFGH-JKLM',
        pharmacyId: pharmacy.id,
        state: 'COMPLETED',
        priceMinor: 3000,
        netMinor: 3000,
        isDemo: true,
      },
    });
    await prisma.patientSession.create({
      data: {
        consultationId: consultation.id,
        fullNameEnc: encryptField('Adwoa Mensah'),
        age: 34,
        sex: 'FEMALE',
        phoneEnc: encryptField('0245551234'),
      },
    });

    await notify({
      templateCode: 'patient.consultation.complete',
      recipient: { type: 'PATIENT', consultationId: consultation.id },
      variables: { consultationReference: consultation.publicId },
    });

    const message = sms.sent()[0];
    expect(message?.to).toBe('0245551234');
    expect(message?.body).toContain('NEEM-ABCD-EFGH-JKLM');

    // Nothing about the patient or the consultation beyond the reference.
    expect(message?.body).not.toContain('Adwoa');
    expect(message?.body.toLowerCase()).not.toContain('prescription');
  });

  it('is closed to a pharmacy trying to read another’s notifications', async () => {
    const pharmacy = await setUpPharmacy();
    const user = await createTestUser({
      email: 'pharmacy@notify.test',
      password: 'PharmacyPassword123!',
      role: 'PHARMACY',
    });
    await getPrisma().pharmacyUser.create({
      data: { pharmacyId: pharmacy.id, userId: user.id },
    });
    const cookies = await signIn('pharmacy@notify.test', 'PharmacyPassword123!');

    // There is deliberately no route that lists notifications: the log is a
    // dispatch record, not a message archive (decision D32).
    expect((await request('/notifications', { cookies })).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------

describe('template administration (spec §58)', () => {
  async function adminCookies() {
    const { authenticator } = await import('otplib');
    const { encryptTotpSecret } = await import('../../src/modules/auth/totp.service.ts');

    const secret = authenticator.generateSecret(20);
    await createTestUser({
      email: 'admin@notify.test',
      password: 'AdminPassword123!',
      role: 'ADMIN',
      twoFactorSecretEnc: encryptTotpSecret(secret),
      twoFactorEnabled: true,
    });

    const login = await request<{ challengeId: string }>('/auth/login', {
      method: 'POST',
      payload: { email: 'admin@notify.test', password: 'AdminPassword123!' },
    });
    const verify = await request('/auth/2fa/verify', {
      method: 'POST',
      payload: {
        challengeId: login.body.data!.challengeId,
        code: authenticator.generate(secret),
      },
    });

    return verify.cookies;
  }

  it('lists templates with what each may say', async () => {
    const cookies = await adminCookies();

    const response = await request<
      Array<{ code: string; variables: string[]; description: string | null }>
    >('/admin/notification-templates', { cookies });

    expect(response.status).toBe(200);
    expect(response.body.data!.length).toBeGreaterThan(0);

    const offer = response.body.data!.find((row) => row.code === 'doctor.consultation.offered');
    expect(offer?.variables).toContain('pharmacyName');
    expect(offer?.description).toBeTruthy();
  });

  /**
   * The catalogue is the list, not the table.
   *
   * `notify()` reads the code catalogue and treats a row as an override, so a
   * template with no row is still sent — it is simply unedited. Listing the
   * table instead hid those, which is a screen disagreeing with the system it
   * administers. It is not hypothetical: a database seeded before these
   * templates existed showed an empty catalogue while every message was going
   * out correctly.
   */
  it('lists a template that has no row, and calls it untouched rather than off', async () => {
    const cookies = await adminCookies();
    const prisma = getPrisma();

    await prisma.notificationTemplate.deleteMany({
      where: { code: 'doctor.consultation.offered', channel: 'SMS' },
    });

    const response = await request<
      Array<{ code: string; channel: string; isActive: boolean; updatedAt: string | null }>
    >('/admin/notification-templates', { cookies });

    const row = response.body.data!.find(
      (entry) => entry.code === 'doctor.consultation.offered' && entry.channel === 'SMS',
    );

    expect(row, 'a template with no override row must still be listed').toBeTruthy();
    // Absence of a row means nobody has edited it, never that it is disabled.
    expect(row!.isActive).toBe(true);
    expect(row!.updatedAt).toBeNull();
  });

  /**
   * The first edit of any template is the case that must work, and it was the
   * one that could not: `update` on a row that does not exist fails outright,
   * and every template starts without one.
   */
  it('creates the override row on the first edit', async () => {
    const cookies = await adminCookies();
    const prisma = getPrisma();

    await prisma.notificationTemplate.deleteMany({
      where: { code: 'doctor.consultation.offered', channel: 'SMS' },
    });

    const response = await request(
      '/admin/notification-templates/doctor.consultation.offered/SMS',
      {
        method: 'PATCH',
        cookies,
        payload: { body: 'A patient is waiting at {{pharmacyName}}. Please respond.' },
      },
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);

    const created = await prisma.notificationTemplate.findFirst({
      where: { code: 'doctor.consultation.offered', channel: 'SMS' },
    });

    expect(created).toBeTruthy();
    // Built from the catalogue, so editing the body alone does not blank the
    // subject the notification is supposed to carry.
    expect(created!.subject).toBe('A consultation is waiting');
  });

  it('refuses a channel the notification is never sent on', async () => {
    const cookies = await adminCookies();

    // `doctor.consultation.offered` declares IN_APP, BROWSER and SMS. Writing
    // an EMAIL row would create wording nothing ever reads.
    const response = await request(
      '/admin/notification-templates/doctor.consultation.offered/EMAIL',
      { method: 'PATCH', cookies, payload: { body: 'Anything.' } },
    );

    expect(response.status).toBe(404);
  });

  it('accepts a reworded template', async () => {
    const cookies = await adminCookies();

    const response = await request(
      '/admin/notification-templates/doctor.membership.suspended/EMAIL',
      {
        method: 'PATCH',
        cookies,
        payload: { body: 'Your account is no longer active. Renew in Neem to continue.' },
      },
    );

    expect(response.status).toBe(200);
  });

  /**
   * The rule this route exists to enforce.
   *
   * Rewording is an administrator's business; making a notification carry
   * clinical content is not, and it is refused at the point of saving rather
   * than discovered after it has been sent (spec §60).
   */
  it('refuses a body that would carry clinical content', async () => {
    const cookies = await adminCookies();

    const response = await request(
      '/admin/notification-templates/doctor.membership.suspended/EMAIL',
      {
        method: 'PATCH',
        cookies,
        payload: { body: 'Your malaria test was positive. Take 500 mg twice daily.' },
      },
    );

    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body.error)).toContain('clinical content');
  });

  it('refuses a variable the notification does not provide', async () => {
    const cookies = await adminCookies();

    const response = await request(
      '/admin/notification-templates/doctor.membership.suspended/EMAIL',
      {
        method: 'PATCH',
        cookies,
        payload: { body: 'Renew your membership, {{patientName}}.' },
      },
    );

    expect(response.status).toBe(400);
  });

  it('is closed to a pharmacy', async () => {
    const pharmacy = await setUpPharmacy();
    const user = await createTestUser({
      email: 'pharmacy@templates.test',
      password: 'PharmacyPassword123!',
      role: 'PHARMACY',
    });
    await getPrisma().pharmacyUser.create({
      data: { pharmacyId: pharmacy.id, userId: user.id },
    });
    const cookies = await signIn('pharmacy@templates.test', 'PharmacyPassword123!');

    expect((await request('/admin/notification-templates', { cookies })).status).toBe(403);
  });
});
