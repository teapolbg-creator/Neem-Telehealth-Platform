import { authenticator } from 'otplib';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getPrisma, disconnectPrisma } from '../../src/db/prisma.ts';
import { closeTestApp, request, signIn } from '../helpers/app.ts';
import { createTestPharmacy, createTestUser, resetDatabase } from '../helpers/database.ts';
import { encryptTotpSecret } from '../../src/modules/auth/totp.service.ts';
import { decryptField, encryptField, generatePublicId } from '../../src/lib/crypto.ts';
import {
  MockPaymentProvider,
  setPaymentProviderForTesting,
} from '../../src/adapters/payment/index.ts';
import { splitRevenue } from '../../src/lib/money.ts';

/**
 * Admin analytics and configuration (spec §54, §96, §100).
 *
 * The Phase 9 exit criterion is the one asserted hardest here:
 *
 * > analytics never manufacture deleted clinical data.
 *
 * That means two things, and both are tested: nothing returned is derived from
 * a clinical record, and where a period's records have been destroyed the
 * response says so rather than presenting a partial figure as a whole one.
 */

const ADMIN = { email: 'admin@analytics.test', password: 'AdminPassword123!' };

async function adminCookies() {
  const secret = authenticator.generateSecret(20);
  await createTestUser({
    ...ADMIN,
    role: 'ADMIN',
    twoFactorSecretEnc: encryptTotpSecret(secret),
    twoFactorEnabled: true,
  });

  const login = await request<{ challengeId: string }>('/auth/login', {
    method: 'POST',
    payload: ADMIN,
  });
  const verify = await request('/auth/2fa/verify', {
    method: 'POST',
    payload: { challengeId: login.body.data!.challengeId, code: authenticator.generate(secret) },
  });

  return verify.cookies;
}

/** A completed consultation with money allocated against it. */
async function completedConsultation(options: { outcome?: string; destroyed?: boolean } = {}) {
  const prisma = getPrisma();
  const pharmacy = await createTestPharmacy(`Analytics ${generatePublicId('x').slice(-6)}`, 'ACTIVE');

  const consultation = await prisma.consultation.create({
    data: {
      publicId: generatePublicId('c'),
      pharmacyId: pharmacy.id,
      state: 'COMPLETED',
      outcome: (options.outcome ?? 'PRESCRIPTION') as never,
      priceMinor: 4000,
      netMinor: 4000,
      durationSeconds: 300,
      completedAt: new Date(),
      isDemo: true,
    },
  });

  const payment = await prisma.payment.create({
    data: {
      publicId: generatePublicId('pay'),
      consultationId: consultation.id,
      provider: 'mock',
      providerReference: `mock_${generatePublicId('p')}`,
      amountMinor: 4000,
      currency: 'GHS',
      status: 'SUCCESS',
      idempotencyKey: generatePublicId('idem'),
      paidAt: new Date(),
    },
  });

  const split = splitRevenue(4000, 3000, 'GHS');
  await prisma.revenueAllocation.create({
    data: {
      consultationId: consultation.id,
      paymentId: payment.id,
      grossMinor: 4000,
      netMinor: split.netMinor,
      pharmacySharePctBp: split.pharmacySharePctBp,
      pharmacyShareMinor: split.pharmacyShareMinor,
      neemShareMinor: split.neemShareMinor,
      currency: 'GHS',
    },
  });

  if (options.destroyed) {
    // The retention job has run: this consultation's clinical record is gone.
    await prisma.retentionJob.create({
      data: {
        consultationId: consultation.id,
        scheduledFor: new Date(Date.now() - 86_400_000),
        status: 'COMPLETED',
        completedAt: new Date(),
      },
    });
  }

  return { consultation, pharmacy };
}

beforeEach(async () => {
  await resetDatabase();
  setPaymentProviderForTesting(new MockPaymentProvider());
});

afterAll(async () => {
  setPaymentProviderForTesting(undefined);
  await closeTestApp();
  await disconnectPrisma();
});

// ---------------------------------------------------------------------------

describe('the exit criterion: analytics never manufacture deleted clinical data', () => {
  it('says plainly when a period’s records have been destroyed', async () => {
    await completedConsultation({ destroyed: false });
    await completedConsultation({ destroyed: true });

    const cookies = await adminCookies();
    const response = await request<{
      coverage: { consultationsInPeriod: number; recordsDestroyed: number; complete: boolean };
    }>('/admin/analytics/outcomes', { cookies });

    expect(response.status).toBe(200);
    expect(response.body.data!.coverage.recordsDestroyed).toBe(1);
    // The figure is not silently partial: the response carries its own
    // incompleteness so the screen can state it.
    expect(response.body.data!.coverage.complete).toBe(false);
  });

  it('reports a period as complete when nothing has been destroyed', async () => {
    await completedConsultation();

    const cookies = await adminCookies();
    const response = await request<{ coverage: { complete: boolean } }>(
      '/admin/analytics/outcomes',
      { cookies },
    );

    expect(response.body.data!.coverage.complete).toBe(true);
  });

  /**
   * The blunt version of the rule.
   *
   * If any analytics route ever grows a query against the clinical record,
   * this is what notices — the fixture writes a diagnosis and a test result,
   * and no analytics response may contain either.
   */
  it('returns nothing clinical from any analytics route', async () => {
    const prisma = getPrisma();
    const { consultation } = await completedConsultation();

    // Signed in first: `recordedByUserId` is a required foreign key, so the
    // fixture needs a real user to attribute the reading to.
    const cookies = await adminCookies();
    const admin = await prisma.user.findFirstOrThrow({ where: { email: ADMIN.email } });

    await prisma.consultationClinicalNotes.create({
      data: {
        consultationId: consultation.id,
        notesEnc: 'v1.notes',
        diagnosisEnc: 'v1.diagnosis',
        treatmentEnc: 'v1.treatment',
      },
    });
    await prisma.consultationTest.create({
      data: {
        consultationId: consultation.id,
        testCode: 'MALARIA_RDT',
        testLabel: 'Malaria RDT',
        resultEnc: 'v1.positive',
        recordedByUserId: admin.id,
      },
    });

    for (const path of [
      '/admin/analytics/operational',
      '/admin/analytics/financial',
      '/admin/analytics/satisfaction',
      '/admin/analytics/outcomes',
      '/admin/analytics/coverage',
    ]) {
      const body = JSON.stringify((await request(path, { cookies })).body).toLowerCase();

      expect(body, path).not.toContain('diagnosis');
      expect(body, path).not.toContain('malaria');
      expect(body, path).not.toContain('treatment');
      expect(body, path).not.toContain('notes');
    }
  });

  /**
   * An outcome is operational metadata, not clinical content.
   *
   * It says what *kind* of document was issued — which drives the pharmacy's
   * next step and the revenue split — and survives sealing. Reporting the mix
   * is legitimate; reporting what was in a prescription would not be.
   */
  it('reports the outcome mix without what was in any document', async () => {
    await completedConsultation({ outcome: 'PRESCRIPTION' });
    await completedConsultation({ outcome: 'ADVICE_ONLY' });
    await completedConsultation({ outcome: 'ADVICE_ONLY' });

    const cookies = await adminCookies();
    const response = await request<{ outcomes: Array<{ outcome: string; count: number }> }>(
      '/admin/analytics/outcomes',
      { cookies },
    );

    const advice = response.body.data!.outcomes.find((row) => row.outcome === 'ADVICE_ONLY');
    expect(advice?.count).toBe(2);
  });
});

// ---------------------------------------------------------------------------

describe('operational analytics', () => {
  it('counts consultations by how they ended', async () => {
    await completedConsultation();
    await completedConsultation();

    const cookies = await adminCookies();
    const response = await request<{
      consultations: { created: number; completed: number; completionRate: number | null };
      consultationMinutes: { median: number | null };
    }>('/admin/analytics/operational', { cookies });

    expect(response.body.data!.consultations.created).toBe(2);
    expect(response.body.data!.consultations.completed).toBe(2);
    expect(response.body.data!.consultationMinutes.median).toBe(5);
  });

  /**
   * Null, not zero.
   *
   * "No consultations were paid for" and "none of the paid ones completed" are
   * different statements, and a dashboard showing 0% for the first would be
   * reporting a failure that did not happen.
   */
  it('reports a null completion rate when nothing was paid for', async () => {
    const cookies = await adminCookies();
    const response = await request<{ consultations: { completionRate: number | null } }>(
      '/admin/analytics/operational',
      { cookies },
    );

    expect(response.body.data!.consultations.completionRate).toBeNull();
  });

  it('is closed to a pharmacy', async () => {
    const prisma = getPrisma();
    const pharmacy = await createTestPharmacy('Nosy Analytics', 'ACTIVE');
    const user = await createTestUser({
      email: 'pharmacy@analytics.test',
      password: 'PharmacyPassword123!',
      role: 'PHARMACY',
    });
    await prisma.pharmacyUser.create({ data: { pharmacyId: pharmacy.id, userId: user.id } });
    const cookies = await signIn('pharmacy@analytics.test', 'PharmacyPassword123!');

    expect((await request('/admin/analytics/operational', { cookies })).status).toBe(403);
    expect((await request('/admin/analytics/financial', { cookies })).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------

describe('financial analytics', () => {
  it('splits exactly and reports refunds separately rather than netting them off', async () => {
    const prisma = getPrisma();
    await completedConsultation();
    const second = await completedConsultation();

    // Refund the second, as `decideRefund` does.
    await prisma.revenueAllocation.updateMany({
      where: { consultationId: second.consultation.id },
      data: { reversedAt: new Date() },
    });

    const cookies = await adminCookies();
    const response = await request<{
      netMinor: number;
      pharmacyShareMinor: number;
      neemShareMinor: number;
      paidConsultations: number;
      reversedAllocations: number;
    }>('/admin/analytics/financial', { cookies });

    const data = response.body.data!;

    // Only the un-reversed allocation counts.
    expect(data.paidConsultations).toBe(1);
    expect(data.reversedAllocations).toBe(1);
    expect(data.netMinor).toBe(4000);
    expect(data.pharmacyShareMinor + data.neemShareMinor).toBe(data.netMinor);
  });
});

// ---------------------------------------------------------------------------

describe('the settings console (spec §96)', () => {
  it('lists settings with whether each needs a reason', async () => {
    const cookies = await adminCookies();

    const response = await request<
      Array<{ key: string; requiresConfirm: boolean; category: string }>
    >('/admin/settings', { cookies });

    expect(response.status).toBe(200);
    expect(response.body.data!.length).toBeGreaterThan(0);

    const revenue = response.body.data!.find((row) => row.key === 'revenue.pharmacySharePctBp');
    expect(revenue?.requiresConfirm).toBe(true);
  });

  /**
   * The rule §96 exists for.
   *
   * A revenue split changed with no explanation is one nobody can account for
   * afterwards, so the service refuses it — and refuses it whether or not a
   * screen remembered to ask.
   */
  it('refuses a sensitive change with no reason', async () => {
    const cookies = await adminCookies();

    const response = await request('/admin/settings/revenue.pharmacySharePctBp', {
      method: 'PATCH',
      cookies,
      payload: { value: 4000 },
    });

    expect(response.status).toBe(422);
  });

  it('accepts it with one, and records what it was', async () => {
    const cookies = await adminCookies();

    const response = await request('/admin/settings/revenue.pharmacySharePctBp', {
      method: 'PATCH',
      cookies,
      payload: { value: 4000, reason: 'Agreed uplift for the Accra pilot.' },
    });
    expect(response.status).toBe(200);

    const history = await request<
      Array<{ oldValue: unknown; newValue: unknown; reason: string | null }>
    >('/admin/settings/revenue.pharmacySharePctBp/history', { cookies });

    expect(history.body.data![0]).toMatchObject({
      oldValue: 3000,
      newValue: 4000,
      reason: 'Agreed uplift for the Accra pilot.',
    });
  });

  it('refuses a key that does not exist', async () => {
    const cookies = await adminCookies();

    const response = await request('/admin/settings/not.a.real.setting', {
      method: 'PATCH',
      cookies,
      payload: { value: 1 },
    });

    expect(response.status).toBe(400);
  });

  it('is closed to a doctor', async () => {
    await createTestUser({
      email: 'doctor@analytics.test',
      password: 'DoctorPassword123!',
      role: 'DOCTOR',
    });
    const cookies = await signIn('doctor@analytics.test', 'DoctorPassword123!');

    expect((await request('/admin/settings', { cookies })).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------

describe('complaints and quality review (spec §51, §52, §55)', () => {
  /** A complaint, created the way a patient's feedback creates one. */
  async function openComplaint() {
    const prisma = getPrisma();
    const { consultation } = await completedConsultation();

    const category = await prisma.complaintCategory.findFirstOrThrow({
      where: { code: 'WAIT_TIME' },
    });

    return prisma.complaint.create({
      data: {
        publicId: generatePublicId('cmp'),
        consultationId: consultation.id,
        categoryId: category.id,
        descriptionEnc: encryptField('The wait was very long and nobody explained why.'),
        state: 'OPEN',
      },
    });
  }

  it('lists open complaints with the consultation context', async () => {
    await openComplaint();

    const cookies = await adminCookies();
    const response = await request<
      Array<{ state: string; categoryLabel: string; consultationReference: string | null }>
    >('/admin/complaints?openOnly=true', { cookies });

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data![0]!.state).toBe('OPEN');
    expect(response.body.data![0]!.consultationReference).toBeTruthy();
  });

  /**
   * A complaint closed with no explanation cannot be answered to the person
   * who raised it, and "dismissed" without a reason is indistinguishable from
   * ignored.
   */
  it('refuses to close a complaint without saying what was decided', async () => {
    const complaint = await openComplaint();
    const cookies = await adminCookies();

    for (const state of ['RESOLVED', 'DISMISSED']) {
      const response = await request(`/admin/complaints/${complaint.publicId}/decide`, {
        method: 'POST',
        cookies,
        payload: { state },
      });

      expect(response.status, state).toBe(422);
    }
  });

  it('records the outcome when it is closed', async () => {
    const complaint = await openComplaint();
    const cookies = await adminCookies();

    const response = await request<{ state: string }>(
      `/admin/complaints/${complaint.publicId}/decide`,
      {
        method: 'POST',
        cookies,
        payload: { state: 'RESOLVED', note: 'Apologised; the queue was starved that evening.' },
      },
    );

    expect(response.body.data?.state).toBe('RESOLVED');

    const after = await getPrisma().complaint.findUniqueOrThrow({ where: { id: complaint.id } });
    // Stored encrypted (spec §58), so the assertion goes through the same
    // decryption the admin screen does rather than reading the column raw.
    expect(after.resolutionNoteEnc).not.toBeNull();
    expect(decryptField(after.resolutionNoteEnc!)).toContain('Apologised');
    expect(after.resolvedAt).not.toBeNull();
  });

  it('refuses a second decision on a closed complaint', async () => {
    const complaint = await openComplaint();
    const cookies = await adminCookies();

    const decide = () =>
      request(`/admin/complaints/${complaint.publicId}/decide`, {
        method: 'POST',
        cookies,
        payload: { state: 'RESOLVED', note: 'Handled.' },
      });

    expect((await decide()).status).toBe(200);
    expect((await decide()).status).toBe(409);
  });

  /** A complaint is never deleted — there is no route for it. */
  it('offers no way to delete a complaint', async () => {
    const complaint = await openComplaint();
    const cookies = await adminCookies();

    const response = await request(`/admin/complaints/${complaint.publicId}`, {
      method: 'DELETE',
      cookies,
    });

    expect(response.status).toBe(404);
  });

  it('shows the quality board with the breakdown behind each score', async () => {
    const cookies = await adminCookies();

    const response = await request<
      Array<{ fullName: string; score: number | null; breakdown: unknown }>
    >('/admin/quality', { cookies });

    expect(response.status).toBe(200);
  });

  /**
   * The rule that matters most in this area.
   *
   * A doctor never sees their score or the ratings behind it — a score a
   * clinician can watch becomes a target they optimise rather than a signal
   * about care (spec §24, §52).
   */
  it('is closed to a doctor, both the board and the complaints', async () => {
    await createTestUser({
      email: 'doctor@quality.test',
      password: 'DoctorPassword123!',
      role: 'DOCTOR',
    });
    const cookies = await signIn('doctor@quality.test', 'DoctorPassword123!');

    expect((await request('/admin/quality', { cookies })).status).toBe(403);
    expect((await request('/admin/complaints', { cookies })).status).toBe(403);
  });
});
