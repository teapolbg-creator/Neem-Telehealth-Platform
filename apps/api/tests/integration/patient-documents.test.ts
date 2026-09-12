import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getPrisma, disconnectPrisma } from '../../src/db/prisma.ts';
import { closeTestApp, request, signIn } from '../helpers/app.ts';
import { createTestPharmacy, createTestUser, resetDatabase } from '../helpers/database.ts';
import { transition } from '../../src/modules/consultation/consultation.service.ts';
import {
  createDraft,
  dispensePrescription,
  issuePrescription,
  revokePrescription,
} from '../../src/modules/prescription/prescription.service.ts';
import { completeConsultation } from '../../src/modules/clinical/clinical.service.ts';
import {
  generatePrescriptionPdf,
  issueReferral,
  issueSummary,
} from '../../src/modules/documents/document.service.ts';
import { encryptField, generatePublicId, hashToken } from '../../src/lib/crypto.ts';

/**
 * The documents reaching the people entitled to them.
 *
 * Until these routes existed, a consultation could issue a prescription, a
 * referral and a summary, render all three to PDF, store them — and offer the
 * patient no way to read any of them. The documents were reachable by the
 * doctor, the dispensing pharmacy and an administrator; the person they were
 * written for had no route at all, while the route serving prescriptions
 * carried a comment saying the patient could fetch one through their session.
 *
 * What is asserted here is mostly the boundary rather than the happy path,
 * because the boundary is where this goes wrong: a patient session is scoped
 * to exactly one consultation (spec §102), and a document route that takes an
 * identifier from the client is the obvious way to lose that property.
 */

const PHARMACY_PASSWORD = 'PharmacyPassword123!';
const DOCTOR_PASSWORD = 'DoctorPassword123!';

const ITEM = {
  medication: 'Amoxicillin',
  strength: '500mg',
  form: 'Capsule',
  dose: '1 capsule',
  frequency: 'Three times daily',
  durationText: '5 days',
  quantity: '15 capsules',
  instructions: 'After food.',
};

interface Scenario {
  consultationId: string;
  consultationPublicId: string;
  doctorId: string;
  pharmacyId: string;
  pharmacyName: string;
  pharmacyUserEmail: string;
  doctorEmail: string;
  /** A draft the doctor started and never issued. Live scenarios only. */
  draftPublicId: string | null;
  patientCookies: Record<string, string>;
}

/**
 * A consultation with a bound patient device session.
 *
 * Completed by default, carrying all three document types. Left IN_PROGRESS
 * with an unissued draft when { complete: false } — which is the only state in
 * which a draft can exist at all: completion refuses to proceed while one is
 * outstanding ("issue it or discard it before completing"), so an abandoned
 * draft on a finished consultation is not a case that can be reached.
 */
async function buildScenario(options: { complete?: boolean } = {}): Promise<Scenario> {
  const complete = options.complete !== false;
  const prisma = getPrisma();
  const suffix = generatePublicId('x').slice(-8).toLowerCase();

  const pharmacyName = `Pharmacy ${suffix}`;
  const pharmacy = await createTestPharmacy(pharmacyName, 'ACTIVE');
  const pharmacyUser = await createTestUser({
    email: `${suffix}@pharmacy.test`,
    password: PHARMACY_PASSWORD,
    role: 'PHARMACY',
  });
  await prisma.pharmacyUser.create({
    data: { pharmacyId: pharmacy.id, userId: pharmacyUser.id },
  });

  const doctorUser = await createTestUser({
    email: `${suffix}@doctor.test`,
    password: DOCTOR_PASSWORD,
    role: 'DOCTOR',
  });
  const expiry = new Date();
  expiry.setFullYear(expiry.getFullYear() + 1);
  const doctor = await prisma.doctor.create({
    data: {
      publicId: generatePublicId('doc'),
      userId: doctorUser.id,
      fullName: 'Dr. Kofi Asante',
      mdcNumber: `MDC-DOC-${suffix}`,
      mdcExpiresAt: expiry,
      status: 'ACTIVE',
      isDemo: true,
      signatures: { create: { signatureDataEnc: encryptField('data:image/png;base64,AAAA') } },
    },
  });

  const pharmacyCookies = await signIn(pharmacyUser.email, PHARMACY_PASSWORD);
  const created = await request<{ publicId: string }>('/pharmacy/consultations', {
    method: 'POST',
    cookies: pharmacyCookies,
    payload: {},
  });
  const consultationPublicId = created.body.data!.publicId;
  const consultation = await prisma.consultation.findUniqueOrThrow({
    where: { publicId: consultationPublicId },
  });

  const sessionToken = `patient-session-${generatePublicId('x')}`;
  await prisma.patientSession.create({
    data: {
      consultationId: consultation.id,
      fullNameEnc: encryptField('Adwoa Mensah'),
      age: 34,
      sex: 'FEMALE',
      phoneEnc: encryptField('0245551234'),
      deviceSessionTokenHash: hashToken(sessionToken),
      deviceBoundAt: new Date(),
    },
  });

  await prisma.consultation.update({
    where: { id: consultation.id },
    data: { doctorId: doctor.id, type: 'VIDEO' },
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

  if (!complete) {
    const outstanding = await createDraft(consultation.id, doctor.id, [ITEM]);
    return {
      consultationId: consultation.id,
      consultationPublicId,
      doctorId: doctor.id,
      pharmacyId: pharmacy.id,
      pharmacyName,
      pharmacyUserEmail: pharmacyUser.email,
      doctorEmail: doctorUser.email,
      draftPublicId: outstanding.publicId,
      patientCookies: { neem_patient: sessionToken },
    };
  }

  // All three outcomes on one consultation, so the listing is exercised whole.
  const draft = await createDraft(consultation.id, doctor.id, [ITEM]);
  await issuePrescription(draft.id, doctor.id);
  await generatePrescriptionPdf(draft.id);

  await issueReferral(consultation.id, doctor.id, {
    hospitalName: 'Korle Bu Teaching Hospital',
    department: 'General Medicine',
    reasonText: 'For assessment.',
    urgency: 'ROUTINE',
  });

  await issueSummary(consultation.id, doctor.id, {
    presentingComplaint: 'Sore throat for three days.',
    assessment: 'Likely viral. No antibiotic indicated beyond the prescription issued.',
    advice: 'Rest and fluids.',
    safetyNetting: 'Return immediately if breathing becomes difficult.',
  });

  await completeConsultation(consultation.id, doctor.id, { outcome: 'PRESCRIPTION' });

  return {
    consultationId: consultation.id,
    consultationPublicId,
    doctorId: doctor.id,
    pharmacyId: pharmacy.id,
    pharmacyName,
    pharmacyUserEmail: pharmacyUser.email,
    doctorEmail: doctorUser.email,
    draftPublicId: null,
    patientCookies: { neem_patient: sessionToken },
  };
}

interface ListedDocument {
  kind: string;
  publicId: string;
  title: string;
  available: boolean;
  status: { code: string; label: string; detail: string | null };
}

const listDocuments = (cookies: Record<string, string>) =>
  request<{ documents: ListedDocument[] }>('/patient/documents', { cookies });

beforeEach(resetDatabase);
afterAll(async () => {
  await closeTestApp();
  await disconnectPrisma();
});

describe('a patient reading their own documents', () => {
  it('lists all three documents the consultation produced', async () => {
    const scenario = await buildScenario();

    const listed = await listDocuments(scenario.patientCookies);
    const kinds = listed.body.data!.documents.map((document) => document.kind);

    expect(listed.status).toBe(200);
    expect(kinds).toEqual(['prescription', 'referral', 'summary']);
  });

  it('serves each one as a PDF', async () => {
    const scenario = await buildScenario();
    const documents = (await listDocuments(scenario.patientCookies)).body.data!.documents;

    for (const document of documents) {
      const response = await request(
        `/patient/documents/${document.kind}/${document.publicId}.pdf`,
        {
          cookies: scenario.patientCookies,
        },
      );

      expect(response.status, `${document.kind} should be readable`).toBe(200);
      expect(response.raw.headers['content-type']).toContain('application/pdf');
      // A PDF, not an error page that happens to have the right content type.
      expect(response.raw.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    }
  });

  it('records the read in the audit trail, as every other document read is', async () => {
    const scenario = await buildScenario();
    const documents = (await listDocuments(scenario.patientCookies)).body.data!.documents;
    const prescription = documents.find((document) => document.kind === 'prescription')!;

    await request(`/patient/documents/prescription/${prescription.publicId}.pdf`, {
      cookies: scenario.patientCookies,
    });

    const entry = await getPrisma().auditLog.findFirst({
      where: {
        action: 'document.downloaded',
        actorType: 'PATIENT',
        entityId: prescription.publicId,
      },
    });

    expect(entry).not.toBeNull();
  });
});

describe('the boundary around a patient session', () => {
  /**
   * The failure this whole file exists to prevent.
   *
   * Two unrelated consultations, and the second patient asks for the first
   * patient's prescription by its public id. It must not matter that the id is
   * real — the session names the consultation, and a document outside it does
   * not exist as far as this caller is concerned.
   */
  it('refuses another consultation’s document, even with a valid id', async () => {
    const alpha = await buildScenario();
    const beta = await buildScenario();

    const alphaDocuments = (await listDocuments(alpha.patientCookies)).body.data!.documents;
    const target = alphaDocuments.find((document) => document.kind === 'prescription')!;

    const response = await request(`/patient/documents/prescription/${target.publicId}.pdf`, {
      cookies: beta.patientCookies,
    });

    expect(response.status).toBe(404);
  });

  it('does not leak other consultations into the listing', async () => {
    const alpha = await buildScenario();
    const beta = await buildScenario();

    const alphaIds = (await listDocuments(alpha.patientCookies)).body.data!.documents.map(
      (document) => document.publicId,
    );
    const betaIds = (await listDocuments(beta.patientCookies)).body.data!.documents.map(
      (document) => document.publicId,
    );

    expect(alphaIds).toHaveLength(3);
    expect(betaIds).toHaveLength(3);
    expect(alphaIds.filter((id) => betaIds.includes(id))).toEqual([]);
  });

  it('refuses a request with no patient session at all', async () => {
    await buildScenario();

    const response = await request('/patient/documents');

    expect(response.status).toBe(401);
  });

  /**
   * A draft is not a document. It is the doctor's working screen, changeable
   * until issued, and a patient reading one would be reading something nobody
   * has yet decided to give them.
   */
  /*
   * A live consultation, because that is the only place a draft exists.
   *
   * Two of the service's own rules had to be learned to write this. A draft
   * cannot be created after completion ("a prescription can only be written
   * during a consultation"), and a consultation cannot be completed while one
   * is outstanding ("issue it or discard it before completing"). Together they
   * mean a draft on a finished consultation is unreachable — so the scenario
   * worth testing is the one that does occur: the patient's phone is live,
   * their session resolves, and the doctor is part-way through writing.
   */
  it('never lists or serves a draft prescription', async () => {
    const scenario = await buildScenario({ complete: false });

    const documents = (await listDocuments(scenario.patientCookies)).body.data!.documents;
    expect(documents.map((document) => document.publicId)).not.toContain(scenario.draftPublicId);

    const response = await request(
      `/patient/documents/prescription/${scenario.draftPublicId}.pdf`,
      { cookies: scenario.patientCookies },
    );
    expect(response.status).toBe(404);
  });
});

describe('what the status beside a document says', () => {
  /**
   * The PDF is written once at issue and never rewritten, so it cannot report
   * a dispense that happened afterwards. The status is read live for exactly
   * that reason, and these assert it tracks the prescription rather than the
   * paper.
   */
  it('says not yet dispensed, and names the pharmacy that can', async () => {
    const scenario = await buildScenario();

    const prescription = (await listDocuments(scenario.patientCookies)).body.data!.documents.find(
      (document) => document.kind === 'prescription',
    )!;

    expect(prescription.status.code).toBe('AWAITING_DISPENSE');
    expect(prescription.status.detail).toContain(scenario.pharmacyName);
  });

  it('says dispensed once it has been, without the PDF changing', async () => {
    const scenario = await buildScenario();
    const before = (await listDocuments(scenario.patientCookies)).body.data!.documents.find(
      (document) => document.kind === 'prescription',
    )!;

    const prescriptionRow = await getPrisma().prescription.findFirstOrThrow({
      where: { consultationId: scenario.consultationId, state: { not: 'DRAFT' } },
    });
    const pharmacyUser = await getPrisma().user.findUniqueOrThrow({
      where: { email: scenario.pharmacyUserEmail },
    });
    await dispensePrescription(prescriptionRow.id, scenario.pharmacyId, pharmacyUser.id);

    const after = (await listDocuments(scenario.patientCookies)).body.data!.documents.find(
      (document) => document.kind === 'prescription',
    )!;

    expect(before.status.code).toBe('AWAITING_DISPENSE');
    expect(after.status.code).toBe('DISPENSED');
    expect(after.status.detail).toContain(scenario.pharmacyName);
    // Same document, different status: the stored PDF is untouched.
    expect(after.publicId).toBe(before.publicId);
  });

  it('says revoked, and does not repeat the doctor’s reason', async () => {
    const scenario = await buildScenario();
    const prescriptionRow = await getPrisma().prescription.findFirstOrThrow({
      where: { consultationId: scenario.consultationId, state: { not: 'DRAFT' } },
    });

    const reason = 'Interaction with an existing medication the patient later disclosed';
    await revokePrescription(prescriptionRow.id, scenario.doctorId, reason);

    const prescription = (await listDocuments(scenario.patientCookies)).body.data!.documents.find(
      (document) => document.kind === 'prescription',
    )!;

    expect(prescription.status.code).toBe('REVOKED');
    // The reason is free text a doctor wrote and can carry clinical detail.
    // It must not surface on a screen held up at a counter (spec §60).
    expect(prescription.status.detail).not.toContain('medication');
  });
});

/**
 * The staff side of the same documents.
 *
 * Referrals and summaries had no download route for anybody: a doctor could
 * refer a patient to Korle Bu and then neither they nor the pharmacy could
 * open the document afterwards. Only prescriptions had one, which is why the
 * three now share a handler — the permission rule is identical, and writing it
 * once is the only way to be sure the newer two are not quietly laxer than the
 * one that was reviewed.
 */
describe('staff reading a document', () => {
  const staffPath: Record<string, string> = {
    prescription: 'prescriptions',
    referral: 'referrals',
    summary: 'summaries',
  };

  async function documentsOf(scenario: Scenario) {
    return (await listDocuments(scenario.patientCookies)).body.data!.documents;
  }

  it('serves all three kinds to the issuing doctor', async () => {
    const scenario = await buildScenario();
    const cookies = await signIn(scenario.doctorEmail, DOCTOR_PASSWORD);

    for (const document of await documentsOf(scenario)) {
      const response = await request(
        `/documents/${staffPath[document.kind]}/${document.publicId}.pdf`,
        { cookies },
      );

      expect(response.status, document.kind).toBe(200);
      expect(response.raw.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    }
  });

  it('serves all three kinds to the consultation’s pharmacy', async () => {
    const scenario = await buildScenario();
    const cookies = await signIn(scenario.pharmacyUserEmail, PHARMACY_PASSWORD);

    for (const document of await documentsOf(scenario)) {
      const response = await request(
        `/documents/${staffPath[document.kind]}/${document.publicId}.pdf`,
        { cookies },
      );

      expect(response.status, document.kind).toBe(200);
    }
  });

  /**
   * The reason the three share one handler.
   *
   * A second doctor and a second pharmacy, entirely unrelated, asking for the
   * first consultation's documents by ids that are real. 404 rather than 403
   * throughout: whether somebody else's referral exists is not something to be
   * learned from the shape of a refusal (spec §102).
   */
  it('refuses every kind to an unrelated doctor and an unrelated pharmacy', async () => {
    const alpha = await buildScenario();
    const beta = await buildScenario();

    const intruders = [
      await signIn(beta.doctorEmail, DOCTOR_PASSWORD),
      await signIn(beta.pharmacyUserEmail, PHARMACY_PASSWORD),
    ];

    for (const document of await documentsOf(alpha)) {
      for (const cookies of intruders) {
        const response = await request(
          `/documents/${staffPath[document.kind]}/${document.publicId}.pdf`,
          { cookies },
        );

        expect(response.status, document.kind).toBe(404);
      }
    }
  });

  it('refuses every kind to a stranger with no session', async () => {
    const scenario = await buildScenario();

    for (const document of await documentsOf(scenario)) {
      const response = await request(
        `/documents/${staffPath[document.kind]}/${document.publicId}.pdf`,
      );

      expect(response.status, document.kind).toBe(401);
    }
  });

  /**
   * A regression guard on the refactor.
   *
   * The prescription route already refused drafts before the three were
   * merged into one handler. Folding that rule into a shared finder is exactly
   * the kind of change that drops a condition nobody was watching.
   */
  it('still refuses a draft prescription after the three routes were merged', async () => {
    const scenario = await buildScenario({ complete: false });
    const cookies = await signIn(scenario.doctorEmail, DOCTOR_PASSWORD);

    const response = await request(`/documents/prescriptions/${scenario.draftPublicId}.pdf`, {
      cookies,
    });

    expect(response.status).toBe(404);
  });

  it('audits the read under the kind that was read', async () => {
    const scenario = await buildScenario();
    const cookies = await signIn(scenario.doctorEmail, DOCTOR_PASSWORD);
    const referral = (await documentsOf(scenario)).find(
      (document) => document.kind === 'referral',
    )!;

    await request(`/documents/referrals/${referral.publicId}.pdf`, { cookies });

    const entry = await getPrisma().auditLog.findFirst({
      where: { action: 'document.downloaded', actorType: 'DOCTOR', entityType: 'referral' },
    });

    expect(entry).not.toBeNull();
  });
});
