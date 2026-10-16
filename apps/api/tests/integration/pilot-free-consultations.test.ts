import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { disconnectPrisma, getPrisma } from '../../src/db/prisma.ts';
import { closeTestApp, request, signIn } from '../helpers/app.ts';
import {
  createTestPharmacy,
  createTestUser,
  resetDatabase,
  setConsultationFeesEnabled,
  setDirectChannelEnabled,
} from '../helpers/database.ts';
import {
  MockPaymentProvider,
  setPaymentProviderForTesting,
} from '../../src/adapters/payment/index.ts';
import { generatePublicId } from '../../src/lib/crypto.ts';
import { expirePendingPayments } from '../../src/modules/payment/payment.service.ts';
import { reconcilePayments } from '../../src/modules/payment/reconciliation.service.ts';
import { cancelConsultation } from '../../src/modules/consultation/consultation.service.ts';
import { financialSummary } from '../../src/modules/analytics/analytics.service.ts';
import { isConsultationFeeWaived } from '../../src/modules/payment/fee-waiver.service.ts';

/**
 * Month one of the pilot is free (D69).
 *
 * The thing being asserted throughout is not that a number is zero — it is
 * that **the payment provider is never spoken to**, and that everything built
 * on the assumption that a consultation was paid for still works when it was
 * given away instead.
 *
 * Modelled on `sms-off-for-pilot.test.ts`, including its last act: turn the
 * switch back on and prove the ordinary flow returns. That is what makes this
 * a switch rather than a deletion.
 */

const PHARMACY_PASSWORD = 'PharmacyPassword123!';

/**
 * The mock provider, with a tally.
 *
 * `MockPaymentProvider` records payments but not calls, and the fact under
 * test is whether it was called at all — a free consultation that still
 * reached Paystack would be refused there, because Paystack will not take a
 * zero-amount checkout.
 */
class CountingPaymentProvider extends MockPaymentProvider {
  initializeCalls = 0;
  verifyCalls = 0;

  override async initialize(...args: Parameters<MockPaymentProvider['initialize']>) {
    this.initializeCalls += 1;
    return super.initialize(...args);
  }

  override async verify(...args: Parameters<MockPaymentProvider['verify']>) {
    this.verifyCalls += 1;
    return super.verify(...args);
  }
}

/** A counter that can create consultations. */
async function counter() {
  const pharmacy = await createTestPharmacy(
    `Pharmacy ${generatePublicId('x').slice(-6)}`,
    'ACTIVE',
  );
  const user = await createTestUser({
    email: `${generatePublicId('x').slice(-8)}@pharmacy.test`,
    password: PHARMACY_PASSWORD,
    role: 'PHARMACY',
  });
  await getPrisma().pharmacyUser.create({ data: { pharmacyId: pharmacy.id, userId: user.id } });

  return { cookies: await signIn(user.email, PHARMACY_PASSWORD) };
}

describe('consultations at the pharmacy counter are free during the pilot', () => {
  let provider: CountingPaymentProvider;

  beforeEach(async () => {
    await resetDatabase();
    provider = new CountingPaymentProvider();
    setPaymentProviderForTesting(provider);
    await setConsultationFeesEnabled('COUNTER', false);
  });

  afterAll(async () => {
    setPaymentProviderForTesting(undefined);
    await closeTestApp();
    await disconnectPrisma();
  });

  it('activates a counter consultation without asking anyone for money', async () => {
    const { cookies } = await counter();

    const created = await request<{
      publicId: string;
      state: string;
      net: { amountMinor: number };
    }>('/pharmacy/consultations', { method: 'POST', cookies, payload: {} });

    expect(created.status).toBe(201);
    expect(created.body.data!.state).toBe('ACTIVATED');
    expect(created.body.data!.net.amountMinor).toBe(0);

    const consultation = await getPrisma().consultation.findUniqueOrThrow({
      where: { publicId: created.body.data!.publicId },
    });

    expect(consultation.feeWaivedReason).toBe('pilot_free');
    // What it would have cost. Zeroing this would destroy the comparison the
    // pilot exists to make.
    expect(consultation.priceMinor).toBeGreaterThan(0);
    expect(consultation.netMinor).toBe(0);
    // Nothing to pay by, so nothing for the expiry sweep to act on.
    expect(consultation.paymentDeadlineAt).toBeNull();
  });

  it('never calls the payment provider', async () => {
    const { cookies } = await counter();

    await request('/pharmacy/consultations', { method: 'POST', cookies, payload: {} });

    /*
     * The central assertion of the whole feature. A zero-amount checkout is
     * refused by Paystack, so a free consultation that still reached the
     * provider would fail in production and pass nowhere else.
     */
    expect(provider.initializeCalls).toBe(0);
    expect(provider.verifyCalls).toBe(0);
  });

  it('leaves one zero payment and one zero allocation, so the work is still on the ledger', async () => {
    const { cookies } = await counter();
    const created = await request<{ publicId: string }>('/pharmacy/consultations', {
      method: 'POST',
      cookies,
      payload: {},
    });

    const consultation = await getPrisma().consultation.findUniqueOrThrow({
      where: { publicId: created.body.data!.publicId },
      include: { payments: true, revenue: true },
    });

    expect(consultation.payments).toHaveLength(1);
    const payment = consultation.payments[0]!;
    expect(payment.amountMinor).toBe(0);
    expect(payment.status).toBe('SUCCESS');
    expect(payment.isWaived).toBe(true);
    expect(payment.provider).toBe('none');

    // Without this row there is no earning row either: both foreign keys are
    // NOT NULL, so a free month would leave no record of who did the work.
    expect(consultation.revenue).not.toBeNull();
    expect(consultation.revenue!.grossMinor).toBe(0);
  });

  it('reaches ACTIVATED through the ordinary state machine, not around it', async () => {
    const { cookies } = await counter();
    const created = await request<{ publicId: string }>('/pharmacy/consultations', {
      method: 'POST',
      cookies,
      payload: {},
    });

    const events = await getPrisma().consultationStateEvent.findMany({
      where: { consultation: { publicId: created.body.data!.publicId } },
      orderBy: { occurredAt: 'asc' },
      select: { toState: true, accepted: true },
    });

    expect(events.map((event) => event.toState)).toEqual([
      'PENDING_PAYMENT',
      'PAYMENT_PROCESSING',
      'PAID',
      'ACTIVATED',
    ]);
    expect(events.every((event) => event.accepted)).toBe(true);
  });

  it('refuses to take payment for one, so no other path can charge', async () => {
    const { cookies } = await counter();
    const created = await request<{ publicId: string }>('/pharmacy/consultations', {
      method: 'POST',
      cookies,
      payload: {},
    });

    const paid = await request(`/pharmacy/consultations/${created.body.data!.publicId}/payment`, {
      method: 'POST',
      cookies,
      payload: {},
    });

    expect(paid.status).toBeGreaterThanOrEqual(400);
    expect(provider.initializeCalls).toBe(0);
  });

  it('is not written off by the payment-expiry sweep', async () => {
    const { cookies } = await counter();
    await request('/pharmacy/consultations', { method: 'POST', cookies, payload: {} });

    expect(await expirePendingPayments()).toBe(0);
  });

  it('is not reported as drift by reconciliation', async () => {
    const { cookies } = await counter();
    await request('/pharmacy/consultations', { method: 'POST', cookies, payload: {} });

    const result = await reconcilePayments();

    // Its reference was minted here; there is nothing at the provider to check.
    expect(result.findings).toHaveLength(0);
    expect(provider.verifyCalls).toBe(0);
  });

  it('can still be cancelled, and records a refund of nothing rather than throwing', async () => {
    const { cookies } = await counter();
    const created = await request<{ publicId: string }>('/pharmacy/consultations', {
      method: 'POST',
      cookies,
      payload: {},
    });
    const consultation = await getPrisma().consultation.findUniqueOrThrow({
      where: { publicId: created.body.data!.publicId },
    });

    /*
     * `requestRefund` refuses a consultation with no successful payment. The
     * waived row is a successful payment, so this path needs no special case —
     * which is the whole reason it is written as a payment rather than as an
     * absence.
     */
    await expect(
      cancelConsultation(consultation.publicId, 'withdrawn by the counter', {
        actorType: 'PHARMACY',
      }),
    ).resolves.toBeDefined();

    const refunds = await getPrisma().refund.findMany({
      where: { consultationId: consultation.id },
    });
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.amountMinor).toBe(0);
  });

  it('is counted as free rather than as paid', async () => {
    const { cookies } = await counter();
    await request('/pharmacy/consultations', { method: 'POST', cookies, payload: {} });

    const summary = await financialSummary({
      from: new Date(Date.now() - 60_000),
      to: new Date(Date.now() + 60_000),
    });

    expect(summary.freeConsultations).toBe(1);
    expect(summary.paidConsultations).toBe(0);
  });

  describe('while the patient-direct journey still charges', () => {
    /*
     * The point of splitting the switch (D71). The counter is free to get
     * pharmacies using Neem; a patient booking on their own phone is not the
     * behaviour that free period is buying, and still pays.
     */
    it('waives the counter and nothing else', async () => {
      expect(await isConsultationFeeWaived('COUNTER')).toBe(true);
      expect(await isConsultationFeeWaived('DIRECT')).toBe(false);
    });

    it('still tells a patient booking for themselves that there is a price', async () => {
      await setDirectChannelEnabled(true);

      const clinics = await request<{ enabled: boolean; feesEnabled: boolean }>('/patient/clinics');

      /*
       * The public catalogue speaks for the patient-direct journey, which is
       * the only place it is shown. Reading the counter's setting here would
       * advertise "Free during the pilot" to a patient who is about to be
       * charged — the one wiring mistake this split makes possible.
       */
      expect(clinics.body.data!.feesEnabled).toBe(true);
    });

    it('charges a patient-direct booking while the counter is free', async () => {
      const service = await getPrisma().service.findFirstOrThrow({
        where: { isActive: true },
        select: { priceMinor: true },
      });

      // Nothing about the counter's free period touches the catalogue price.
      expect(service.priceMinor).toBeGreaterThan(0);
      expect(await isConsultationFeeWaived('DIRECT')).toBe(false);
    });
  });

  describe('and when fees are switched back on for month two', () => {
    it('charges again, with no code change', async () => {
      await setConsultationFeesEnabled('COUNTER', true);
      const { cookies } = await counter();

      const created = await request<{
        publicId: string;
        state: string;
        net: { amountMinor: number };
      }>('/pharmacy/consultations', { method: 'POST', cookies, payload: {} });

      expect(created.body.data!.state).toBe('PENDING_PAYMENT');
      expect(created.body.data!.net.amountMinor).toBeGreaterThan(0);

      const consultation = await getPrisma().consultation.findUniqueOrThrow({
        where: { publicId: created.body.data!.publicId },
      });
      expect(consultation.feeWaivedReason).toBeNull();
      expect(consultation.paymentDeadlineAt).not.toBeNull();

      await request(`/pharmacy/consultations/${created.body.data!.publicId}/payment`, {
        method: 'POST',
        cookies,
        payload: {},
      });
      expect(provider.initializeCalls).toBe(1);
    });

    it('leaves a consultation created while it was free still free, and still unchargeable', async () => {
      const { cookies } = await counter();
      const created = await request<{ publicId: string }>('/pharmacy/consultations', {
        method: 'POST',
        cookies,
        payload: {},
      });

      await setConsultationFeesEnabled('COUNTER', true);

      const consultation = await getPrisma().consultation.findUniqueOrThrow({
        where: { publicId: created.body.data!.publicId },
      });
      expect(consultation.feeWaivedReason).toBe('pilot_free');
      expect(consultation.netMinor).toBe(0);

      const paid = await request(`/pharmacy/consultations/${created.body.data!.publicId}/payment`, {
        method: 'POST',
        cookies,
        payload: {},
      });
      expect(paid.status).toBeGreaterThanOrEqual(400);
    });
  });
});
