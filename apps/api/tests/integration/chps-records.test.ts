import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  ChpsConsultationContext,
  PatientRecord,
  VisitAttachmentView,
  VisitPrescription,
} from '@neem/contracts';
import { disconnectPrisma, getPrisma } from '../../src/db/prisma.ts';
import { closeTestApp, getTestApp, minimalPng, request, signIn } from '../helpers/app.ts';
import { createTestUser, resetDatabase } from '../helpers/database.ts';
import { encryptField, generatePublicId } from '../../src/lib/crypto.ts';
import { goOnline } from '../../src/modules/queue/presence.service.ts';

/**
 * CHPS prescriptions dispensed at the facility, and files kept with a visit
 * (CHPS slice 2d, D83).
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
      fullName: 'Dr. Abena Sarpong',
      mdcNumber: `MDC-D-${suffix}`,
      qualification: 'MB ChB',
      practiceAddress: 'Ridge Clinic, Accra',
      mdcExpiresAt: expiry,
      status: 'ACTIVE',
      isDemo: true,
      languages: { create: [{ languageId: english.id, isPrimary: true }] },
      signatures: { create: { signatureDataEnc: encryptField('data:image/png;base64,AAAA') } },
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

/** A walk-in seen by the doctor, who issues a prescription. */
async function prescribed() {
  const cho = await facilityWithCho('Alpha');
  const doctor = await onlineDoctor();
  const created = await request<{ patientNumber: string; visitPublicId: string }>(
    '/facility/patients',
    {
      method: 'POST',
      cookies: cho.cookies,
      payload: {
        fullName: 'Akua Mensah',
        sex: 'FEMALE',
        ageYears: 26,
        community: 'Avenorpeme',
        consentGivenBy: 'PATIENT',
        presentingComplaint: 'Fever',
      },
    },
  );
  const { patientNumber, visitPublicId } = created.body.data!;
  await request(`/facility/visits/${visitPublicId}/triage`, {
    method: 'POST',
    cookies: cho.cookies,
    payload: { category: 'YELLOW' },
  });
  await request(`/facility/visits/${visitPublicId}/consultation`, {
    method: 'POST',
    cookies: cho.cookies,
    payload: { languageCode: 'en', type: 'AUDIO' },
  });
  const consultation = await getPrisma().consultation.findFirstOrThrow();
  const path = `/doctor/consultations/${consultation.publicId}`;
  await request(`${path}/accept`, { method: 'POST', cookies: doctor });
  await request(`${path}/media/join`, { method: 'POST', cookies: doctor });

  const draft = await request<{ publicId: string }>(`${path}/prescriptions`, {
    method: 'POST',
    cookies: doctor,
    payload: {
      items: [
        {
          medication: 'Artemether-lumefantrine',
          strength: '20/120 mg',
          form: 'Tablet',
          dose: '4 tablets',
          frequency: 'Twice daily',
          durationText: '3 days',
          quantity: '24 tablets',
        },
      ],
    },
  });
  const issued = await request(`/doctor/prescriptions/${draft.body.data!.publicId}/issue`, {
    method: 'POST',
    cookies: doctor,
    payload: {},
  });
  expect(issued.status).toBe(200);
  return {
    cho,
    doctor,
    patientNumber,
    visitPublicId,
    consultationPublicId: consultation.publicId,
    prescriptionPublicId: draft.body.data!.publicId,
  };
}

async function upload(
  cookies: Record<string, string>,
  visitPublicId: string,
  label: string,
  body: Buffer = minimalPng(),
  contentType = 'image/png',
) {
  const app = await getTestApp();
  const boundary = 'neemboundary';
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="label"\r\n\r\n${label}\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="scan.png"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`,
    ),
    body,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/facility/visits/${visitPublicId}/attachments`,
    payload,
    cookies,
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'x-neem-csrf': cookies.neem_csrf ?? '',
    },
  });
  return { status: response.statusCode, body: response.json() as { data?: VisitAttachmentView } };
}

describe('CHPS prescriptions and attachments', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('shows the CHO the doctor’s prescription, printable, and lets them dispense it once', async () => {
    const { cho, patientNumber, prescriptionPublicId } = await prescribed();

    const record = await request<PatientRecord>(`/facility/patients/${patientNumber}`, {
      cookies: cho.cookies,
    });
    expect(record.body.data!.visits[0]!.prescriptions).toEqual([
      expect.objectContaining({
        publicId: prescriptionPublicId,
        doctorName: 'Dr. Abena Sarpong',
        dispensedHere: false,
        items: [expect.objectContaining({ medication: 'Artemether-lumefantrine' })],
      }),
    ]);

    const pdf = await request(`/documents/prescriptions/${prescriptionPublicId}.pdf`, {
      cookies: cho.cookies,
    });
    expect(pdf.status).toBe(200);
    expect(pdf.raw.headers['content-type']).toBe('application/pdf');

    const dispensed = await request<VisitPrescription>(
      `/facility/prescriptions/${prescriptionPublicId}/dispense`,
      { method: 'POST', cookies: cho.cookies, payload: {} },
    );
    expect(dispensed.body.data).toMatchObject({ state: 'DISPENSED', dispensedHere: true });

    const again = await request(`/facility/prescriptions/${prescriptionPublicId}/dispense`, {
      method: 'POST',
      cookies: cho.cookies,
      payload: {},
    });
    expect(again.status).toBe(409);
  });

  it('keeps another facility from printing or dispensing it', async () => {
    const { prescriptionPublicId } = await prescribed();
    const beta = await facilityWithCho('Beta');

    expect(
      (
        await request(`/documents/prescriptions/${prescriptionPublicId}.pdf`, {
          cookies: beta.cookies,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(`/facility/prescriptions/${prescriptionPublicId}/dispense`, {
          method: 'POST',
          cookies: beta.cookies,
          payload: {},
        })
      ).status,
    ).toBe(404);
  });

  it('stores a visit’s file encrypted, and gives it to the facility and the doctor only', async () => {
    const { cho, doctor, patientNumber, visitPublicId, consultationPublicId } = await prescribed();

    const added = await upload(cho.cookies, visitPublicId, 'Malaria RDT photo');
    expect(added.status).toBe(201);
    const attachment = added.body.data!;
    expect(attachment).toMatchObject({ label: 'Malaria RDT photo', uploadedBy: 'Alpha CHO' });

    // Encrypted at rest: the stored bytes are not the PNG.
    const row = await getPrisma().visitAttachment.findFirstOrThrow();
    const { getStorageProvider } =
      await import('../../src/adapters/storage/local-storage.provider.ts');
    const stored = await getStorageProvider().get(row.storageKey);
    expect(stored.subarray(0, 8).equals(minimalPng().subarray(0, 8))).toBe(false);

    const mine = await request(`/facility/attachments/${attachment.publicId}`, {
      cookies: cho.cookies,
    });
    expect(mine.status).toBe(200);
    expect(Buffer.from(mine.raw.rawPayload).equals(minimalPng())).toBe(true);

    const theDoctor = await request(
      `/doctor/consultations/${consultationPublicId}/attachments/${attachment.publicId}`,
      { cookies: doctor },
    );
    expect(theDoctor.status).toBe(200);

    const context = await request<ChpsConsultationContext>(
      `/doctor/consultations/${consultationPublicId}/chps`,
      { cookies: doctor },
    );
    expect(context.body.data!.visit.attachments).toEqual([
      expect.objectContaining({ publicId: attachment.publicId }),
    ]);

    const record = await request<PatientRecord>(`/facility/patients/${patientNumber}`, {
      cookies: cho.cookies,
    });
    expect(record.body.data!.visits[0]!.attachments).toHaveLength(1);

    const beta = await facilityWithCho('Beta');
    expect(
      (await request(`/facility/attachments/${attachment.publicId}`, { cookies: beta.cookies }))
        .status,
    ).toBe(404);
  });

  it('refuses a file whose contents are not what it claims', async () => {
    const { cho, visitPublicId } = await prescribed();
    const fake = await upload(cho.cookies, visitPublicId, 'Not really a PNG', Buffer.from('hello'));
    expect(fake.status).toBe(400);
    const noLabel = await upload(cho.cookies, visitPublicId, '');
    expect(noLabel.status).toBe(400);
  });
});
