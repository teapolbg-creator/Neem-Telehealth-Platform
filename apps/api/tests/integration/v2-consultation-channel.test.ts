import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getPrisma, disconnectPrisma } from '../../src/db/prisma.ts';
import { closeTestApp, request, signIn } from '../helpers/app.ts';
import { createTestPharmacy, createTestUser, resetDatabase } from '../helpers/database.ts';
import {
  MockPaymentProvider,
  setPaymentProviderForTesting,
} from '../../src/adapters/payment/index.ts';
import { calculatePayouts } from '../../src/modules/payment/payout.service.ts';
import { generatePublicId } from '../../src/lib/crypto.ts';

/**
 * A consultation can belong to no pharmacy (v2, migration M1).
 *
 * Every consultation belonged to a pharmacy until now, and twenty modules read
 * that. The patient-direct service has no pharmacy at any point, so the column
 * is optional and each consultation says which service created it. These fix
 * both halves: the counter is unchanged, and a consultation with no pharmacy is
 * a legal row that the pharmacy-facing machinery leaves alone.
 *
 * Nothing here creates a patient-direct consultation through a route — there is
 * no route yet. It writes the rows such a route will write.
 */

const PHARMACY = { email: 'pharmacy@channel.test', password: 'PharmacyPassword123!' };

beforeEach(async () => {
  await resetDatabase();
  setPaymentProviderForTesting(new MockPaymentProvider());
});

afterAll(async () => {
  setPaymentProviderForTesting(undefined);
  await closeTestApp();
  await disconnectPrisma();
});

async function signedInPharmacy() {
  const prisma = getPrisma();
  const pharmacy = await createTestPharmacy('Channel Pharmacy', 'ACTIVE');
  const user = await createTestUser({ ...PHARMACY, role: 'PHARMACY' });
  await prisma.pharmacyUser.create({ data: { pharmacyId: pharmacy.id, userId: user.id } });

  return { pharmacy, cookies: await signIn(PHARMACY.email, PHARMACY.password) };
}

/** The row a patient-direct booking will write, without a route to write it yet. */
async function directConsultation(netMinor = 5000) {
  return getPrisma().consultation.create({
    data: {
      publicId: `NEEM-TEST-${generatePublicId('c').slice(-8).toUpperCase()}`,
      channel: 'DIRECT',
      state: 'PENDING_PAYMENT',
      priceMinor: netMinor,
      netMinor,
      currency: 'GHS',
    },
  });
}

describe('the pharmacy counter', () => {
  it('still creates consultations that belong to it, marked COUNTER', async () => {
    const { pharmacy, cookies } = await signedInPharmacy();

    const created = await request<{ publicId: string }>('/pharmacy/consultations', {
      method: 'POST',
      cookies,
      payload: {},
    });
    expect(created.status).toBe(201);

    const consultation = await getPrisma().consultation.findUniqueOrThrow({
      where: { publicId: created.body.data!.publicId },
    });
    expect(consultation.pharmacyId).toBe(pharmacy.id);
    expect(consultation.channel).toBe('COUNTER');
  });
});

describe('a consultation with no pharmacy', () => {
  it('is a legal row, and says which service created it', async () => {
    const consultation = await directConsultation();

    expect(consultation.pharmacyId).toBeNull();
    expect(consultation.channel).toBe('DIRECT');
  });

  it('is not visible to a pharmacy asking for its own consultations', async () => {
    const { cookies } = await signedInPharmacy();
    const direct = await directConsultation();

    const listed = await request<Array<{ publicId: string }>>('/pharmacy/consultations', {
      cookies,
    });

    expect(listed.status).toBe(200);
    expect(listed.body.data?.map((row) => row.publicId) ?? []).not.toContain(direct.publicId);
  });

  it('owes no pharmacy anything when its revenue is allocated', async () => {
    const prisma = getPrisma();
    const { pharmacy } = await signedInPharmacy();
    const direct = await directConsultation();

    const payment = await prisma.payment.create({
      data: {
        publicId: generatePublicId('pay'),
        consultationId: direct.id,
        provider: 'mock',
        providerReference: `mock_direct_${direct.id}`,
        idempotencyKey: `neem_${direct.publicId}_test`,
        amountMinor: direct.netMinor,
        currency: 'GHS',
        status: 'SUCCESS',
        paidAt: new Date(),
      },
    });

    // The split the counter would have written, with a pharmacy share owed to
    // nobody: there is no pharmacy on this consultation.
    await prisma.revenueAllocation.create({
      data: {
        consultationId: direct.id,
        paymentId: payment.id,
        grossMinor: direct.netMinor,
        netMinor: direct.netMinor,
        pharmacySharePctBp: 3000,
        pharmacyShareMinor: 1500,
        neemShareMinor: direct.netMinor - 1500,
        currency: 'GHS',
        calculatedAt: new Date(),
      },
    });

    const today = new Date();
    const result = await calculatePayouts({ periodStart: today, periodEnd: today }, 'no-admin');

    expect(result.created).toBe(0);
    expect(await prisma.pharmacyPayout.count({ where: { pharmacyId: pharmacy.id } })).toBe(0);
  });
});
