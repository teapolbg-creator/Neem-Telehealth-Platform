import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PatientRecord, ReferralRegisterRow, ReferralView } from '@neem/contracts';
import { disconnectPrisma, getPrisma } from '../../src/db/prisma.ts';
import { closeTestApp, request, signIn } from '../helpers/app.ts';
import { createTestUser, resetDatabase } from '../helpers/database.ts';
import { generatePublicId } from '../../src/lib/crypto.ts';
import { goOnline } from '../../src/modules/queue/presence.service.ts';

/**
 * Tracked referrals from a CHPS compound (CHPS slice 2a, D79, D80), and the
 * brief's Scenario 5 end to end.
 */

afterAll(async () => {
  await closeTestApp();
  await disconnectPrisma();
});

const PASSWORD = 'ChoPassword123!';

async function facility(
  label: string,
  type: 'CHPS' | 'DISTRICT_HOSPITAL' = 'CHPS',
  status: 'ACTIVE' | 'INACTIVE' = 'ACTIVE',
) {
  const prisma = getPrisma();
  const district = await prisma.district.findFirstOrThrow({ where: { region: { name: 'Volta' } } });
  return prisma.facility.create({
    data: {
      publicId: generatePublicId('fac'),
      code: `F-${label}`,
      name: `${label}`,
      type,
      districtId: district.id,
      community: label,
      status,
      createdByUserId: 'test',
      isDemo: true,
    },
  });
}

async function facilityWithCho(label: string) {
  const prisma = getPrisma();
  const chps = await facility(`${label} CHPS`);
  const email = `cho-${label.toLowerCase()}@chps.test`;
  const user = await createTestUser({ email, password: PASSWORD, role: 'FACILITY' });
  await prisma.facilityUser.create({
    data: { facilityId: chps.id, userId: user.id, fullName: `${label} CHO` },
  });
  return { facility: chps, cookies: await signIn(email, PASSWORD) };
}

async function onlineDoctor() {
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
      fullName: 'Dr. Esi Owusu',
      mdcNumber: `MDC-R-${suffix}`,
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
  await goOnline(doctor.id);
  return signIn(email, 'DoctorPassword123!');
}

async function visit(cookies: Record<string, string>, category = 'YELLOW') {
  const created = await request<{ patientNumber: string; visitPublicId: string }>(
    '/facility/patients',
    {
      method: 'POST',
      cookies,
      payload: {
        fullName: 'Kofi Agyeman',
        sex: 'MALE',
        ageYears: 60,
        community: 'Avenorpeme',
        consentGivenBy: 'PATIENT',
        presentingComplaint: 'Chest pain on walking',
      },
    },
  );
  const { patientNumber, visitPublicId } = created.body.data!;
  await request(`/facility/visits/${visitPublicId}/triage`, {
    method: 'POST',
    cookies,
    payload: { category, vitals: { bpSystolic: 170, bpDiastolic: 105 } },
  });
  return { patientNumber, visitPublicId };
}

const refer = (cookies: Record<string, string>, visitId: string, body: object) =>
  request<ReferralView>(`/facility/visits/${visitId}/referrals`, {
    method: 'POST',
    cookies,
    payload: { urgency: 'URGENT', reason: 'Needs ECG and specialist review', ...body },
  });

describe('tracked referrals', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('lists active facilities elsewhere, each with its district and region', async () => {
    const cho = await facilityWithCho('Listing');
    const hospital = await facility('Listed Hospital', 'DISTRICT_HOSPITAL');
    await facility('Closed Hospital', 'DISTRICT_HOSPITAL', 'INACTIVE');

    const response = await request('/facility/referral-destinations', { cookies: cho.cookies });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([
      expect.objectContaining({
        publicId: hospital.publicId,
        name: 'Listed Hospital',
        type: 'DISTRICT_HOSPITAL',
        region: 'Volta',
      }),
    ]);
  });

  it('runs a doctor’s referral from advice to the hospital’s feedback (Scenario 5)', async () => {
    const cho = await facilityWithCho('Alpha');
    const hospital = await facility('Ho Teaching Hospital', 'DISTRICT_HOSPITAL');
    const doctorCookies = await onlineDoctor();
    const { patientNumber, visitPublicId } = await visit(cho.cookies);

    // The doctor sees the patient and advises referral.
    await request(`/facility/visits/${visitPublicId}/consultation`, {
      method: 'POST',
      cookies: cho.cookies,
      payload: { languageCode: 'en', type: 'AUDIO' },
    });
    const consultation = await getPrisma().consultation.findFirstOrThrow();
    const path = `/doctor/consultations/${consultation.publicId}`;
    await request(`${path}/accept`, { method: 'POST', cookies: doctorCookies });
    await request(`${path}/media/join`, { method: 'POST', cookies: doctorCookies });
    await request(`${path}/encounter`, {
      method: 'PUT',
      cookies: doctorCookies,
      payload: {
        content: {
          clinicalAssessment: 'Possible angina with uncontrolled hypertension',
          treatmentPlan: 'Refer for ECG and review this week',
          referralInstructions: 'District hospital medical OPD, within 48 hours',
        },
      },
    });
    await request(`${path}/complete`, {
      method: 'POST',
      cookies: doctorCookies,
      payload: { outcomes: ['ADVICE_ONLY'] },
    });

    // The CHO sends the patient, from the registry.
    const issued = await refer(cho.cookies, visitPublicId, {
      destinationFacilityPublicId: hospital.publicId,
      destinationDepartment: 'Medical OPD',
      clinicalSummary: 'BP 170/105. Exertional chest pain. Seen by Neem doctor.',
      transport: 'Family taking him by trotro tomorrow',
    });
    expect(issued.status).toBe(201);
    expect(issued.body.data).toMatchObject({
      status: 'ISSUED',
      destination: { name: 'Ho Teaching Hospital', department: 'Medical OPD' },
      doctorName: 'Dr. Esi Owusu',
      issuedBy: 'Alpha CHO',
      acknowledged: null,
    });
    expect(issued.body.data!.publicId).toMatch(/^RF-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    const ref = issued.body.data!.publicId;

    // The visit ends as referred.
    const closed = await request(`/facility/visits/${visitPublicId}/close`, {
      method: 'POST',
      cookies: cho.cookies,
      payload: { outcome: 'REFERRED', note: 'Referred to Ho Teaching Hospital' },
    });
    expect(closed.body.data).toEqual({ status: 'REFERRED' });

    // The CHO phones ahead, then hears back.
    const acknowledged = await request<ReferralView>(`/facility/referrals/${ref}/acknowledge`, {
      method: 'POST',
      cookies: cho.cookies,
      payload: { via: 'PHONE', contact: 'Nurse Adjei, OPD' },
    });
    expect(acknowledged.body.data).toMatchObject({
      status: 'ACKNOWLEDGED',
      acknowledged: { via: 'PHONE', contact: 'Nurse Adjei, OPD', by: 'Alpha CHO' },
    });

    const attended = await request<ReferralView>(`/facility/referrals/${ref}/outcome`, {
      method: 'POST',
      cookies: cho.cookies,
      payload: {
        outcome: 'ATTENDED',
        via: 'PHONE',
        feedback: 'ECG normal. Started amlodipine. Review at CHPS in 2 weeks.',
      },
    });
    expect(attended.body.data).toMatchObject({
      status: 'ATTENDED',
      feedback: { text: 'ECG normal. Started amlodipine. Review at CHPS in 2 weeks.' },
    });

    // The patient's record reflects it.
    const record = await request<PatientRecord>(`/facility/patients/${patientNumber}`, {
      cookies: cho.cookies,
    });
    expect(record.body.data!.visits[0]).toMatchObject({
      status: 'REFERRED',
      referrals: [{ publicId: ref, status: 'ATTENDED', doctorName: 'Dr. Esi Owusu' }],
    });

    // Encrypted at rest.
    const row = await getPrisma().chpsReferral.findFirstOrThrow();
    expect(row.reasonEnc).not.toContain('ECG');
    expect(row.feedbackEnc).not.toContain('amlodipine');
  });

  it('sends an emergency patient on without a doctor (Scenario 3)', async () => {
    const cho = await facilityWithCho('Alpha');
    const { visitPublicId } = await visit(cho.cookies, 'RED');

    const emergency = await refer(cho.cookies, visitPublicId, {
      urgency: 'EMERGENCY',
      destinationName: 'Hohoe Municipal Hospital',
      reason: 'Unconscious after fall',
      transport: 'NAS ambulance called 10:42',
    });
    expect(emergency.body.data).toMatchObject({
      urgency: 'EMERGENCY',
      status: 'ISSUED',
      destination: { name: 'Hohoe Municipal Hospital', facilityPublicId: null },
      doctorName: null,
      transport: 'NAS ambulance called 10:42',
    });

    const closed = await request(`/facility/visits/${visitPublicId}/close`, {
      method: 'POST',
      cookies: cho.cookies,
      payload: { outcome: 'REFERRED', note: 'Ambulance left 10:55' },
    });
    expect(closed.body.data).toEqual({ status: 'REFERRED' });
  });

  it('refuses a destination that is not a real, active, other facility', async () => {
    const cho = await facilityWithCho('Alpha');
    const closedHospital = await facility('Closed Hospital', 'DISTRICT_HOSPITAL', 'INACTIVE');
    const { visitPublicId } = await visit(cho.cookies);

    expect((await refer(cho.cookies, visitPublicId, {})).status).toBe(400);
    expect(
      (
        await refer(cho.cookies, visitPublicId, {
          destinationFacilityPublicId: cho.facility.publicId,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await refer(cho.cookies, visitPublicId, {
          destinationFacilityPublicId: closedHospital.publicId,
        })
      ).status,
    ).toBe(400);
  });

  it('never moves a referral on by itself, and keeps every step in order', async () => {
    const cho = await facilityWithCho('Alpha');
    const { visitPublicId } = await visit(cho.cookies);
    const ref = (await refer(cho.cookies, visitPublicId, { destinationName: 'Clinic' })).body.data!
      .publicId;
    const post = (path: string, payload: object) =>
      request(`/facility/referrals/${ref}/${path}`, {
        method: 'POST',
        cookies: cho.cookies,
        payload,
      });

    expect((await post('acknowledge', { via: 'PHONE' })).status).toBe(200);
    expect((await post('acknowledge', { via: 'PHONE' })).status).toBe(422);
    expect((await post('outcome', { outcome: 'DID_NOT_ARRIVE', via: 'PHONE' })).status).toBe(200);
    expect((await post('outcome', { outcome: 'ATTENDED', via: 'PHONE' })).status).toBe(422);
    expect((await post('cancel', { reason: 'Changed mind' })).status).toBe(422);
    // Feedback may still come afterwards.
    expect((await post('feedback', { feedback: 'Went to a private clinic instead' })).status).toBe(
      200,
    );
  });

  it('will not end a visit as referred without a referral that stands', async () => {
    const cho = await facilityWithCho('Alpha');
    const { visitPublicId } = await visit(cho.cookies);
    const close = () =>
      request(`/facility/visits/${visitPublicId}/close`, {
        method: 'POST',
        cookies: cho.cookies,
        payload: { outcome: 'REFERRED', note: 'Referred' },
      });

    expect((await close()).status).toBe(422);
    const ref = (await refer(cho.cookies, visitPublicId, { destinationName: 'Clinic' })).body.data!
      .publicId;
    await request(`/facility/referrals/${ref}/cancel`, {
      method: 'POST',
      cookies: cho.cookies,
      payload: { reason: 'Patient refused' },
    });
    expect((await close()).status).toBe(422);
  });

  it('keeps a register of the facility’s referrals, and only its own', async () => {
    const alpha = await facilityWithCho('Alpha');
    const beta = await facilityWithCho('Beta');
    const first = await visit(alpha.cookies);
    const ref = (await refer(alpha.cookies, first.visitPublicId, { destinationName: 'Clinic' }))
      .body.data!.publicId;

    const register = await request<ReferralRegisterRow[]>('/facility/referrals?open=true', {
      cookies: alpha.cookies,
    });
    expect(register.body.data).toEqual([
      expect.objectContaining({
        publicId: ref,
        status: 'ISSUED',
        daysOutstanding: 0,
        patient: expect.objectContaining({ fullName: 'Kofi Agyeman' }),
      }),
    ]);

    const theirs = await request<ReferralRegisterRow[]>('/facility/referrals', {
      cookies: beta.cookies,
    });
    expect(theirs.body.data).toEqual([]);
    expect(
      (
        await request(`/facility/referrals/${ref}/acknowledge`, {
          method: 'POST',
          cookies: beta.cookies,
          payload: { via: 'PHONE' },
        })
      ).status,
    ).toBe(404);
  });
});
