import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getPrisma, disconnectPrisma } from '../../src/db/prisma.ts';
import { closeTestApp, request, signIn } from '../helpers/app.ts';
import {
  createTestDoctor,
  createTestPharmacy,
  createTestUser,
  resetDatabase,
  setDoctorOnDutyRequired,
} from '../helpers/database.ts';
import {
  MockPaymentProvider,
  setPaymentProviderForTesting,
} from '../../src/adapters/payment/index.ts';
import { transition } from '../../src/modules/consultation/consultation.service.ts';
import { cancelUnservedConsultations } from '../../src/modules/queue/wait-limit.service.ts';
import { SETTING_KEYS } from '../../src/modules/settings/settings.defaults.ts';
import { invalidateSettingsCache } from '../../src/modules/settings/settings.service.ts';

/**
 * No consultation without a doctor on duty, and no wait without end (D50).
 *
 * The first live consultation was paid for at 04:00 and waited in the queue for
 * a doctor who was not on shift. These cover the two halves of the answer: the
 * pharmacy cannot start or charge for one with nobody on duty, and a paid
 * consultation nobody takes is ended with a refund request rather than left.
 */

const PHARMACY = { email: 'pharmacy@availability.test', password: 'PharmacyPassword123!' };
const MINUTE = 60 * 1000;

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
  const pharmacy = await createTestPharmacy('Availability Pharmacy', 'ACTIVE');
  const user = await createTestUser({ ...PHARMACY, role: 'PHARMACY' });
  await prisma.pharmacyUser.create({ data: { pharmacyId: pharmacy.id, userId: user.id } });
  return signIn(PHARMACY.email, PHARMACY.password);
}

/** The seeded shift covering this moment, confirmed or merely assigned. */
async function putOnShift(doctorId: string, status: 'CONFIRMED' | 'ASSIGNED' = 'CONFIRMED') {
  const prisma = getPrisma();
  const now = new Date();
  const hour = now.getUTCHours();
  const code = hour >= 8 && hour < 14 ? 'MORNING' : hour >= 14 && hour < 20 ? 'AFTERNOON' : 'NIGHT';
  const shift = await prisma.shiftDefinition.findUniqueOrThrow({ where: { code } });

  await prisma.doctorShiftAssignment.create({
    data: {
      doctorId,
      shiftDefinitionId: shift.id,
      serviceDate: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())),
      status,
      confirmedAt: status === 'CONFIRMED' ? now : null,
      minutesPlanned: 360,
    },
  });
}

function createConsultation(cookies: Record<string, string>) {
  return request<{ publicId: string }>('/pharmacy/consultations', {
    method: 'POST',
    cookies,
    payload: {},
  });
}

describe('starting a consultation (block on)', () => {
  beforeEach(async () => {
    await setDoctorOnDutyRequired(true);
  });

  it('is refused while no doctor is on duty', async () => {
    const cookies = await signedInPharmacy();

    const response = await createConsultation(cookies);

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.body.error?.message).toMatch(/no doctor is on duty/i);
    expect(await getPrisma().consultation.count()).toBe(0);
  });

  it('is allowed once a doctor holds a confirmed shift covering now, even offline', async () => {
    const cookies = await signedInPharmacy();
    const { doctor } = await createTestDoctor('Dr. On Duty');
    // No presence row at all: the doctor has not opened the queue screen.
    await putOnShift(doctor.id);

    const response = await createConsultation(cookies);

    expect(response.status).toBe(201);
  });

  it('does not count a shift that was assigned but never confirmed', async () => {
    const cookies = await signedInPharmacy();
    const { doctor } = await createTestDoctor('Dr. Unconfirmed');
    await putOnShift(doctor.id, 'ASSIGNED');

    expect((await createConsultation(cookies)).status).toBeGreaterThanOrEqual(400);
  });

  it('does not count a doctor who is not active', async () => {
    const cookies = await signedInPharmacy();
    const { doctor } = await createTestDoctor('Dr. Pending', 'PENDING');
    await putOnShift(doctor.id);

    expect((await createConsultation(cookies)).status).toBeGreaterThanOrEqual(400);
  });

  it('refuses to take payment if duty ends between creating and paying', async () => {
    const cookies = await signedInPharmacy();
    const { doctor } = await createTestDoctor('Dr. Leaving');
    await putOnShift(doctor.id);

    const created = await createConsultation(cookies);
    expect(created.status).toBe(201);
    const publicId = created.body.data!.publicId;

    await getPrisma().doctorShiftAssignment.deleteMany({ where: { doctorId: doctor.id } });

    const payment = await request(`/pharmacy/consultations/${publicId}/payment`, {
      method: 'POST',
      cookies,
      payload: {},
    });

    expect(payment.status).toBeGreaterThanOrEqual(400);
    expect(payment.body.error?.message).toMatch(/no doctor is on duty/i);
    expect(await getPrisma().payment.count()).toBe(0);
  });

  it('can be switched off by an administrator', async () => {
    const cookies = await signedInPharmacy();
    await setDoctorOnDutyRequired(false);

    expect((await createConsultation(cookies)).status).toBe(201);
  });
});

describe('the queue wait limit', () => {
  /** A paid consultation that joined the queue `minutesAgo` minutes ago. */
  async function waitingForDoctor(minutesAgo: number) {
    const cookies = await signedInPharmacy();
    const created = await createConsultation(cookies);
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

    const prisma = getPrisma();
    const consultation = await prisma.consultation.findUniqueOrThrow({ where: { publicId } });
    expect(consultation.state).toBe('ACTIVATED');

    for (const to of ['WAITING_FOR_PATIENT', 'PATIENT_JOINED', 'WAITING_FOR_DOCTOR'] as const) {
      await transition(consultation.id, to, { actorType: 'SYSTEM' });
    }

    const language = await prisma.language.findUniqueOrThrow({ where: { code: 'en' } });
    const entry = await prisma.consultationQueueEntry.create({
      data: {
        consultationId: consultation.id,
        languageId: language.id,
        state: 'WAITING',
        enqueuedAt: new Date(Date.now() - minutesAgo * MINUTE),
      },
    });

    return { consultationId: consultation.id, entryId: entry.id };
  }

  it('cancels a paid consultation nobody took, and raises a refund request for it', async () => {
    const { consultationId, entryId } = await waitingForDoctor(21);

    expect(await cancelUnservedConsultations()).toBe(1);

    const prisma = getPrisma();
    const consultation = await prisma.consultation.findUniqueOrThrow({
      where: { id: consultationId },
    });
    expect(consultation.state).toBe('REFUND_REQUESTED');

    const refunds = await prisma.refund.findMany({ where: { consultationId } });
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ state: 'REQUESTED', requestedByType: 'SYSTEM' });

    const entry = await prisma.consultationQueueEntry.findUniqueOrThrow({ where: { id: entryId } });
    expect(entry.state).toBe('ABANDONED');
  });

  it('leaves a consultation still inside the limit alone', async () => {
    const { consultationId } = await waitingForDoctor(5);

    expect(await cancelUnservedConsultations()).toBe(0);

    const consultation = await getPrisma().consultation.findUniqueOrThrow({
      where: { id: consultationId },
    });
    expect(consultation.state).toBe('WAITING_FOR_DOCTOR');
  });

  it('does not pull an offer that is in a doctor’s hands', async () => {
    const { consultationId } = await waitingForDoctor(21);
    await transition(consultationId, 'ASSIGNED', { actorType: 'SYSTEM' });

    expect(await cancelUnservedConsultations()).toBe(0);
  });

  it('can be switched off with a limit of 0', async () => {
    await waitingForDoctor(21);

    await getPrisma().systemSetting.update({
      where: { key: SETTING_KEYS.QUEUE_MAX_WAIT_SECONDS },
      data: { value: 0 },
    });
    invalidateSettingsCache(SETTING_KEYS.QUEUE_MAX_WAIT_SECONDS);

    expect(await cancelUnservedConsultations()).toBe(0);
  });
});
