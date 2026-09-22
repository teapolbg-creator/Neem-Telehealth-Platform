import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getPrisma, disconnectPrisma } from '../../src/db/prisma.ts';
import { closeTestApp, request, signIn } from '../helpers/app.ts';
import { createTestPharmacy, createTestUser, resetDatabase } from '../helpers/database.ts';
import {
  MockPaymentProvider,
  setPaymentProviderForTesting,
} from '../../src/adapters/payment/index.ts';
import { transition } from '../../src/modules/consultation/consultation.service.ts';
import { createDraft } from '../../src/modules/prescription/prescription.service.ts';
import { issueReferral, verifyDocument } from '../../src/modules/documents/document.service.ts';
import { offerNextDoctor } from '../../src/modules/queue/allocation.service.ts';
import { setProfession } from '../../src/modules/doctor/doctor.service.ts';
import { goOnline } from '../../src/modules/queue/presence.service.ts';
import { encryptField, generatePublicId } from '../../src/lib/crypto.ts';

/**
 * What each profession may issue (v2, plan phase 5).
 *
 * A dietitian and a personal trainer sign in through the same role as a doctor
 * and use the same workspace. The one thing that must never blur is what they
 * are allowed to put their name to: a prescription is an act of a registered
 * medical practitioner, and a hospital referral is a clinical judgement.
 *
 * Every refusal below is asserted twice — once at the route, where the
 * permission is missing, and once at the service, where the database is asked
 * what the professional is. Two checks, because the failure this prevents is a
 * prescription signed by somebody who cannot prescribe.
 */

const PASSWORD = 'ProfessionalPassword123!';
const PHARMACY_PASSWORD = 'PharmacyPassword123!';

interface Professional {
  doctorId: string;
  email: string;
}

async function createProfessional(
  discipline: 'DOCTOR' | 'DIETITIAN' | 'TRAINER',
  options: { credentialType?: string; credentialNumber?: string } = {},
): Promise<Professional> {
  const prisma = getPrisma();
  const suffix = generatePublicId('x').slice(-8).toLowerCase();
  const email = `${suffix}@professional.test`;

  const user = await createTestUser({ email, password: PASSWORD, role: 'DOCTOR' });

  const expiry = new Date();
  expiry.setFullYear(expiry.getFullYear() + 1);

  const doctor = await prisma.doctor.create({
    data: {
      publicId: generatePublicId('doc'),
      userId: user.id,
      fullName: `${discipline[0]}${discipline.slice(1).toLowerCase()} Owusu`,
      discipline,
      mdcNumber: discipline === 'DOCTOR' ? `MDC-D-${suffix}` : null,
      mdcExpiresAt: discipline === 'DOCTOR' ? expiry : null,
      credentialType: options.credentialType ?? null,
      credentialNumber: options.credentialNumber ?? null,
      status: 'ACTIVE',
      isDemo: true,
      // Nothing can be issued unsigned, whoever issues it.
      signatures: { create: { signatureDataEnc: encryptField('data:image/png;base64,AAAA') } },
    },
  });

  return { doctorId: doctor.id, email };
}

/** A consultation IN_PROGRESS with this professional, so outputs are possible. */
async function liveConsultation(professional: Professional, serviceCode?: string) {
  const prisma = getPrisma();
  const suffix = generatePublicId('x').slice(-8).toLowerCase();

  const pharmacy = await createTestPharmacy(`Pharmacy ${suffix}`, 'ACTIVE');
  const pharmacyUser = await createTestUser({
    email: `${suffix}@pharmacy.test`,
    password: PHARMACY_PASSWORD,
    role: 'PHARMACY',
  });
  await prisma.pharmacyUser.create({
    data: { pharmacyId: pharmacy.id, userId: pharmacyUser.id },
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

  const service = serviceCode
    ? await prisma.service.findUniqueOrThrow({ where: { code: serviceCode } })
    : null;

  const language = await prisma.language.findFirstOrThrow({ where: { code: 'en' } });

  await prisma.consultation.update({
    where: { id: consultation.id },
    data: {
      doctorId: professional.doctorId,
      type: 'VIDEO',
      languageId: language.id,
      ...(service ? { serviceId: service.id } : {}),
    },
  });

  for (const state of [
    'PAYMENT_PROCESSING',
    'PAID',
    'ACTIVATED',
    'WAITING_FOR_PATIENT',
    'PATIENT_JOINED',
    'WAITING_FOR_DOCTOR',
    'ASSIGNED',
    'DOCTOR_ACCEPTED',
    'IN_PROGRESS',
  ] as const) {
    await transition(consultation.id, state, { actorType: 'SYSTEM', reason: 'fixture' });
  }

  return { id: consultation.id, publicId };
}

const ITEM = {
  medication: 'Amoxicillin',
  strength: '500mg',
  dose: '1 capsule',
  frequency: 'Three times daily',
  durationText: '5 days',
  quantity: '15 capsules',
};

const REFERRAL = {
  hospitalName: 'Korle Bu Teaching Hospital',
  department: 'Endocrinology',
  reasonText: 'Persistent symptoms that need an in-person assessment.',
};

const SUMMARY = {
  presentingComplaint: 'Wants to lose weight',
  assessment: 'No red flags. Diet is the main lever.',
  advice: 'Three meals a day, and a food diary for two weeks.',
  safetyNetting: 'See a doctor if you feel faint or lose weight without trying.',
};

beforeEach(async () => {
  await resetDatabase();
  setPaymentProviderForTesting(new MockPaymentProvider());
});

afterAll(async () => {
  setPaymentProviderForTesting(undefined);
  await closeTestApp();
  await disconnectPrisma();
});

describe('a dietitian', () => {
  it('is refused a prescription at the route', async () => {
    const dietitian = await createProfessional('DIETITIAN');
    const consultation = await liveConsultation(dietitian);
    const cookies = await signIn(dietitian.email, PASSWORD);

    const attempt = await request(`/doctor/consultations/${consultation.publicId}/prescriptions`, {
      method: 'POST',
      cookies,
      payload: { items: [ITEM] },
    });

    expect(attempt.status).toBe(403);
    expect(await getPrisma().prescription.count()).toBe(0);
  });

  it('is refused a prescription at the service, where the route is not involved', async () => {
    const dietitian = await createProfessional('DIETITIAN');
    const consultation = await liveConsultation(dietitian);

    await expect(createDraft(consultation.id, dietitian.doctorId, [ITEM])).rejects.toThrow(
      /cannot prescribe/i,
    );
    expect(await getPrisma().prescription.count()).toBe(0);
  });

  it('is refused a referral at the route and at the service', async () => {
    const dietitian = await createProfessional('DIETITIAN');
    const consultation = await liveConsultation(dietitian);
    const cookies = await signIn(dietitian.email, PASSWORD);

    const attempt = await request(`/doctor/consultations/${consultation.publicId}/referrals`, {
      method: 'POST',
      cookies,
      payload: REFERRAL,
    });
    expect(attempt.status).toBe(403);

    await expect(issueReferral(consultation.id, dietitian.doctorId, REFERRAL)).rejects.toThrow(
      /cannot issue a referral/i,
    );
    expect(await getPrisma().referral.count()).toBe(0);
  });

  it('cannot reach the substitution decisions that belong to a prescriber', async () => {
    const dietitian = await createProfessional('DIETITIAN');
    const cookies = await signIn(dietitian.email, PASSWORD);

    expect((await request('/doctor/substitutions', { cookies })).status).toBe(403);
  });

  it('can write notes and issue the advice summary, which is their whole job', async () => {
    const dietitian = await createProfessional('DIETITIAN', {
      credentialType: 'GAND',
      credentialNumber: 'D-4417',
    });
    const consultation = await liveConsultation(dietitian);
    const cookies = await signIn(dietitian.email, PASSWORD);

    const notes = await request(`/doctor/consultations/${consultation.publicId}/notes`, {
      method: 'PUT',
      cookies,
      payload: { notes: 'Discussed portion sizes.' },
    });
    expect(notes.status).toBe(200);

    const summary = await request<{ publicId: string }>(
      `/doctor/consultations/${consultation.publicId}/summary`,
      { method: 'POST', cookies, payload: SUMMARY },
    );
    expect(summary.status).toBe(201);

    /*
     * And the document says who they actually are. An MDC number here would be
     * a claim the Medical and Dental Council has never made.
     */
    const row = await getPrisma().consultationSummary.findUniqueOrThrow({
      where: { publicId: summary.body.data!.publicId },
    });
    const verified = await verifyDocument('summary', row.verificationCode);
    expect(verified.doctor.credential).toBe('GAND D-4417');
  });
});

describe('a doctor', () => {
  it('still prescribes and refers, so the refusals above are about discipline', async () => {
    const doctor = await createProfessional('DOCTOR');
    const consultation = await liveConsultation(doctor);
    const cookies = await signIn(doctor.email, PASSWORD);

    const prescribed = await request(
      `/doctor/consultations/${consultation.publicId}/prescriptions`,
      { method: 'POST', cookies, payload: { items: [ITEM] } },
    );
    expect(prescribed.status).toBe(201);

    const referred = await request(`/doctor/consultations/${consultation.publicId}/referrals`, {
      method: 'POST',
      cookies,
      payload: REFERRAL,
    });
    expect(referred.status).toBe(201);
  });

  it('carries an MDC number on the documents they sign', async () => {
    const doctor = await createProfessional('DOCTOR');
    const consultation = await liveConsultation(doctor);
    const cookies = await signIn(doctor.email, PASSWORD);

    const summary = await request<{ publicId: string }>(
      `/doctor/consultations/${consultation.publicId}/summary`,
      { method: 'POST', cookies, payload: SUMMARY },
    );

    const row = await getPrisma().consultationSummary.findUniqueOrThrow({
      where: { publicId: summary.body.data!.publicId },
    });
    const verified = await verifyDocument('summary', row.verificationCode);
    expect(verified.doctor.credential).toMatch(/^MDC /);
  });
});

describe('recording what a professional is', () => {
  const ADMIN_ID = 'admin-test-id';

  it('takes away the MDC number when somebody stops being a doctor', async () => {
    const professional = await createProfessional('DOCTOR');
    const before = await getPrisma().doctor.findUniqueOrThrow({
      where: { id: professional.doctorId },
    });

    const result = await setProfession(
      before.publicId,
      { discipline: 'DIETITIAN', credentialNumber: 'D-9001' },
      { adminId: ADMIN_ID },
    );

    // A dietitian's registration is always an AHPC licence; the body is not typed.
    expect(result.credential).toBe('AHPC D-9001');

    const after = await getPrisma().doctor.findUniqueOrThrow({
      where: { id: professional.doctorId },
    });
    // Left behind, it would print an MDC number on a dietitian's documents.
    expect(after.mdcNumber).toBeNull();
    expect(after.discipline).toBe('DIETITIAN');
  });

  it('and they can no longer prescribe, from that moment', async () => {
    const professional = await createProfessional('DOCTOR');
    const consultation = await liveConsultation(professional);
    const { publicId } = await getPrisma().doctor.findUniqueOrThrow({
      where: { id: professional.doctorId },
    });

    await setProfession(publicId, { discipline: 'TRAINER' }, { adminId: ADMIN_ID });

    await expect(createDraft(consultation.id, professional.doctorId, [ITEM])).rejects.toThrow(
      /cannot prescribe/i,
    );
  });

  it('refuses a service the discipline does not deliver', async () => {
    const professional = await createProfessional('DIETITIAN');
    const { publicId } = await getPrisma().doctor.findUniqueOrThrow({
      where: { id: professional.doctorId },
    });

    await expect(
      setProfession(
        publicId,
        { discipline: 'DIETITIAN', serviceCodes: ['WEIGHT_LOSS_DOCTOR'] },
        { adminId: ADMIN_ID },
      ),
    ).rejects.toThrow(/delivered by a doctor/i);
  });

  it('records the services a professional does deliver', async () => {
    const professional = await createProfessional('DIETITIAN');
    const { publicId } = await getPrisma().doctor.findUniqueOrThrow({
      where: { id: professional.doctorId },
    });

    const result = await setProfession(
      publicId,
      { discipline: 'DIETITIAN', serviceCodes: ['WEIGHT_LOSS_DIETITIAN'] },
      { adminId: ADMIN_ID },
    );

    expect(result.services).toEqual(['WEIGHT_LOSS_DIETITIAN']);
    expect(
      await getPrisma().professionalService.count({ where: { doctorId: professional.doctorId } }),
    ).toBe(1);
  });
});

describe('the queue', () => {
  /**
   * An all-day confirmed shift and a heartbeat, so only discipline decides.
   *
   * A clinic service also needs the professional to have joined the clinic
   * (plan phase 8), which is what `serviceCode` records here.
   */
  async function putOnDuty(professional: Professional, serviceCode?: string) {
    const prisma = getPrisma();
    const language = await prisma.language.findFirstOrThrow({ where: { code: 'en' } });

    await prisma.doctorLanguage.create({
      data: { doctorId: professional.doctorId, languageId: language.id, isPrimary: true },
    });

    if (serviceCode) {
      const service = await prisma.service.findUniqueOrThrow({ where: { code: serviceCode } });
      await prisma.professionalService.create({
        data: { doctorId: professional.doctorId, serviceId: service.id },
      });
    }

    const allDay = await prisma.shiftDefinition.upsert({
      where: { code: 'TEST_ALL_DAY' },
      update: { isActive: true },
      create: {
        code: 'TEST_ALL_DAY',
        label: 'Test all-day shift',
        startsAt: '00:00',
        endsAt: '23:59',
        isActive: true,
      },
    });

    const now = new Date();
    await prisma.doctorShiftAssignment.create({
      data: {
        doctorId: professional.doctorId,
        shiftDefinitionId: allDay.id,
        serviceDate: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())),
        status: 'CONFIRMED',
        minutesPlanned: 1439,
      },
    });

    await goOnline(professional.doctorId);
  }

  /** A consultation for one service, waiting for somebody to take it. */
  async function waitingFor(serviceCode: string) {
    const prisma = getPrisma();
    const placeholder = await createProfessional('DOCTOR');
    const consultation = await liveConsultation(placeholder, serviceCode);
    const language = await prisma.language.findFirstOrThrow({ where: { code: 'en' } });

    // Back out of the fixture's assignment: this is about who it is offered to.
    await prisma.consultationAssignment.deleteMany({ where: { consultationId: consultation.id } });
    await prisma.consultation.update({
      where: { id: consultation.id },
      data: { doctorId: null, state: 'WAITING_FOR_DOCTOR' },
    });
    await prisma.consultationQueueEntry.upsert({
      where: { consultationId: consultation.id },
      update: { state: 'WAITING' },
      create: {
        consultation: { connect: { id: consultation.id } },
        language: { connect: { id: language.id } },
        state: 'WAITING',
      },
    });

    return consultation;
  }

  it('does not offer a dietitian consultation to a doctor', async () => {
    const doctor = await createProfessional('DOCTOR');
    await putOnDuty(doctor);

    const consultation = await waitingFor('WEIGHT_LOSS_DIETITIAN');
    const result = await offerNextDoctor(consultation.id);

    expect(result.offered).toBe(false);
    expect(result.reason).toBe('NO_ELIGIBLE_DOCTOR');
  });

  it('offers it to a dietitian who is on duty', async () => {
    const dietitian = await createProfessional('DIETITIAN');
    await putOnDuty(dietitian, 'WEIGHT_LOSS_DIETITIAN');

    const consultation = await waitingFor('WEIGHT_LOSS_DIETITIAN');
    const result = await offerNextDoctor(consultation.id);

    expect(result.offered).toBe(true);
    expect(result.doctorId).toBe(dietitian.doctorId);
  });

  it('does not offer a counter consultation to a dietitian', async () => {
    const dietitian = await createProfessional('DIETITIAN');
    await putOnDuty(dietitian);

    // No service at all: what the counter creates, and what it sells is a doctor.
    const consultation = await waitingFor('GENERAL_CONSULTATION');
    await getPrisma().consultation.update({
      where: { id: consultation.id },
      data: { serviceId: null },
    });

    expect((await offerNextDoctor(consultation.id)).offered).toBe(false);
  });
});
