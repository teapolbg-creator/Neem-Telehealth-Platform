import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  ChpsConsultationContext,
  EncounterView,
  PatientRecord,
  StationPairing,
  StationState,
} from '@neem/contracts';
import { disconnectPrisma, getPrisma } from '../../src/db/prisma.ts';
import { closeTestApp, request, signIn } from '../helpers/app.ts';
import { createTestUser, resetDatabase } from '../helpers/database.ts';
import { generatePublicId } from '../../src/lib/crypto.ts';
import { goOnline } from '../../src/modules/queue/presence.service.ts';

/**
 * The doctor's side of a CHPS consultation (CHPS slice 1e, D78), and the
 * whole walk-in journey end to end (brief §13, Scenario 1).
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

async function onlineDoctor(name: string) {
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
      mdcNumber: `MDC-E-${suffix}`,
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
  return { doctor, cookies: await signIn(email, 'DoctorPassword123!') };
}

const ENCOUNTER = {
  presentingComplaint: 'Fever and headache for three days',
  historyOfPresentingComplaint: 'Intermittent fever, worse at night, no rash',
  examinationFindings: 'Alert, not in distress. Abdominal palpation not possible remotely.',
  clinicalAssessment: 'Likely uncomplicated malaria',
  diagnosis: 'Suspected malaria',
  treatmentPlan: 'Malaria RDT at the facility; if positive, treat per national guideline',
  followUp: 'Return in 3 days, or sooner if worse',
};

/** A patient registered, triaged, requested and accepted, with the doctor in the call. */
async function consultationInProgress() {
  const cho = await facilityWithCho('Alpha');
  const doctor = await onlineDoctor('Dr. Kojo Antwi');

  const registered = await request<{ patientNumber: string; visitPublicId: string }>(
    '/facility/patients',
    {
      method: 'POST',
      cookies: cho.cookies,
      payload: {
        fullName: 'Efua Asante',
        sex: 'FEMALE',
        ageYears: 28,
        community: 'Avenorpeme',
        allergies: 'Sulfa drugs',
        consentGivenBy: 'PATIENT',
        presentingComplaint: 'Fever and headache for three days',
      },
    },
  );
  const { patientNumber, visitPublicId } = registered.body.data!;
  await request(`/facility/visits/${visitPublicId}/triage`, {
    method: 'POST',
    cookies: cho.cookies,
    payload: { category: 'YELLOW', vitals: { temperatureC: 38.6, pulseBpm: 104 } },
  });
  await request(`/facility/visits/${visitPublicId}/consultation`, {
    method: 'POST',
    cookies: cho.cookies,
    payload: { languageCode: 'en', type: 'VIDEO', note: 'Lives far; cannot return easily' },
  });

  const consultation = await getPrisma().consultation.findFirstOrThrow();
  const publicId = consultation.publicId;
  await request(`/doctor/consultations/${publicId}/accept`, {
    method: 'POST',
    cookies: doctor.cookies,
  });
  await request(`/doctor/consultations/${publicId}/media/join`, {
    method: 'POST',
    cookies: doctor.cookies,
  });

  return { cho, doctor, patientNumber, visitPublicId, publicId };
}

describe('the doctor’s side of a CHPS consultation', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('shows the doctor the CHO’s assessment and note, and logs that they read it', async () => {
    const { doctor, publicId } = await consultationInProgress();

    const context = await request<ChpsConsultationContext>(
      `/doctor/consultations/${publicId}/chps`,
      { cookies: doctor.cookies },
    );
    expect(context.status).toBe(200);
    expect(context.body.data).toMatchObject({
      facility: { name: 'Alpha CHPS', region: 'Volta' },
      patient: { fullName: 'Efua Asante', allergies: 'Sulfa drugs' },
      visit: {
        presentingComplaint: 'Fever and headache for three days',
        choNote: 'Lives far; cannot return easily',
        triage: { category: 'YELLOW', vitals: { temperatureC: 38.6 }, recordedBy: 'Alpha CHO' },
      },
      priorVisits: [],
      encounter: null,
    });

    const access = await getPrisma().patientRecordAccess.findMany({
      where: { actorRole: 'DOCTOR' },
    });
    expect(access).toHaveLength(1);
  });

  it('keeps the context from any doctor not assigned to the consultation', async () => {
    const { publicId } = await consultationInProgress();
    const other = await onlineDoctor('Dr. Other');

    expect(
      (await request(`/doctor/consultations/${publicId}/chps`, { cookies: other.cookies })).status,
    ).toBe(404);
    expect(
      (
        await request(`/doctor/consultations/${publicId}/encounter`, {
          method: 'PUT',
          cookies: other.cookies,
          payload: { content: ENCOUNTER },
        })
      ).status,
    ).toBe(404);
  });

  it('will not complete without an assessment and a plan', async () => {
    const { doctor, publicId } = await consultationInProgress();

    await request(`/doctor/consultations/${publicId}/encounter`, {
      method: 'PUT',
      cookies: doctor.cookies,
      payload: { content: { presentingComplaint: 'Fever' } },
    });
    const refused = await request(`/doctor/consultations/${publicId}/complete`, {
      method: 'POST',
      cookies: doctor.cookies,
      payload: { outcomes: ['ADVICE_ONLY'] },
    });
    expect(refused.status).toBe(422);
    expect(refused.body.error?.message).toMatch(/clinical assessment and treatment plan/);
  });

  it('finalises the record on completion, keeps it readable, and versions every amendment', async () => {
    const { doctor, publicId } = await consultationInProgress();

    // Drafts overwrite: no versions until completion.
    for (const content of [{ clinicalAssessment: 'first thought' }, ENCOUNTER]) {
      await request(`/doctor/consultations/${publicId}/encounter`, {
        method: 'PUT',
        cookies: doctor.cookies,
        payload: { content },
      });
    }
    expect(await getPrisma().encounterRecordVersion.count()).toBe(0);

    const completed = await request(`/doctor/consultations/${publicId}/complete`, {
      method: 'POST',
      cookies: doctor.cookies,
      payload: { outcomes: ['ADVICE_ONLY'] },
    });
    expect(completed.status).toBe(200);

    // Not sealed: the doctor can still read what they wrote (D74, D78).
    const after = await request<ChpsConsultationContext>(`/doctor/consultations/${publicId}/chps`, {
      cookies: doctor.cookies,
    });
    expect(after.body.data!.encounter).toMatchObject({
      version: 1,
      content: { clinicalAssessment: 'Likely uncomplicated malaria' },
      vitalsSnapshot: { temperatureC: 38.6, pulseBpm: 104 },
    });
    expect(after.body.data!.encounter!.finalisedAt).not.toBeNull();

    const unexplained = await request(`/doctor/consultations/${publicId}/encounter`, {
      method: 'PUT',
      cookies: doctor.cookies,
      payload: { content: { ...ENCOUNTER, diagnosis: 'Malaria, RDT positive' } },
    });
    expect(unexplained.status).toBe(422);

    const amended = await request<EncounterView>(`/doctor/consultations/${publicId}/encounter`, {
      method: 'PUT',
      cookies: doctor.cookies,
      payload: {
        content: { ...ENCOUNTER, diagnosis: 'Malaria, RDT positive' },
        amendmentReason: 'RDT result reported by the CHO',
      },
    });
    expect(amended.body.data).toMatchObject({
      version: 2,
      content: { diagnosis: 'Malaria, RDT positive' },
      versions: [
        { version: 1, author: 'Dr. Kojo Antwi', reason: null },
        { version: 2, author: 'Dr. Kojo Antwi', reason: 'RDT result reported by the CHO' },
      ],
    });
    expect(await getPrisma().auditLog.count({ where: { action: 'encounter.amended' } })).toBe(1);
  });

  it('runs a walk-in from the door to the doctor’s advice (Scenario 1)', async () => {
    const { cho, doctor, patientNumber, visitPublicId, publicId } = await consultationInProgress();

    // The station, paired and showing the patient.
    const pairing = await request<StationPairing>('/facility/stations', {
      method: 'POST',
      cookies: cho.cookies,
      payload: { label: 'Tablet' },
    });
    const paired = await request('/station/pair', {
      method: 'POST',
      payload: { code: pairing.body.data!.pairingCode },
    });
    const station = { neem_station: paired.cookies.neem_station! };
    await request(`/facility/visits/${visitPublicId}/station`, {
      method: 'POST',
      cookies: cho.cookies,
      payload: { stationPublicId: pairing.body.data!.station.publicId },
    });
    const live = await request<StationState>('/station/state', { cookies: station });
    expect(live.body.data).toMatchObject({ mode: 'READY', patientFirstName: 'Efua' });
    expect(
      (
        await request('/station/join', {
          method: 'POST',
          cookies: station,
          headers: { 'x-neem-station': '1' },
        })
      ).status,
    ).toBe(200);

    // Before completion, the CHO sees no draft.
    const before = await request<PatientRecord>(`/facility/patients/${patientNumber}`, {
      cookies: cho.cookies,
    });
    expect(before.body.data!.visits[0]!.encounter).toBeNull();

    await request(`/doctor/consultations/${publicId}/encounter`, {
      method: 'PUT',
      cookies: doctor.cookies,
      payload: { content: ENCOUNTER },
    });
    await request(`/doctor/consultations/${publicId}/complete`, {
      method: 'POST',
      cookies: doctor.cookies,
      payload: { outcomes: ['ADVICE_ONLY'] },
    });

    // The CHO sees what to do next.
    const record = await request<PatientRecord>(`/facility/patients/${patientNumber}`, {
      cookies: cho.cookies,
    });
    expect(record.body.data!.visits[0]).toMatchObject({
      consultation: { state: 'COMPLETED', doctorName: 'Dr. Kojo Antwi', active: false },
      encounter: {
        doctorName: 'Dr. Kojo Antwi',
        treatmentPlan: ENCOUNTER.treatmentPlan,
        followUp: ENCOUNTER.followUp,
        version: 1,
      },
    });

    // The station has forgotten the patient.
    const idle = await request<StationState>('/station/state', { cookies: station });
    expect(idle.body.data).toMatchObject({ mode: 'IDLE', patientFirstName: null });

    // And the CHO can now close the visit.
    const closed = await request(`/facility/visits/${visitPublicId}/close`, {
      method: 'POST',
      cookies: cho.cookies,
      payload: { outcome: 'CLOSED', note: 'Advised per doctor; RDT done' },
    });
    expect(closed.status).toBe(200);
  });

  it('shows the next doctor what earlier visits concluded', async () => {
    const { cho, doctor, patientNumber, visitPublicId, publicId } = await consultationInProgress();
    await request(`/doctor/consultations/${publicId}/encounter`, {
      method: 'PUT',
      cookies: doctor.cookies,
      payload: { content: ENCOUNTER },
    });
    await request(`/doctor/consultations/${publicId}/complete`, {
      method: 'POST',
      cookies: doctor.cookies,
      payload: { outcomes: ['ADVICE_ONLY'] },
    });
    await request(`/facility/visits/${visitPublicId}/close`, {
      method: 'POST',
      cookies: cho.cookies,
      payload: { outcome: 'CLOSED', note: 'Done' },
    });

    // She comes back.
    const second = await request<{ visitPublicId: string }>(
      `/facility/patients/${patientNumber}/visits`,
      { method: 'POST', cookies: cho.cookies, payload: { presentingComplaint: 'Still feverish' } },
    );
    const visit = second.body.data!.visitPublicId;
    await request(`/facility/visits/${visit}/triage`, {
      method: 'POST',
      cookies: cho.cookies,
      payload: { category: 'ORANGE' },
    });
    await request(`/facility/visits/${visit}/consultation`, {
      method: 'POST',
      cookies: cho.cookies,
      payload: { languageCode: 'en', type: 'AUDIO' },
    });
    const next = await getPrisma().consultation.findFirstOrThrow({
      where: { visit: { publicId: visit } },
    });
    await request(`/doctor/consultations/${next.publicId}/accept`, {
      method: 'POST',
      cookies: doctor.cookies,
    });

    const context = await request<ChpsConsultationContext>(
      `/doctor/consultations/${next.publicId}/chps`,
      { cookies: doctor.cookies },
    );
    expect(context.body.data!.priorVisits).toHaveLength(1);
    expect(context.body.data!.priorVisits[0]).toMatchObject({
      presentingComplaint: 'Fever and headache for three days',
      encounter: { diagnosis: 'Suspected malaria', doctorName: 'Dr. Kojo Antwi' },
    });
  });
});
