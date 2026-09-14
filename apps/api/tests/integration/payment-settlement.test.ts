import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getPrisma, disconnectPrisma } from '../../src/db/prisma.ts';
import { closeTestApp, request, signIn } from '../helpers/app.ts';
import { createTestPharmacy, createTestUser, resetDatabase } from '../helpers/database.ts';
import {
  setPaymentProviderForTesting,
  type InitializePaymentInput,
  type InitializePaymentResult,
  type PaymentProvider,
  type RefundResult,
  type VerifiedPayment,
  type VerifiedPaymentStatus,
  type WebhookEvent,
} from '../../src/adapters/payment/index.ts';
import {
  expirePendingPayments,
  verifyAndSettle,
} from '../../src/modules/payment/payment.service.ts';
import { fixedClock } from '../../src/lib/clock.ts';

/**
 * Settling a payment the provider confirms late (D49).
 *
 * In production a patient paid by Mobile Money two minutes into a five-minute
 * window and the consultation expired anyway. Paystack had answered the first
 * check "abandoned" — its word for a checkout not completed yet — and Neem took
 * that as final, stopped asking, and let the expiry sweep close it without
 * asking either. These drive that sequence with a provider whose answers the
 * test controls.
 */

class ScriptedProvider implements PaymentProvider {
  readonly name = 'scripted';
  readonly isMock = true;

  status: VerifiedPaymentStatus = 'PENDING';
  unreachable = false;
  private amountMinor = 0;

  async initialize(input: InitializePaymentInput): Promise<InitializePaymentResult> {
    this.amountMinor = input.amountMinor;
    return {
      providerReference: `scripted_${input.reference}`,
      authorizationUrl: 'https://checkout.example.test/scripted',
    };
  }

  async verify(providerReference: string): Promise<VerifiedPayment> {
    if (this.unreachable) throw new Error('The payment provider could not be reached.');
    return {
      providerReference,
      status: this.status,
      amountMinor: this.amountMinor,
      currency: 'GHS',
      channel: 'mobile_money',
      paidAt: this.status === 'SUCCESS' ? new Date() : undefined,
      failureReason: this.status === 'SUCCESS' ? undefined : 'The transaction was not completed',
    };
  }

  parseWebhook(): WebhookEvent {
    throw new Error('not used');
  }

  async refund(): Promise<RefundResult> {
    throw new Error('not used');
  }
}

const PHARMACY = { email: 'pharmacy@settlement.test', password: 'PharmacyPassword123!' };
const MINUTE = 60 * 1000;

let provider: ScriptedProvider;

beforeEach(async () => {
  await resetDatabase();
  provider = new ScriptedProvider();
  setPaymentProviderForTesting(provider);
});

afterAll(async () => {
  setPaymentProviderForTesting(undefined);
  await closeTestApp();
  await disconnectPrisma();
});

/** A consultation with a payment started and not yet confirmed. */
async function consultationAwaitingPayment() {
  const prisma = getPrisma();
  const pharmacy = await createTestPharmacy('Settlement Pharmacy', 'ACTIVE');
  const user = await createTestUser({ ...PHARMACY, role: 'PHARMACY' });
  await prisma.pharmacyUser.create({ data: { pharmacyId: pharmacy.id, userId: user.id } });
  const cookies = await signIn(PHARMACY.email, PHARMACY.password);

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
  expect(initiated.status).toBe(200);

  return { publicId, cookies, reference: initiated.body.data!.providerReference };
}

async function stateOf(publicId: string) {
  return (await getPrisma().consultation.findUniqueOrThrow({ where: { publicId } })).state;
}

async function paymentFor(reference: string) {
  return getPrisma().payment.findUniqueOrThrow({ where: { providerReference: reference } });
}

describe('the pharmacy screen', () => {
  it('keeps checking a payment last reported abandoned, and activates it once paid', async () => {
    const { publicId, cookies, reference } = await consultationAwaitingPayment();

    provider.status = 'ABANDONED';
    const first = await request<{ consultationState: string; paymentStatus: string }>(
      `/pharmacy/consultations/${publicId}/payment`,
      { cookies },
    );
    expect(first.body.data?.consultationState).toBe('PAYMENT_PROCESSING');
    expect((await paymentFor(reference)).status).toBe('ABANDONED');

    provider.status = 'SUCCESS';
    const second = await request<{ consultationState: string }>(
      `/pharmacy/consultations/${publicId}/payment`,
      { cookies },
    );
    expect(second.body.data?.consultationState).toBe('ACTIVATED');
  });
});

describe('the payment window sweep', () => {
  it('activates instead of expiring when the provider says it was paid', async () => {
    const { publicId, reference } = await consultationAwaitingPayment();
    provider.status = 'SUCCESS';

    const later = fixedClock(new Date(Date.now() + 6 * MINUTE));
    expect(await expirePendingPayments(getPrisma(), later)).toBe(0);

    expect(await stateOf(publicId)).toBe('ACTIVATED');
    expect((await paymentFor(reference)).status).toBe('SUCCESS');
  });

  it('still expires when the provider says it was not paid', async () => {
    const { publicId, reference } = await consultationAwaitingPayment();
    provider.status = 'PENDING';

    const later = fixedClock(new Date(Date.now() + 6 * MINUTE));
    expect(await expirePendingPayments(getPrisma(), later)).toBe(1);

    expect(await stateOf(publicId)).toBe('EXPIRED');
    expect((await paymentFor(reference)).status).toBe('ABANDONED');
  });

  it('holds a consultation open while the provider cannot be asked, but not for ever', async () => {
    const { publicId } = await consultationAwaitingPayment();
    provider.unreachable = true;

    const shortlyAfter = fixedClock(new Date(Date.now() + 6 * MINUTE));
    expect(await expirePendingPayments(getPrisma(), shortlyAfter)).toBe(0);
    expect(await stateOf(publicId)).toBe('PAYMENT_PROCESSING');

    const muchLater = fixedClock(new Date(Date.now() + 2 * 60 * MINUTE));
    expect(await expirePendingPayments(getPrisma(), muchLater)).toBe(1);
    expect(await stateOf(publicId)).toBe('EXPIRED');
  });
});

describe('a payment confirmed after the consultation closed', () => {
  it('is recorded, does not revive the consultation, and asks an administrator to refund it', async () => {
    const { publicId, reference } = await consultationAwaitingPayment();

    const later = fixedClock(new Date(Date.now() + 6 * MINUTE));
    expect(await expirePendingPayments(getPrisma(), later)).toBe(1);

    // The patient's approval lands after the sweep — as a webhook or the
    // hourly reconciliation would then find it.
    provider.status = 'SUCCESS';
    const settled = await verifyAndSettle(reference, { actorType: 'SYSTEM' });

    expect(settled.status).toBe('SUCCESS');
    expect(settled.consultationState).toBe('REFUND_REQUESTED');

    const prisma = getPrisma();
    const payment = await paymentFor(reference);
    expect(payment.status).toBe('SUCCESS');

    const refunds = await prisma.refund.findMany({ where: { paymentId: payment.id } });
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ state: 'REQUESTED', requestedByType: 'SYSTEM' });

    // Nothing was delivered, so nothing is owed to the pharmacy.
    expect(await prisma.revenueAllocation.count({ where: { paymentId: payment.id } })).toBe(0);

    const anomaly = await prisma.auditLog.findFirst({
      where: { action: 'payment.anomaly', entityId: payment.id },
    });
    expect(anomaly?.metadata).toMatchObject({
      kind: 'PAID_AFTER_CLOSE',
      consultationState: 'EXPIRED',
    });

    // A second confirmation — a webhook replay, the next reconciliation — changes nothing.
    await verifyAndSettle(reference, { actorType: 'SYSTEM' });
    expect(await prisma.refund.count({ where: { paymentId: payment.id } })).toBe(1);
    expect(await stateOf(publicId)).toBe('REFUND_REQUESTED');
  });
});
