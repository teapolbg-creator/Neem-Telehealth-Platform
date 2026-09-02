import { authenticator } from 'otplib';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getPrisma, disconnectPrisma } from '../../src/db/prisma.ts';
import { closeTestApp, request, signIn } from '../helpers/app.ts';
import { createTestPharmacy, createTestUser, resetDatabase } from '../helpers/database.ts';
import { encryptTotpSecret } from '../../src/modules/auth/totp.service.ts';
import {
  MockPaymentProvider,
  setPaymentProviderForTesting,
} from '../../src/adapters/payment/index.ts';
import { transition } from '../../src/modules/consultation/consultation.service.ts';

/**
 * Refunds end to end (spec §41, §80 scenario 16, docs/payment-flow.md §7).
 *
 * The property under test throughout is that **no refund happens without an
 * administrator**. There is no timer, no state machine and no client action
 * anywhere in the system that returns money on its own, and several of these
 * assert the absence of such a path rather than the presence of a feature.
 */

const PHARMACY = { email: 'pharmacy@refund.test', password: 'PharmacyPassword123!' };
const ADMIN = { email: 'admin@refund.test', password: 'AdminPassword123!' };

async function setUpPharmacy() {
  const prisma = getPrisma();
  const pharmacy = await createTestPharmacy('Refund Pharmacy', 'ACTIVE');
  const user = await createTestUser({ ...PHARMACY, role: 'PHARMACY' });
  await prisma.pharmacyUser.create({ data: { pharmacyId: pharmacy.id, userId: user.id } });

  return { pharmacy, cookies: await signIn(PHARMACY.email, PHARMACY.password) };
}

/** An administrator, signed in through the mandatory 2FA path (spec §59). */
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
    payload: {
      challengeId: login.body.data!.challengeId,
      code: authenticator.generate(secret),
    },
  });

  return verify.cookies;
}

/** A paid consultation, sitting at ACTIVATED. */
async function paidConsultation(cookies: Record<string, string>) {
  const created = await request<{ publicId: string }>('/pharmacy/consultations', {
    method: 'POST',
    cookies,
    payload: {},
  });
  const publicId = created.body.data!.publicId;

  await request(`/pharmacy/consultations/${publicId}/payment`, {
    method: 'POST',
    cookies,
    payload: {},
  });
  await request(`/pharmacy/consultations/${publicId}/payment/simulate`, {
    method: 'POST',
    cookies,
    payload: { outcome: 'SUCCESS' },
  });

  const consultation = await getPrisma().consultation.findUniqueOrThrow({ where: { publicId } });
  return { publicId, consultation };
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

describe('requesting a refund', () => {
  it('records the request and holds the consultation', async () => {
    const { cookies } = await setUpPharmacy();
    const { publicId } = await paidConsultation(cookies);

    const response = await request<{ publicId: string; state: string; consultationState: string }>(
      `/pharmacy/consultations/${publicId}/refund-request`,
      { method: 'POST', cookies, payload: { reason: 'No doctor was available for 40 minutes.' } },
    );

    expect(response.status).toBe(201);
    expect(response.body.data?.state).toBe('REQUESTED');
    expect(response.body.data?.consultationState).toBe('REFUND_REQUESTED');
  });

  /**
   * The case the state machine forbade until Phase 7.
   *
   * A consultation that expires after payment is the clearest refund there is:
   * money taken, nothing delivered. Requesting one was impossible, so the fee
   * had no route back at all.
   */
  it('accepts a request against a consultation that already expired', async () => {
    const { cookies } = await setUpPharmacy();
    const { publicId, consultation } = await paidConsultation(cookies);

    await transition(consultation.id, 'EXPIRED', { actorType: 'SYSTEM', reason: 'window lapsed' });

    const response = await request<{ state: string }>(
      `/pharmacy/consultations/${publicId}/refund-request`,
      { method: 'POST', cookies, payload: { reason: 'The code expired before we could scan it.' } },
    );

    expect(response.status).toBe(201);
    expect(response.body.data?.state).toBe('REQUESTED');
  });

  it('refuses when no payment was taken', async () => {
    const { cookies } = await setUpPharmacy();
    const created = await request<{ publicId: string }>('/pharmacy/consultations', {
      method: 'POST',
      cookies,
      payload: {},
    });

    const response = await request(
      `/pharmacy/consultations/${created.body.data!.publicId}/refund-request`,
      { method: 'POST', cookies, payload: { reason: 'Nothing was ever paid.' } },
    );

    expect(response.status).toBe(422);
  });

  it('refuses a second open request for the same consultation', async () => {
    const { cookies } = await setUpPharmacy();
    const { publicId } = await paidConsultation(cookies);

    await request(`/pharmacy/consultations/${publicId}/refund-request`, {
      method: 'POST',
      cookies,
      payload: { reason: 'First request.' },
    });
    const second = await request(`/pharmacy/consultations/${publicId}/refund-request`, {
      method: 'POST',
      cookies,
      payload: { reason: 'Second request.' },
    });

    expect(second.status).toBe(409);
  });

  it('will not let one pharmacy request against another’s consultation', async () => {
    const { cookies } = await setUpPharmacy();
    const { publicId } = await paidConsultation(cookies);

    const prisma = getPrisma();
    const other = await createTestPharmacy('Other Pharmacy', 'ACTIVE');
    const otherUser = await createTestUser({
      email: 'other@refund.test',
      password: 'OtherPassword123!',
      role: 'PHARMACY',
    });
    await prisma.pharmacyUser.create({ data: { pharmacyId: other.id, userId: otherUser.id } });
    const otherCookies = await signIn('other@refund.test', 'OtherPassword123!');

    const response = await request(`/pharmacy/consultations/${publicId}/refund-request`, {
      method: 'POST',
      cookies: otherCookies,
      payload: { reason: 'Not mine to ask about.' },
    });

    // 404, not 403 — the existence of another pharmacy's consultation is not
    // confirmed (spec §102, decision D13).
    expect(response.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------

describe('deciding a refund (scenario 16)', () => {
  it('approves, refunds, reverses the revenue and ends the consultation', async () => {
    const { cookies } = await setUpPharmacy();
    const { publicId, consultation } = await paidConsultation(cookies);

    const allocationBefore = await getPrisma().revenueAllocation.findUniqueOrThrow({
      where: { consultationId: consultation.id },
    });
    expect(allocationBefore.reversedAt).toBeNull();

    const requested = await request<{ publicId: string }>(
      `/pharmacy/consultations/${publicId}/refund-request`,
      { method: 'POST', cookies, payload: { reason: 'No doctor was available.' } },
    );

    const admin = await adminCookies();
    const decided = await request<{ state: string; consultationState: string }>(
      `/admin/refunds/${requested.body.data!.publicId}/decide`,
      { method: 'POST', cookies: admin, payload: { approve: true, note: 'Nobody was available.' } },
    );

    expect(decided.status).toBe(200);
    expect(decided.body.data?.consultationState).toBe('REFUNDED');

    /**
     * Reversed, not deleted.
     *
     * The ledger stays additive: a payout already calculated from this
     * allocation must remain explainable after the refund.
     */
    const allocationAfter = await getPrisma().revenueAllocation.findUniqueOrThrow({
      where: { consultationId: consultation.id },
    });
    expect(allocationAfter.reversedAt).not.toBeNull();
    expect(allocationAfter.pharmacyShareMinor).toBe(allocationBefore.pharmacyShareMinor);
  });

  it('restores the consultation exactly where it was when declined', async () => {
    const { cookies } = await setUpPharmacy();
    const { publicId, consultation } = await paidConsultation(cookies);
    const before = consultation.state;

    const requested = await request<{ publicId: string }>(
      `/pharmacy/consultations/${publicId}/refund-request`,
      { method: 'POST', cookies, payload: { reason: 'Changed our mind.' } },
    );

    const admin = await adminCookies();
    const decided = await request<{ state: string; consultationState: string }>(
      `/admin/refunds/${requested.body.data!.publicId}/decide`,
      {
        method: 'POST',
        cookies: admin,
        payload: { approve: false, note: 'The consultation is still available to use.' },
      },
    );

    expect(decided.body.data?.state).toBe('REJECTED');
    expect(decided.body.data?.consultationState).toBe(before);

    // And the revenue was never touched.
    const allocation = await getPrisma().revenueAllocation.findUniqueOrThrow({
      where: { consultationId: consultation.id },
    });
    expect(allocation.reversedAt).toBeNull();
  });

  it('requires a reason for either answer', async () => {
    const { cookies } = await setUpPharmacy();
    const { publicId } = await paidConsultation(cookies);
    const requested = await request<{ publicId: string }>(
      `/pharmacy/consultations/${publicId}/refund-request`,
      { method: 'POST', cookies, payload: { reason: 'Please refund.' } },
    );

    const admin = await adminCookies();
    const response = await request(`/admin/refunds/${requested.body.data!.publicId}/decide`, {
      method: 'POST',
      cookies: admin,
      payload: { approve: true },
    });

    expect(response.status).toBe(400);
  });

  it('refuses a second decision on the same refund', async () => {
    const { cookies } = await setUpPharmacy();
    const { publicId } = await paidConsultation(cookies);
    const requested = await request<{ publicId: string }>(
      `/pharmacy/consultations/${publicId}/refund-request`,
      { method: 'POST', cookies, payload: { reason: 'Please refund.' } },
    );

    const admin = await adminCookies();
    const decide = () =>
      request(`/admin/refunds/${requested.body.data!.publicId}/decide`, {
        method: 'POST',
        cookies: admin,
        payload: { approve: true, note: 'Approved.' },
      });

    expect((await decide()).status).toBe(200);
    expect((await decide()).status).toBe(409);
  });

  it('is closed to a pharmacy', async () => {
    const { cookies } = await setUpPharmacy();
    const { publicId } = await paidConsultation(cookies);
    const requested = await request<{ publicId: string }>(
      `/pharmacy/consultations/${publicId}/refund-request`,
      { method: 'POST', cookies, payload: { reason: 'Please refund.' } },
    );

    // The pharmacy may ask. It may not decide (spec §41).
    const response = await request(`/admin/refunds/${requested.body.data!.publicId}/decide`, {
      method: 'POST',
      cookies,
      payload: { approve: true, note: 'Approving my own request.' },
    });

    expect(response.status).toBe(403);
  });

  it('does not let a pharmacy read the refund queue', async () => {
    const { cookies } = await setUpPharmacy();

    expect((await request('/admin/refunds', { cookies })).status).toBe(403);
  });
});
