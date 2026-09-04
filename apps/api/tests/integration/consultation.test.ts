import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { getPrisma, disconnectPrisma } from '../../src/db/prisma.ts';
import { closeTestApp, request, signIn } from '../helpers/app.ts';
import { createTestPharmacy, createTestUser, resetDatabase } from '../helpers/database.ts';
import {
  MockPaymentProvider,
  getPaymentProvider,
  setPaymentProviderForTesting,
} from '../../src/adapters/payment/index.ts';
import { expirePendingPayments } from '../../src/modules/payment/payment.service.ts';
import { fixedClock } from '../../src/lib/clock.ts';

/**
 * The consultation engine, end to end against a real database
 * (spec §10, §34, §35, §68, §102).
 */

const PHARMACY = { email: 'pharmacy@test.local', password: 'PharmacyPassword123!' };
const OTHER_PHARMACY = { email: 'other@test.local', password: 'OtherPassword123!' };

/** Creates an ACTIVE pharmacy with a signed-in account, and returns its cookies. */
async function setUpPharmacy(credentials: { email: string; password: string }, name: string) {
  const prisma = getPrisma();
  const pharmacy = await createTestPharmacy(name, 'ACTIVE');
  const user = await createTestUser({ ...credentials, role: 'PHARMACY' });
  await prisma.pharmacyUser.create({ data: { pharmacyId: pharmacy.id, userId: user.id } });

  return { pharmacy, cookies: await signIn(credentials.email, credentials.password) };
}

/** Walks a consultation from creation to ACTIVATED with a settled mock payment. */
async function payFor(publicId: string, cookies: Record<string, string>) {
  const initiated = await request<{ providerReference: string }>(
    `/pharmacy/consultations/${publicId}/payment`,
    { method: 'POST', cookies, payload: {} },
  );
  expect(initiated.status).toBe(200);

  const settled = await request<{ status: string; consultationState: string }>(
    `/pharmacy/consultations/${publicId}/payment/simulate`,
    { method: 'POST', cookies, payload: { outcome: 'SUCCESS' } },
  );
  expect(settled.status).toBe(200);
  return settled;
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

describe('creating a consultation', () => {
  it('starts in PENDING_PAYMENT and prices from settings, not a literal', async () => {
    const { cookies } = await setUpPharmacy(PHARMACY, 'Test Pharmacy');

    const response = await request<{
      publicId: string;
      state: string;
      net: { amountMinor: number; currency: string };
      secondsRemaining: number;
    }>('/pharmacy/consultations', { method: 'POST', cookies, payload: {} });

    expect(response.status).toBe(201);
    expect(response.body.data?.state).toBe('PENDING_PAYMENT');
    // The seeded default is GH₵40.00 — read from system_settings (spec §38).
    expect(response.body.data?.net).toEqual({ amountMinor: 4000, currency: 'GHS' });
    expect(response.body.data?.secondsRemaining).toBeGreaterThan(0);
  });

  it('records no patient details at the counter (finding C2)', async () => {
    const { cookies } = await setUpPharmacy(PHARMACY, 'Test Pharmacy');
    await request('/pharmacy/consultations', { method: 'POST', cookies, payload: {} });

    // Identity is captured on the patient's own phone, so no session row yet.
    expect(await getPrisma().patientSession.count()).toBe(0);
  });

  it('refuses a pharmacy that is not ACTIVE (spec §84)', async () => {
    const prisma = getPrisma();
    const pharmacy = await createTestPharmacy('Pending Pharmacy', 'PENDING');
    const user = await createTestUser({ ...PHARMACY, role: 'PHARMACY' });
    await prisma.pharmacyUser.create({ data: { pharmacyId: pharmacy.id, userId: user.id } });
    const cookies = await signIn(PHARMACY.email, PHARMACY.password);

    const response = await request('/pharmacy/consultations', {
      method: 'POST',
      cookies,
      payload: {},
    });

    expect(response.status).toBe(422);
    expect(response.body.error?.message).toMatch(/cannot start consultations/i);
  });

  it('writes an immutable state event for the creation', async () => {
    const { cookies } = await setUpPharmacy(PHARMACY, 'Test Pharmacy');
    await request('/pharmacy/consultations', { method: 'POST', cookies, payload: {} });

    const events = await getPrisma().consultationStateEvent.findMany();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      fromState: null,
      toState: 'PENDING_PAYMENT',
      accepted: true,
    });
  });
});

describe('payment', () => {
  it('does not activate a consultation until the provider confirms', async () => {
    const { cookies } = await setUpPharmacy(PHARMACY, 'Test Pharmacy');
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

    // Initiating is not paying. The mock provider leaves it PENDING, exactly as
    // a real provider would until the payer completes.
    const status = await request<{ consultationState: string }>(
      `/pharmacy/consultations/${publicId}/payment`,
      { cookies },
    );
    expect(status.body.data?.consultationState).toBe('PAYMENT_PROCESSING');
    expect(await getPrisma().consultationAccessToken.count()).toBe(0);
  });

  it('activates, and mints the access token when the QR is requested', async () => {
    const { cookies } = await setUpPharmacy(PHARMACY, 'Test Pharmacy');
    const created = await request<{ publicId: string }>('/pharmacy/consultations', {
      method: 'POST',
      cookies,
      payload: {},
    });
    const publicId = created.body.data!.publicId;

    const settled = await payFor(publicId, cookies);
    expect(settled.body.data?.consultationState).toBe('ACTIVATED');

    // No token yet: it is minted when the pharmacy asks for the QR, because
    // that is the only moment the code can actually be rendered.
    expect(await getPrisma().consultationAccessToken.count()).toBe(0);

    const qr = await request(`/pharmacy/consultations/${publicId}/qr`, {
      method: 'POST',
      cookies,
      payload: {},
    });
    expect(qr.status).toBe(200);
    expect(await getPrisma().consultationAccessToken.count()).toBe(1);
  });

  it('allocates revenue exactly once, at the configured split', async () => {
    const { cookies } = await setUpPharmacy(PHARMACY, 'Test Pharmacy');
    const created = await request<{ publicId: string }>('/pharmacy/consultations', {
      method: 'POST',
      cookies,
      payload: {},
    });
    await payFor(created.body.data!.publicId, cookies);

    const allocations = await getPrisma().revenueAllocation.findMany();
    expect(allocations).toHaveLength(1);
    // 30% of GH₵40.00, with the remainder to Neem (spec §39).
    expect(allocations[0]).toMatchObject({
      netMinor: 4000,
      pharmacySharePctBp: 3000,
      pharmacyShareMinor: 1200,
      neemShareMinor: 2800,
    });
  });

  it('is idempotent — settling twice does not double-count revenue (spec §103)', async () => {
    const { cookies } = await setUpPharmacy(PHARMACY, 'Test Pharmacy');
    const created = await request<{ publicId: string }>('/pharmacy/consultations', {
      method: 'POST',
      cookies,
      payload: {},
    });
    const publicId = created.body.data!.publicId;

    await payFor(publicId, cookies);
    // Poll the status endpoint repeatedly, which re-verifies each time.
    await request(`/pharmacy/consultations/${publicId}/payment`, { cookies });
    await request(`/pharmacy/consultations/${publicId}/payment`, { cookies });

    expect(await getPrisma().revenueAllocation.count()).toBe(1);
    expect(await getPrisma().payment.count()).toBe(1);
  });

  it('does not create a second charge when payment is initiated twice', async () => {
    const { cookies } = await setUpPharmacy(PHARMACY, 'Test Pharmacy');
    const created = await request<{ publicId: string }>('/pharmacy/consultations', {
      method: 'POST',
      cookies,
      payload: {},
    });
    const publicId = created.body.data!.publicId;

    const first = await request<{ providerReference: string }>(
      `/pharmacy/consultations/${publicId}/payment`,
      { method: 'POST', cookies, payload: {} },
    );
    const second = await request<{ providerReference: string }>(
      `/pharmacy/consultations/${publicId}/payment`,
      { method: 'POST', cookies, payload: {} },
    );

    expect(second.body.data?.providerReference).toBe(first.body.data?.providerReference);
    expect(await getPrisma().payment.count()).toBe(1);
  });

  it('allows a retry after a failure, and succeeds on the second attempt', async () => {
    const { cookies } = await setUpPharmacy(PHARMACY, 'Test Pharmacy');
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
      payload: { outcome: 'FAILED' },
    });

    const afterFailure = await request<{ consultationState: string; canRetry: boolean }>(
      `/pharmacy/consultations/${publicId}/payment`,
      { cookies },
    );
    expect(afterFailure.body.data?.consultationState).toBe('PAYMENT_FAILED');
    expect(afterFailure.body.data?.canRetry).toBe(true);

    const settled = await payFor(publicId, cookies);
    expect(settled.body.data?.consultationState).toBe('ACTIVATED');
  });
});

describe('the payment window (spec §35)', () => {
  it('expires an unpaid consultation and revokes its tokens', async () => {
    const { cookies } = await setUpPharmacy(PHARMACY, 'Test Pharmacy');
    const created = await request<{ publicId: string }>('/pharmacy/consultations', {
      method: 'POST',
      cookies,
      payload: {},
    });

    // Six minutes later, past the seeded 5-minute window.
    const later = fixedClock(new Date(Date.now() + 6 * 60 * 1000));
    const expired = await expirePendingPayments(getPrisma(), later);

    expect(expired).toBe(1);
    const consultation = await getPrisma().consultation.findUniqueOrThrow({
      where: { publicId: created.body.data!.publicId },
    });
    expect(consultation.state).toBe('EXPIRED');
  });

  it('never expires a consultation that was already paid', async () => {
    const { cookies } = await setUpPharmacy(PHARMACY, 'Test Pharmacy');
    const created = await request<{ publicId: string }>('/pharmacy/consultations', {
      method: 'POST',
      cookies,
      payload: {},
    });
    await payFor(created.body.data!.publicId, cookies);

    const later = fixedClock(new Date(Date.now() + 60 * 60 * 1000));
    expect(await expirePendingPayments(getPrisma(), later)).toBe(0);

    const consultation = await getPrisma().consultation.findUniqueOrThrow({
      where: { publicId: created.body.data!.publicId },
    });
    expect(consultation.state).toBe('ACTIVATED');
  });
});

describe('the QR access token (spec §10, §38)', () => {
  async function activatedConsultation() {
    const { pharmacy, cookies } = await setUpPharmacy(PHARMACY, 'Test Pharmacy');
    const created = await request<{ publicId: string }>('/pharmacy/consultations', {
      method: 'POST',
      cookies,
      payload: {},
    });
    const publicId = created.body.data!.publicId;
    await payFor(publicId, cookies);

    const qr = await request<{ qrDataUrl: string; url: string }>(
      `/pharmacy/consultations/${publicId}/qr`,
      { method: 'POST', cookies, payload: {} },
    );

    return { pharmacy, cookies, publicId, qr };
  }

  it('encodes only a URL — no patient data, no consultation id, no price', async () => {
    const { qr, publicId } = await activatedConsultation();
    const url = qr.body.data!.url;

    expect(url).toMatch(/\/s\/[A-Za-z0-9_-]+$/);
    expect(url).not.toContain(publicId);
    expect(url).not.toMatch(/name|age|phone|amount|price/i);
  });

  it('stores only a hash of the token, never the token itself', async () => {
    const { qr } = await activatedConsultation();
    const token = qr.body.data!.url.split('/s/')[1]!;

    const stored = await getPrisma().consultationAccessToken.findMany();
    for (const record of stored) {
      expect(record.tokenHash).not.toBe(token);
      expect(record.tokenHash).toHaveLength(64);
    }
    expect(stored.some((record) => record.tokenHash === sha256(token))).toBe(true);
  });

  it('can be exchanged once, and never again', async () => {
    const { qr } = await activatedConsultation();
    const token = qr.body.data!.url.split('/s/')[1]!;

    const first = await request<{ consultationPublicId: string }>('/s/exchange', {
      method: 'POST',
      payload: { token },
    });
    expect(first.status).toBe(200);
    expect(first.cookies.neem_patient).toBeTruthy();

    const reuse = await request('/s/exchange', { method: 'POST', payload: { token } });
    expect(reuse.status).toBe(404);
  });

  it('refuses an expired token', async () => {
    const { qr } = await activatedConsultation();
    const token = qr.body.data!.url.split('/s/')[1]!;

    await getPrisma().consultationAccessToken.updateMany({
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const response = await request('/s/exchange', { method: 'POST', payload: { token } });
    expect(response.status).toBe(404);
  });

  it('refuses a token that was never issued, with the same message as a used one', async () => {
    const { qr } = await activatedConsultation();
    const token = qr.body.data!.url.split('/s/')[1]!;

    await request('/s/exchange', { method: 'POST', payload: { token } });
    const used = await request('/s/exchange', { method: 'POST', payload: { token } });
    const unknown = await request('/s/exchange', {
      method: 'POST',
      payload: { token: 'a'.repeat(43) },
    });

    // Indistinguishable, so probing reveals nothing about which tokens exist.
    expect(used.status).toBe(unknown.status);
    expect(used.body.error?.message).toBe(unknown.body.error?.message);
  });

  it('revokes the previous token when a replacement is issued (decision D6)', async () => {
    const { publicId, cookies, qr } = await activatedConsultation();
    const firstToken = qr.body.data!.url.split('/s/')[1]!;

    const reissued = await request<{ url: string; sequence: number }>(
      `/pharmacy/consultations/${publicId}/qr`,
      { method: 'POST', cookies, payload: {} },
    );
    expect(reissued.body.data?.sequence).toBe(2);

    // The old code stops working the moment a new one is printed.
    const old = await request('/s/exchange', { method: 'POST', payload: { token: firstToken } });
    expect(old.status).toBe(404);

    const replacement = reissued.body.data!.url.split('/s/')[1]!;
    const exchanged = await request('/s/exchange', {
      method: 'POST',
      payload: { token: replacement },
    });
    expect(exchanged.status).toBe(200);
  });

  it('moves the consultation to WAITING_FOR_PATIENT on exchange', async () => {
    const { qr, publicId } = await activatedConsultation();
    const token = qr.body.data!.url.split('/s/')[1]!;

    await request('/s/exchange', { method: 'POST', payload: { token } });

    const consultation = await getPrisma().consultation.findUniqueOrThrow({ where: { publicId } });
    expect(consultation.state).toBe('WAITING_FOR_PATIENT');
  });
});

describe('the patient journey', () => {
  async function patientSession() {
    const { cookies } = await setUpPharmacy(PHARMACY, 'Test Pharmacy');
    const created = await request<{ publicId: string }>('/pharmacy/consultations', {
      method: 'POST',
      cookies,
      payload: {},
    });
    const publicId = created.body.data!.publicId;
    await payFor(publicId, cookies);

    const qr = await request<{ url: string }>(`/pharmacy/consultations/${publicId}/qr`, {
      method: 'POST',
      cookies,
      payload: {},
    });
    const token = qr.body.data!.url.split('/s/')[1]!;
    const exchange = await request('/s/exchange', { method: 'POST', payload: { token } });

    return { pharmacyCookies: cookies, publicId, patientCookies: exchange.cookies };
  }

  it('walks identity → language → mode and lands in the queue', async () => {
    const { patientCookies, publicId } = await patientSession();

    const start = await request<{ step: string }>('/patient/session', { cookies: patientCookies });
    expect(start.body.data?.step).toBe('IDENTITY');

    const identity = await request<{ step: string }>('/patient/session/identity', {
      method: 'POST',
      cookies: patientCookies,
      payload: {
        fullName: 'Efua Mensah',
        age: 34,
        sex: 'FEMALE',
        phone: '0240000000',
        paymentPhone: '0550000000',
      },
    });
    expect(identity.body.data?.step).toBe('LANGUAGE');

    const language = await request<{ step: string }>('/patient/session/language', {
      method: 'POST',
      cookies: patientCookies,
      payload: { languageCode: 'tw' },
    });
    expect(language.body.data?.step).toBe('MODE');

    const mode = await request<{ step: string; state: string }>('/patient/session/mode', {
      method: 'POST',
      cookies: patientCookies,
      payload: { type: 'VIDEO' },
    });
    expect(mode.body.data?.step).toBe('WAITING');
    expect(mode.body.data?.state).toBe('WAITING_FOR_DOCTOR');

    // And a queue entry now exists for Phase 4's allocation engine.
    const queue = await getPrisma().consultationQueueEntry.findMany();
    expect(queue).toHaveLength(1);
    expect(queue[0]?.state).toBe('WAITING');
    expect(publicId).toBeTruthy();
  });

  it('encrypts the patient name and phone at rest', async () => {
    const { patientCookies } = await patientSession();

    await request('/patient/session/identity', {
      method: 'POST',
      cookies: patientCookies,
      payload: { fullName: 'Efua Mensah', age: 34, sex: 'FEMALE', phone: '0240000000' },
    });

    const session = await getPrisma().patientSession.findFirstOrThrow();
    expect(session.fullNameEnc).not.toContain('Efua');
    expect(session.fullNameEnc).toMatch(/^v1\./);
    expect(session.phoneEnc).not.toContain('0240000000');
  });

  it('refuses a language that is not active for the MVP', async () => {
    const { patientCookies } = await patientSession();
    await request('/patient/session/identity', {
      method: 'POST',
      cookies: patientCookies,
      payload: { fullName: 'Efua Mensah', age: 34, sex: 'FEMALE', phone: '0240000000' },
    });

    // Ewe is seeded but inactive (decision D9).
    const response = await request('/patient/session/language', {
      method: 'POST',
      cookies: patientCookies,
      payload: { languageCode: 'ee' },
    });
    expect(response.status).toBe(400);
  });

  it('will not let the patient skip ahead to choosing a mode', async () => {
    const { patientCookies } = await patientSession();

    const response = await request('/patient/session/mode', {
      method: 'POST',
      cookies: patientCookies,
      payload: { type: 'VIDEO' },
    });
    expect(response.status).toBe(422);
  });

  it('refuses a forged patient session cookie', async () => {
    const response = await request('/patient/session', {
      cookies: { neem_patient: 'not-a-real-session' },
    });
    expect(response.status).toBe(401);
  });

  it('shows the patient no queue mechanics or doctor performance data (spec §72)', async () => {
    const { patientCookies } = await patientSession();
    const view = await request('/patient/session', { cookies: patientCookies });

    const serialised = JSON.stringify(view.body.data);
    expect(serialised).not.toMatch(/score|rating|position|queueDepth|workload/i);
  });
});

describe('cross-pharmacy isolation (spec §102)', () => {
  it('hides one pharmacy’s consultation from another', async () => {
    const { cookies: ownerCookies } = await setUpPharmacy(PHARMACY, 'Owner Pharmacy');
    const created = await request<{ publicId: string }>('/pharmacy/consultations', {
      method: 'POST',
      cookies: ownerCookies,
      payload: {},
    });
    const publicId = created.body.data!.publicId;

    const { cookies: otherCookies } = await setUpPharmacy(OTHER_PHARMACY, 'Other Pharmacy');

    // 404, not 403 — confirming it exists would itself be a disclosure.
    const read = await request(`/pharmacy/consultations/${publicId}`, { cookies: otherCookies });
    expect(read.status).toBe(404);

    const qr = await request(`/pharmacy/consultations/${publicId}/qr`, {
      method: 'POST',
      cookies: otherCookies,
      payload: {},
    });
    expect(qr.status).toBe(404);

    const cancel = await request(`/pharmacy/consultations/${publicId}/cancel`, {
      method: 'POST',
      cookies: otherCookies,
      payload: { reason: 'Attempting to cancel someone else’s consultation' },
    });
    expect(cancel.status).toBe(404);
  });

  it('shows the patient panel only to the owning pharmacy, and only while live', async () => {
    const { cookies } = await setUpPharmacy(PHARMACY, 'Owner Pharmacy');
    const created = await request<{ publicId: string }>('/pharmacy/consultations', {
      method: 'POST',
      cookies,
      payload: {},
    });
    const publicId = created.body.data!.publicId;
    await payFor(publicId, cookies);

    const qr = await request<{ url: string }>(`/pharmacy/consultations/${publicId}/qr`, {
      method: 'POST',
      cookies,
      payload: {},
    });
    const token = qr.body.data!.url.split('/s/')[1]!;
    const exchange = await request('/s/exchange', { method: 'POST', payload: { token } });

    await request('/patient/session/identity', {
      method: 'POST',
      cookies: exchange.cookies,
      payload: { fullName: 'Efua Mensah', age: 34, sex: 'FEMALE', phone: '0240000000' },
    });

    const view = await request<{ patient: { fullName: string; phone: string } | null }>(
      `/pharmacy/consultations/${publicId}`,
      { cookies },
    );

    // The four permitted fields, decrypted for display (spec §18).
    expect(view.body.data?.patient).toMatchObject({
      fullName: 'Efua Mensah',
      age: 34,
      sex: 'FEMALE',
    });

    // And never any clinical content.
    expect(JSON.stringify(view.body.data)).not.toMatch(/notes|diagnosis|treatment/i);
  });
});

describe('cancellation', () => {
  it('flags that a refund is owed when a paid consultation is cancelled (spec §37)', async () => {
    const { cookies } = await setUpPharmacy(PHARMACY, 'Test Pharmacy');
    const created = await request<{ publicId: string }>('/pharmacy/consultations', {
      method: 'POST',
      cookies,
      payload: {},
    });
    const publicId = created.body.data!.publicId;
    await payFor(publicId, cookies);

    const response = await request<{ refundOwed: boolean; message: string }>(
      `/pharmacy/consultations/${publicId}/cancel`,
      { method: 'POST', cookies, payload: { reason: 'Patient left the pharmacy' } },
    );

    expect(response.status).toBe(200);
    expect(response.body.data?.refundOwed).toBe(true);
    expect(response.body.data?.message).toMatch(/refund request has been raised/i);
  });

  it('revokes outstanding access tokens on cancellation', async () => {
    const { cookies } = await setUpPharmacy(PHARMACY, 'Test Pharmacy');
    const created = await request<{ publicId: string }>('/pharmacy/consultations', {
      method: 'POST',
      cookies,
      payload: {},
    });
    const publicId = created.body.data!.publicId;
    await payFor(publicId, cookies);

    const qr = await request<{ url: string }>(`/pharmacy/consultations/${publicId}/qr`, {
      method: 'POST',
      cookies,
      payload: {},
    });
    const token = qr.body.data!.url.split('/s/')[1]!;

    await request(`/pharmacy/consultations/${publicId}/cancel`, {
      method: 'POST',
      cookies,
      payload: { reason: 'Patient left' },
    });

    const exchange = await request('/s/exchange', { method: 'POST', payload: { token } });
    expect(exchange.status).toBe(404);
  });
});

describe('webhooks (spec §68)', () => {
  it('rejects an unsigned payload', async () => {
    const response = await request('/webhooks/payment', {
      method: 'POST',
      payload: { event: 'charge.completed', data: { reference: 'mock_x', status: 'success' } },
    });

    expect(response.status).toBe(401);
  });

  it('rejects a payload with a wrong signature', async () => {
    const app = await (await import('../helpers/app.ts')).getTestApp();
    const body = JSON.stringify({ id: 'evt_1', data: { reference: 'mock_x', status: 'success' } });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/payment',
      headers: { 'content-type': 'application/json', 'x-neem-mock-signature': 'deadbeef' },
      payload: body,
    });

    expect(response.statusCode).toBe(401);
  });

  it('processes a signed webhook once and ignores the duplicate', async () => {
    const { cookies } = await setUpPharmacy(PHARMACY, 'Test Pharmacy');
    const created = await request<{ publicId: string }>('/pharmacy/consultations', {
      method: 'POST',
      cookies,
      payload: {},
    });
    const publicId = created.body.data!.publicId;

    const initiated = await request<{ providerReference: string }>(
      `/pharmacy/consultations/${publicId}/payment`,
      { method: 'POST', cookies, payload: {} },
    );
    const reference = initiated.body.data!.providerReference;

    const provider = getPaymentProvider() as MockPaymentProvider;
    provider.settle(reference, 'SUCCESS');

    const body = Buffer.from(
      JSON.stringify({
        id: 'evt_duplicate_test',
        event: 'charge.completed',
        data: { reference, status: 'success', amount: 4000, currency: 'GHS' },
      }),
    );
    const signature = provider.signWebhook(body);

    const app = await (await import('../helpers/app.ts')).getTestApp();
    const send = () =>
      app.inject({
        method: 'POST',
        url: '/api/v1/webhooks/payment',
        headers: { 'content-type': 'application/json', 'x-neem-mock-signature': signature },
        payload: body,
      });

    const first = await send();
    const second = await send();

    expect(first.statusCode).toBe(200);
    // A duplicate is acknowledged, not errored — an error would make the
    // provider retry, producing more duplicates.
    expect(second.statusCode).toBe(200);
    expect(second.json().data.processed).toBe(false);
    expect(second.json().data.reason).toBe('duplicate');

    // The critical assertion: revenue counted exactly once (spec §103).
    expect(await getPrisma().revenueAllocation.count()).toBe(1);
    expect(await getPrisma().paymentWebhookEvent.count()).toBe(1);
  });
});

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
