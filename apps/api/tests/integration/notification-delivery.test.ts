import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getPrisma, disconnectPrisma } from '../../src/db/prisma.ts';
import { closeTestApp, request, signIn } from '../helpers/app.ts';
import { createTestPharmacy, createTestUser, resetDatabase } from '../helpers/database.ts';
import { encryptField, generatePublicId } from '../../src/lib/crypto.ts';
import {
  MockNotificationProvider,
  resetNotificationProviders,
  setNotificationProviderForTesting,
} from '../../src/adapters/notification/index.ts';
import { transition } from '../../src/modules/consultation/consultation.service.ts';
import {
  createDraft,
  decideSubstitution,
  issuePrescription,
  proposeSubstitution,
  revokePrescription,
} from '../../src/modules/prescription/prescription.service.ts';
import { decideRefund, requestRefund } from '../../src/modules/payment/refund.service.ts';
import { changeDoctorStatus } from '../../src/modules/doctor/doctor.service.ts';
import { changePharmacyStatus } from '../../src/modules/pharmacy/pharmacy.service.ts';
import { assignShift } from '../../src/modules/scheduling/scheduling.service.ts';
import { acceptOffer, enforceResponseWindow } from '../../src/modules/queue/allocation.service.ts';
import { notifyOnce } from '../../src/modules/notification/notification.service.ts';
import { fixedClock } from '../../src/lib/clock.ts';
import { NOTIFICATION_TEMPLATES } from '../../src/modules/notification/templates.ts';

/**
 * That the notifications wired in Phase 11 actually go out.
 *
 * `notification-producers.test.ts` is a source scan: it proves a call site
 * exists. It cannot prove the call is correct, and the failure it cannot see
 * is the one most likely to happen — a producer passing `reference` where the
 * template declares `consultationReference`. `render` throws on a variable it
 * was not given, `notify` catches it, and the notification is recorded FAILED
 * while the business operation succeeds exactly as intended. Nothing anywhere
 * goes red.
 *
 * So these drive the real services and assert the row that came out: the right
 * template, to the right recipient, and **never FAILED**. A template that
 * cannot be rendered is a defect in the caller, and this is what makes it one
 * that shows.
 */

const PHARMACY_PASSWORD = 'PharmacyPassword123!';
const DOCTOR_PASSWORD = 'DoctorPassword123!';
const ADMIN_PASSWORD = 'AdminPassword123!';

const sms = new MockNotificationProvider('SMS');
const email = new MockNotificationProvider('EMAIL');
const whatsapp = new MockNotificationProvider('WHATSAPP');

interface Cast {
  consultationId: string;
  consultationPublicId: string;
  doctorId: string;
  doctorPublicId: string;
  pharmacyId: string;
  pharmacyUserId: string;
  adminId: string;
  languageId: string;
}

async function cast(state: 'IN_PROGRESS' | 'ASSIGNED' = 'IN_PROGRESS'): Promise<Cast> {
  const prisma = getPrisma();
  const suffix = generatePublicId('x').slice(-8).toLowerCase();

  const pharmacy = await createTestPharmacy(`Pharmacy ${suffix}`, 'ACTIVE');
  await prisma.pharmacy.update({
    where: { id: pharmacy.id },
    data: { phone: '0244000111', email: `${suffix}@pharmacy.test` },
  });

  const pharmacyUser = await createTestUser({
    email: `${suffix}@pharmacy.test`,
    password: PHARMACY_PASSWORD,
    role: 'PHARMACY',
  });
  await prisma.pharmacyUser.create({
    data: { pharmacyId: pharmacy.id, userId: pharmacyUser.id },
  });

  const admin = await createTestUser({
    email: `${suffix}@admin.test`,
    password: ADMIN_PASSWORD,
    role: 'ADMIN',
  });

  const doctorUser = await createTestUser({
    email: `${suffix}@doctor.test`,
    password: DOCTOR_PASSWORD,
    role: 'DOCTOR',
  });

  const expiry = new Date();
  expiry.setFullYear(expiry.getFullYear() + 1);

  const doctor = await prisma.doctor.create({
    data: {
      publicId: generatePublicId('doc'),
      userId: doctorUser.id,
      fullName: 'Dr. Ama Boateng',
      mdcNumber: `MDC-N-${suffix}`,
      mdcExpiresAt: expiry,
      phoneEnc: encryptField('0244000222'),
      status: 'ACTIVE',
      isDemo: true,
      signatures: { create: { signatureDataEnc: encryptField('data:image/png;base64,AAAA') } },
    },
  });

  const cookies = await signIn(pharmacyUser.email, PHARMACY_PASSWORD);
  const created = await request<{ publicId: string }>('/pharmacy/consultations', {
    method: 'POST',
    cookies,
    payload: {},
  });
  const publicId = created.body.data!.publicId;
  const consultation = await prisma.consultation.findUniqueOrThrow({ where: { publicId } });

  await prisma.patientSession.create({
    data: {
      consultationId: consultation.id,
      fullNameEnc: encryptField('Adwoa Mensah'),
      age: 34,
      sex: 'FEMALE',
      phoneEnc: encryptField('0245551234'),
    },
  });

  const language = await prisma.language.upsert({
    where: { code: 'en' },
    update: {},
    create: { code: 'en', label: 'English', isActive: true },
  });

  await prisma.consultation.update({
    where: { id: consultation.id },
    data: { doctorId: doctor.id, type: 'VIDEO', languageId: language.id },
  });

  const path = [
    'PAYMENT_PROCESSING',
    'PAID',
    'ACTIVATED',
    'WAITING_FOR_PATIENT',
    'PATIENT_JOINED',
    'WAITING_FOR_DOCTOR',
    'ASSIGNED',
    ...(state === 'IN_PROGRESS' ? (['DOCTOR_ACCEPTED', 'IN_PROGRESS'] as const) : []),
  ] as const;

  for (const next of path) {
    await transition(consultation.id, next, { actorType: 'SYSTEM', reason: 'fixture' });
  }

  return {
    consultationId: consultation.id,
    consultationPublicId: publicId,
    doctorId: doctor.id,
    doctorPublicId: doctor.publicId,
    pharmacyId: pharmacy.id,
    pharmacyUserId: pharmacyUser.id,
    adminId: admin.id,
    languageId: language.id,
  };
}

/**
 * Waits for a notification row to appear.
 *
 * Producers are fired with `void notify(...)` on purpose — a gateway must
 * never hold up a prescription — so the row lands just after the call the test
 * made returns.
 */
async function settled(templateCode: string, attempts = 80) {
  const prisma = getPrisma();
  const IN_FLIGHT = ['QUEUED', 'SENDING'];

  /**
   * How many rows to wait for, taken from the catalogue rather than guessed.
   *
   * `notify` writes one row per declared channel, in sequence. Waiting only
   * for "some rows, all terminal" returns as soon as the IN_APP and BROWSER
   * rows are done — before the SMS row has been created at all — so an
   * assertion on what was actually sent read an empty outbox while the
   * product was working correctly. Two of these tests failed that way, and
   * the fault was entirely in this helper.
   */
  const expected =
    NOTIFICATION_TEMPLATES.find((template) => template.code === templateCode)?.channels.length ?? 1;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const rows = await prisma.notification.findMany({ where: { templateCode } });

    if (rows.length >= expected && rows.every((row) => !IN_FLIGHT.includes(row.status))) {
      return rows;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  return prisma.notification.findMany({ where: { templateCode } });
}

/** Every notification written so far, whatever the template. */
async function allNotifications() {
  return getPrisma().notification.findMany({
    select: { templateCode: true, channel: true, status: true, lastError: true },
  });
}

const ITEM = {
  medication: 'Amoxicillin',
  strength: '500mg',
  form: 'Capsule',
  dose: '1 capsule',
  frequency: 'Three times daily',
  durationText: '5 days',
  quantity: '15 capsules',
};

beforeEach(async () => {
  await resetDatabase();
  resetNotificationProviders();
  sms.clear();
  email.clear();
  whatsapp.clear();
  setNotificationProviderForTesting('SMS', sms);
  setNotificationProviderForTesting('EMAIL', email);
  setNotificationProviderForTesting('WHATSAPP', whatsapp);
});

afterAll(async () => {
  resetNotificationProviders();
  await closeTestApp();
  await disconnectPrisma();
});

describe('the pharmacy is told what it is waiting on', () => {
  it('tells the counter when a prescription is revoked (spec §46)', async () => {
    const fixture = await cast();
    const draft = await createDraft(fixture.consultationId, fixture.doctorId, [ITEM]);
    const prescription = await issuePrescription(draft.id, fixture.doctorId);

    await revokePrescription(prescription.id, fixture.doctorId, 'Wrong strength');

    const rows = await settled('pharmacy.prescription.revoked');

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.recipientRef === fixture.pharmacyId)).toBe(true);
    expect(rows.some((row) => row.status === 'FAILED')).toBe(false);

    // The message names the consultation and nothing about the medicine.
    const text = sms
      .sent()
      .map((message) => message.body)
      .join(' ');
    expect(text).toContain(fixture.consultationPublicId);
    expect(text).not.toContain('Amoxicillin');
  });

  it('tells the counter how a substitution was decided (spec §47)', async () => {
    const fixture = await cast();
    const draft = await createDraft(fixture.consultationId, fixture.doctorId, [ITEM]);
    const prescription = await issuePrescription(draft.id, fixture.doctorId);
    const items = await getPrisma().prescriptionItem.findMany({
      where: { prescriptionId: prescription.id },
    });

    const proposal = await proposeSubstitution(
      prescription.id,
      items[0]!.id,
      fixture.pharmacyId,
      fixture.pharmacyUserId,
      { medication: 'Ampicillin', reason: 'Out of stock' },
    );

    await decideSubstitution(proposal.id, fixture.doctorId, { approve: true });

    const rows = await settled('pharmacy.substitution.decided');

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.recipientRef === fixture.pharmacyId)).toBe(true);
    // The half of the exchange that was missing until Phase 11 — and the half
    // somebody was blocked on, since dispensing waits for this answer.
    expect(rows.some((row) => row.status === 'FAILED')).toBe(false);
  });

  it('tells the counter how a refund was decided (spec §41)', async () => {
    const fixture = await cast();
    const prisma = getPrisma();

    await prisma.payment.create({
      data: {
        publicId: generatePublicId('pay'),
        consultationId: fixture.consultationId,
        provider: 'mock',
        providerReference: `ref-${generatePublicId('r')}`,
        amountMinor: 4500,
        currency: 'GHS',
        status: 'SUCCESS',
        idempotencyKey: generatePublicId('idem'),
        paidAt: new Date(),
      },
    });

    const refund = await requestRefund(fixture.consultationId, {
      reason: 'The doctor never joined',
      requestedByType: 'PHARMACY',
      requestedByRef: fixture.pharmacyUserId,
    });

    // The administrator is told there is a decision waiting on them.
    const requested = await settled('admin.refund.requested');
    expect(requested.length).toBeGreaterThan(0);
    expect(requested.some((row) => row.status === 'FAILED')).toBe(false);

    await decideRefund(refund.publicId, fixture.adminId, { approve: false, note: 'Doctor joined' });

    const decided = await settled('pharmacy.refund.decided');
    expect(decided.length).toBeGreaterThan(0);
    expect(decided.every((row) => row.recipientRef === fixture.pharmacyId)).toBe(true);
    expect(decided.some((row) => row.status === 'FAILED')).toBe(false);
  });
});

describe('an application that has been decided says so', () => {
  it('tells a doctor their application was approved (spec §21)', async () => {
    const fixture = await cast();
    const prisma = getPrisma();

    // Back to the start of the lifecycle so the approval is a real transition.
    await prisma.doctor.update({
      where: { id: fixture.doctorId },
      data: { status: 'UNDER_REVIEW' },
    });

    await changeDoctorStatus(fixture.doctorPublicId, 'APPROVED', { adminId: fixture.adminId });

    const rows = await settled('doctor.account.approved');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.recipientRef === fixture.doctorId)).toBe(true);
    expect(rows.some((row) => row.status === 'FAILED')).toBe(false);
  });

  it('tells a pharmacy it was approved (spec §20)', async () => {
    const prisma = getPrisma();
    const pharmacy = await createTestPharmacy('Waiting Pharmacy', 'PENDING');
    await prisma.pharmacy.update({
      where: { id: pharmacy.id },
      data: { status: 'UNDER_REVIEW', phone: '0244777888', email: 'waiting@pharmacy.test' },
    });
    const admin = await createTestUser({
      email: 'approver@admin.test',
      password: ADMIN_PASSWORD,
      role: 'ADMIN',
    });

    await changePharmacyStatus(pharmacy.publicId, 'APPROVED', { adminId: admin.id });

    const rows = await settled('pharmacy.account.approved');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.recipientRef === pharmacy.id)).toBe(true);
    expect(rows.some((row) => row.status === 'FAILED')).toBe(false);
  });

  it('tells a doctor a shift has been assigned to them (spec §25)', async () => {
    const fixture = await cast();
    const today = new Date().toISOString().slice(0, 10);

    await assignShift(
      { doctorPublicId: fixture.doctorPublicId, shiftCode: 'MORNING', serviceDate: today },
      { adminId: fixture.adminId },
    );

    const rows = await settled('doctor.shift.assigned');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.recipientRef === fixture.doctorId)).toBe(true);
    expect(rows.some((row) => row.status === 'FAILED')).toBe(false);

    // An assignment is not cover until the doctor confirms it, which is why
    // this message exists at all.
    const text = email
      .sent()
      .map((message) => message.body)
      .join(' ');
    expect(text).toMatch(/confirm/i);
  });
});

describe('the queue tells the people waiting on it', () => {
  it('tells the counter and the patient when a doctor accepts (spec §31)', async () => {
    const fixture = await cast('ASSIGNED');
    const prisma = getPrisma();

    const now = new Date();
    await prisma.consultationQueueEntry.create({
      data: {
        consultationId: fixture.consultationId,
        languageId: fixture.languageId,
        state: 'OFFERING',
        enqueuedAt: now,
      },
    });
    await prisma.consultationAssignment.create({
      data: {
        consultationId: fixture.consultationId,
        doctorId: fixture.doctorId,
        offeredAt: now,
        respondByAt: new Date(now.getTime() + 90_000),
        result: 'PENDING',
        score: 1,
        attemptNumber: 1,
      },
    });

    const result = await acceptOffer(fixture.consultationPublicId, fixture.doctorId);
    expect(result.accepted).toBe(true);

    const counter = await settled('pharmacy.consultation.doctor-assigned');
    expect(counter.length).toBeGreaterThan(0);
    expect(counter.some((row) => row.status === 'FAILED')).toBe(false);

    /**
     * The patient's own screen polls and would show this anyway — to somebody
     * watching it. This is for the patient who put the phone down at a
     * counter, which is the situation the product is designed around.
     */
    const patient = await settled('patient.consultation.ready');
    expect(patient.length).toBeGreaterThan(0);
    expect(patient.some((row) => row.status === 'FAILED')).toBe(false);
  });

  it('tells a doctor their offer lapsed and went elsewhere (spec §30)', async () => {
    const fixture = await cast('ASSIGNED');
    const prisma = getPrisma();

    const past = new Date(Date.now() - 120_000);
    await prisma.consultationQueueEntry.create({
      data: {
        consultationId: fixture.consultationId,
        languageId: fixture.languageId,
        state: 'OFFERING',
        enqueuedAt: past,
      },
    });
    await prisma.consultationAssignment.create({
      data: {
        consultationId: fixture.consultationId,
        doctorId: fixture.doctorId,
        offeredAt: past,
        respondByAt: new Date(past.getTime() + 1000),
        result: 'PENDING',
        score: 1,
        attemptNumber: 1,
      },
    });

    await enforceResponseWindow();

    const rows = await settled('doctor.consultation.missed');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.recipientRef === fixture.doctorId)).toBe(true);
    expect(rows.some((row) => row.status === 'FAILED')).toBe(false);
  });
});

describe('notifications raised by a periodic job do not repeat', () => {
  it('sends once inside the window and not again', async () => {
    const fixture = await cast();

    const clock = fixedClock(new Date('2026-09-04T09:00:00Z'));

    const first = await notifyOnce(
      {
        templateCode: 'doctor.licence.expiring',
        recipient: { type: 'DOCTOR', doctorId: fixture.doctorId },
        variables: { expiresAt: '2026-11-01' },
      },
      { withinDays: 30 },
      getPrisma(),
      clock,
    );
    expect(first).not.toBeNull();

    const second = await notifyOnce(
      {
        templateCode: 'doctor.licence.expiring',
        recipient: { type: 'DOCTOR', doctorId: fixture.doctorId },
        variables: { expiresAt: '2026-11-01' },
      },
      { withinDays: 30 },
      getPrisma(),
      clock,
    );

    // A doctor warned once acts on it. A doctor warned sixty times about the
    // same licence filters the sender, which costs more than the warning.
    expect(second).toBeNull();

    const rows = await getPrisma().notification.findMany({
      where: { templateCode: 'doctor.licence.expiring' },
    });
    const channels = new Set(rows.map((row) => row.channel));
    expect(rows.length).toBe(channels.size);
  });

  it('sends again once the window has passed', async () => {
    const fixture = await cast();

    await notifyOnce(
      {
        templateCode: 'doctor.membership.expiring',
        recipient: { type: 'DOCTOR', doctorId: fixture.doctorId },
        variables: { periodEnd: '2026-10-01' },
      },
      { withinDays: 7 },
      getPrisma(),
      fixedClock(new Date('2026-09-01T09:00:00Z')),
    );

    const later = await notifyOnce(
      {
        templateCode: 'doctor.membership.expiring',
        recipient: { type: 'DOCTOR', doctorId: fixture.doctorId },
        variables: { periodEnd: '2026-10-01' },
      },
      { withinDays: 7 },
      getPrisma(),
      fixedClock(new Date('2026-09-20T09:00:00Z')),
    );

    expect(later).not.toBeNull();
  });

  it('does not deduplicate across different recipients', async () => {
    const one = await cast();
    const two = await cast();
    const clock = fixedClock(new Date('2026-09-04T09:00:00Z'));

    for (const doctorId of [one.doctorId, two.doctorId]) {
      const sent = await notifyOnce(
        {
          templateCode: 'doctor.licence.expiring',
          recipient: { type: 'DOCTOR', doctorId },
          variables: { expiresAt: '2026-11-01' },
        },
        { withinDays: 30 },
        getPrisma(),
        clock,
      );
      // Two doctors, two licences, two warnings. A window is per recipient.
      expect(sent).not.toBeNull();
    }
  });
});

describe('nothing a producer sends fails to render', () => {
  it('records no render failure across a full working consultation', async () => {
    const fixture = await cast();
    const prisma = getPrisma();

    const draft = await createDraft(fixture.consultationId, fixture.doctorId, [ITEM]);
    const prescription = await issuePrescription(draft.id, fixture.doctorId);
    const items = await prisma.prescriptionItem.findMany({
      where: { prescriptionId: prescription.id },
    });
    const proposal = await proposeSubstitution(
      prescription.id,
      items[0]!.id,
      fixture.pharmacyId,
      fixture.pharmacyUserId,
      { medication: 'Ampicillin', reason: 'Out of stock' },
    );
    await decideSubstitution(proposal.id, fixture.doctorId, { approve: false });
    await revokePrescription(prescription.id, fixture.doctorId, 'Superseded');

    await settled('pharmacy.prescription.revoked');

    /**
     * The assertion that would have caught a mistyped variable name.
     *
     * `render` throws on a placeholder it was not given, `notify` catches it,
     * and the row is written FAILED while the prescription is issued exactly
     * as intended. Without this, a producer wired to the wrong variable looks
     * from the outside like a producer that works.
     */
    const rows = await allNotifications();
    const failed = rows.filter((row) => row.status === 'FAILED');

    expect(
      failed.map((row) => `${row.templateCode}/${row.channel}: ${row.lastError}`),
      'A notification failed. If the error mentions a placeholder, the producer ' +
        'is passing a variable the template does not declare.',
    ).toEqual([]);

    expect(rows.length).toBeGreaterThan(0);
  });
});
