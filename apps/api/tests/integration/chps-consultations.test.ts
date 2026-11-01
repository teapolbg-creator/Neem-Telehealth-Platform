import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FacilityDaySummary, PatientRecord, VisitConsultation } from '@neem/contracts';
import { disconnectPrisma, getPrisma } from '../../src/db/prisma.ts';
import { closeTestApp, request, signIn } from '../helpers/app.ts';
import { createTestUser, resetDatabase, setDoctorOnDutyRequired } from '../helpers/database.ts';
import { decryptField, generatePublicId } from '../../src/lib/crypto.ts';
import { goOnline } from '../../src/modules/queue/presence.service.ts';
import { recordEarning } from '../../src/modules/payment/earnings.service.ts';
import { SETTING_KEYS } from '../../src/modules/settings/settings.defaults.ts';
import { invalidateSettingsCache } from '../../src/modules/settings/settings.service.ts';

/**
 * A CHPS compound requesting a Neem doctor (CHPS slice 1c, D76).
 */

afterAll(async () => {
  await closeTestApp();
  await disconnectPrisma();
});

const PASSWORD = 'ChoPassword123!';

async function facilityWithCho(label: string) {
  const prisma = getPrisma();
  const district = await prisma.district.findFirstOrThrow({ where: { region: { name: 'Volta' } } });
  const facility = await prisma.facility.create({
    data: {
      publicId: generatePublicId('fac'),
      code: `CHPS-${label}`,
      name: `${label} CHPS`,
      type: 'CHPS',
      districtId: district.id,
      community: label,
      status: 'ACTIVE',
      createdByUserId: 'test',
      isDemo: true,
    },
  });
  const email = `cho-${label.toLowerCase()}@chps.test`;
  const user = await createTestUser({ email, password: PASSWORD, role: 'FACILITY' });
  await prisma.facilityUser.create({
    data: { facilityId: facility.id, userId: user.id, fullName: `${label} CHO` },
  });
  return { facility, cookies: await signIn(email, PASSWORD) };
}

/** An active, licensed doctor on a confirmed all-day shift, online, speaking English. */
async function onlineDoctor(name = 'Dr. Mensah', online = true) {
  const prisma = getPrisma();
  const suffix = generatePublicId('x').slice(-8).toLowerCase();
  const email = `${suffix}@doctor.test`;
  const user = await createTestUser({ email, password: 'DoctorPassword123!', role: 'DOCTOR' });
  const english = await prisma.language.findUniqueOrThrow({ where: { code: 'en' } });
  const expiry = new Date();
  expiry.setFullYear(expiry.getFullYear() + 1);

  const doctor = await prisma.doctor.create({
    data: {
      publicId: generatePublicId('doc'),
      userId: user.id,
      fullName: name,
      mdcNumber: `MDC-C-${suffix}`,
      qualification: 'MB ChB',
      practiceAddress: 'Ridge Clinic, Accra',
      mdcExpiresAt: expiry,
      status: 'ACTIVE',
      isDemo: true,
      languages: { create: [{ languageId: english.id, isPrimary: true }] },
    },
  });
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
      doctorId: doctor.id,
      shiftDefinitionId: allDay.id,
      serviceDate: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())),
      status: 'CONFIRMED',
      minutesPlanned: 1439,
    },
  });
  if (online) await goOnline(doctor.id);
  return { doctor, cookies: await signIn(email, 'DoctorPassword123!') };
}

/** A walk-in, registered and triaged at the given category. */
async function triagedVisit(cookies: Record<string, string>, category = 'YELLOW') {
  const created = await request<{ patientNumber: string; visitPublicId: string }>(
    '/facility/patients',
    {
      method: 'POST',
      cookies,
      payload: {
        fullName: 'Kwabena Owusu',
        sex: 'MALE',
        ageYears: 52,
        community: 'Avenorpeme',
        consentGivenBy: 'PATIENT',
        presentingComplaint: 'Chest tightness on exertion',
      },
    },
  );
  const { patientNumber, visitPublicId } = created.body.data!;
  await request(`/facility/visits/${visitPublicId}/triage`, {
    method: 'POST',
    cookies,
    payload: { category, vitals: { bpSystolic: 150, bpDiastolic: 95 } },
  });
  return { patientNumber, visitPublicId };
}

function requestDoctor(cookies: Record<string, string>, visit: string, body: object = {}) {
  return request<VisitConsultation>(`/facility/visits/${visit}/consultation`, {
    method: 'POST',
    cookies,
    payload: { languageCode: 'en', type: 'VIDEO', ...body },
  });
}

describe('requesting a doctor from a CHPS compound', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('puts a triaged patient in the queue, free, and offers them to a doctor', async () => {
    const { cookies } = await facilityWithCho('Alpha');
    const { doctor } = await onlineDoctor();
    const { visitPublicId } = await triagedVisit(cookies);

    const requested = await requestDoctor(cookies, visitPublicId, { note: 'BP high twice' });
    expect(requested.status).toBe(201);
    expect(requested.body.data).toMatchObject({ active: true, doctorName: null, type: 'VIDEO' });

    const prisma = getPrisma();
    const consultation = await prisma.consultation.findFirstOrThrow({
      include: { patientSession: true, payments: true },
    });
    expect(consultation).toMatchObject({
      channel: 'CHPS',
      netMinor: 0,
      priceMinor: 0,
      feeWaivedReason: 'chps_free',
      pharmacyId: null,
      // Offered to the one doctor who is online, straight away.
      state: 'ASSIGNED',
      doctorId: doctor.id,
    });
    expect(consultation.payments).toHaveLength(1);
    expect(consultation.payments[0]).toMatchObject({ isWaived: true, amountMinor: 0 });
    // The doctor's workspace reads the patient from here.
    expect(decryptField(consultation.patientSession!.fullNameEnc!)).toBe('Kwabena Owusu');
    expect(consultation.patientSession!.age).toBe(52);

    const day = await request<FacilityDaySummary>('/facility/today', { cookies });
    expect(day.body.data).toMatchObject({ awaitingDoctor: 1, withDoctor: 0 });
    expect(day.body.data!.board[0]!.consultation).toMatchObject({
      state: 'ASSIGNED',
      doctorName: null,
    });
  });

  it('names the doctor only once they accept, and records no earning', async () => {
    const { cookies } = await facilityWithCho('Alpha');
    const { doctor, cookies: doctorCookies } = await onlineDoctor('Dr. Ama Darko');
    const { patientNumber, visitPublicId } = await triagedVisit(cookies);
    await requestDoctor(cookies, visitPublicId);
    const consultation = await getPrisma().consultation.findFirstOrThrow();

    const accepted = await request(`/doctor/consultations/${consultation.publicId}/accept`, {
      method: 'POST',
      cookies: doctorCookies,
    });
    expect(accepted.status).toBe(200);

    const record = await request<PatientRecord>(`/facility/patients/${patientNumber}`, {
      cookies,
    });
    expect(record.body.data!.visits[0]!.consultation).toMatchObject({
      state: 'DOCTOR_ACCEPTED',
      doctorName: 'Dr. Ama Darko',
    });
    const day = await request<FacilityDaySummary>('/facility/today', { cookies });
    expect(day.body.data).toMatchObject({ awaitingDoctor: 0, withDoctor: 1 });

    // Even with professional earnings switched on, government pays (D74).
    const prisma = getPrisma();
    await prisma.systemSetting.update({
      where: { key: SETTING_KEYS.REVENUE_PROFESSIONAL_EARNINGS_ENABLED },
      data: { value: true },
    });
    invalidateSettingsCache();
    expect(await recordEarning(consultation.id)).toBe(false);
    expect(await prisma.professionalEarning.count({ where: { doctorId: doctor.id } })).toBe(0);
  });

  it('says plainly when no doctor is on duty, and leaves the patient with the CHO', async () => {
    const { cookies } = await facilityWithCho('Alpha');
    const { visitPublicId } = await triagedVisit(cookies);
    await setDoctorOnDutyRequired(true);

    const refused = await requestDoctor(cookies, visitPublicId);
    expect(refused.status).toBe(422);
    expect(refused.body.error?.message).toMatch(/No Neem doctor is on duty/);

    expect(await getPrisma().consultation.count()).toBe(0);
    const day = await request<FacilityDaySummary>('/facility/today', { cookies });
    expect(day.body.data!.board[0]).toMatchObject({ status: 'TRIAGED', consultation: null });
  });

  it('never claims a doctor when none has accepted', async () => {
    const { cookies } = await facilityWithCho('Alpha');
    // On a shift, but not signed in: nobody to offer it to.
    await onlineDoctor('Dr. Away', false);
    const { visitPublicId } = await triagedVisit(cookies);

    const requested = await requestDoctor(cookies, visitPublicId);
    expect(requested.body.data).toMatchObject({ state: 'WAITING_FOR_DOCTOR', doctorName: null });
  });

  it('refuses before triage, for a red patient, and twice for one visit', async () => {
    const { cookies } = await facilityWithCho('Alpha');
    await onlineDoctor();

    const untriaged = await request<{ visitPublicId: string }>('/facility/patients', {
      method: 'POST',
      cookies,
      payload: {
        fullName: 'Esi Quaye',
        sex: 'FEMALE',
        ageYears: 30,
        community: 'Avenorpeme',
        consentGivenBy: 'PATIENT',
        presentingComplaint: 'Cough',
      },
    });
    expect((await requestDoctor(cookies, untriaged.body.data!.visitPublicId)).status).toBe(422);

    const red = await triagedVisit(cookies, 'RED');
    const redRequest = await requestDoctor(cookies, red.visitPublicId);
    expect(redRequest.status).toBe(422);
    expect(redRequest.body.error?.message).toMatch(/emergency/);

    const yellow = await triagedVisit(cookies);
    expect((await requestDoctor(cookies, yellow.visitPublicId)).status).toBe(201);
    expect((await requestDoctor(cookies, yellow.visitPublicId)).status).toBe(409);
  });

  it('withdraws a waiting request without raising a refund, and allows a new one', async () => {
    const { cookies } = await facilityWithCho('Alpha');
    await onlineDoctor('Dr. Away', false);
    const { visitPublicId } = await triagedVisit(cookies);
    await requestDoctor(cookies, visitPublicId);

    const withdrawn = await request<VisitConsultation>(
      `/facility/visits/${visitPublicId}/consultation/cancel`,
      { method: 'POST', cookies, payload: { reason: 'Patient went home' } },
    );
    expect(withdrawn.body.data).toMatchObject({ state: 'CANCELLED', active: false });
    expect(await getPrisma().refund.count()).toBe(0);

    expect((await requestDoctor(cookies, visitPublicId)).status).toBe(201);
  });

  it('cannot withdraw once a doctor has accepted, nor end the visit under them', async () => {
    const { cookies } = await facilityWithCho('Alpha');
    const { cookies: doctorCookies } = await onlineDoctor();
    const { visitPublicId } = await triagedVisit(cookies);
    await requestDoctor(cookies, visitPublicId);
    const consultation = await getPrisma().consultation.findFirstOrThrow();
    await request(`/doctor/consultations/${consultation.publicId}/accept`, {
      method: 'POST',
      cookies: doctorCookies,
    });

    const withdraw = await request(`/facility/visits/${visitPublicId}/consultation/cancel`, {
      method: 'POST',
      cookies,
      payload: { reason: 'Changed mind' },
    });
    expect(withdraw.status).toBe(422);

    const close = await request(`/facility/visits/${visitPublicId}/close`, {
      method: 'POST',
      cookies,
      payload: { outcome: 'CLOSED', note: 'Done' },
    });
    expect(close.status).toBe(422);
  });

  it('takes a waiting patient out of the queue when they become an emergency', async () => {
    const { cookies } = await facilityWithCho('Alpha');
    await onlineDoctor('Dr. Away', false);
    const { visitPublicId } = await triagedVisit(cookies);
    await requestDoctor(cookies, visitPublicId);

    await request(`/facility/visits/${visitPublicId}/triage`, {
      method: 'POST',
      cookies,
      payload: { category: 'RED' },
    });

    const consultation = await getPrisma().consultation.findFirstOrThrow();
    expect(consultation.state).toBe('CANCELLED');
  });

  it('keeps a doctor who has already accepted when the patient becomes an emergency', async () => {
    const { cookies } = await facilityWithCho('Alpha');
    const { cookies: doctorCookies } = await onlineDoctor();
    const { visitPublicId } = await triagedVisit(cookies);
    await requestDoctor(cookies, visitPublicId);
    const consultation = await getPrisma().consultation.findFirstOrThrow();
    await request(`/doctor/consultations/${consultation.publicId}/accept`, {
      method: 'POST',
      cookies: doctorCookies,
    });

    await request(`/facility/visits/${visitPublicId}/escalate`, {
      method: 'POST',
      cookies,
      payload: { note: 'Collapsed; ambulance called' },
    });

    const fresh = await getPrisma().consultation.findUniqueOrThrow({
      where: { id: consultation.id },
    });
    expect(fresh.state).toBe('DOCTOR_ACCEPTED');
  });

  it('keeps one facility from requesting for another’s visit', async () => {
    const alpha = await facilityWithCho('Alpha');
    const beta = await facilityWithCho('Beta');
    await onlineDoctor();
    const { visitPublicId } = await triagedVisit(alpha.cookies);

    expect((await requestDoctor(beta.cookies, visitPublicId)).status).toBe(404);
  });
});
