import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getPrisma, disconnectPrisma } from '../../src/db/prisma.ts';
import { closeTestApp, request, signIn } from '../helpers/app.ts';
import { createTestPharmacy, createTestUser, resetDatabase } from '../helpers/database.ts';
import {
  MockPaymentProvider,
  setPaymentProviderForTesting,
} from '../../src/adapters/payment/index.ts';
import { transition } from '../../src/modules/consultation/consultation.service.ts';
import {
  createDraft,
  decideSubstitution,
  dispensePrescription,
  issuePrescription,
  proposeSubstitution,
  revokePrescription,
} from '../../src/modules/prescription/prescription.service.ts';
import { completeConsultation } from '../../src/modules/clinical/clinical.service.ts';
import {
  generatePrescriptionPdf,
  issueReferral,
  issueSummary,
  readDocumentPdf,
} from '../../src/modules/documents/document.service.ts';
import { encryptField, generatePublicId } from '../../src/lib/crypto.ts';

/**
 * Prescriptions end to end (spec §41–§48, §82).
 *
 * Covers required §80 scenarios 6 (a prescription reaches the pharmacy),
 * 9 (revoked before dispensing) and 10 (a dispensed prescription cannot be
 * revoked), plus the substitution workflow of scenarios 7 and 8.
 */

const PHARMACY_PASSWORD = 'PharmacyPassword123!';
const DOCTOR_PASSWORD = 'DoctorPassword123!';

interface Fixture {
  consultationId: string;
  consultationPublicId: string;
  doctorId: string;
  doctorEmail: string;
  pharmacyId: string;
  pharmacyUserId: string;
}

/** A consultation IN_PROGRESS with an active, signed doctor and a patient. */
async function liveConsultation(): Promise<Fixture> {
  const prisma = getPrisma();
  const suffix = generatePublicId('x').slice(-8);

  const pharmacy = await createTestPharmacy(`Pharmacy ${suffix}`, 'ACTIVE');
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
      fullName: 'Dr. Ama Boateng',
      mdcNumber: `MDC-RX-${suffix}`,
      mdcExpiresAt: expiry,
      status: 'ACTIVE',
      isDemo: true,
      // A prescription cannot be issued unsigned.
      signatures: { create: { signatureDataEnc: encryptField('data:image/png;base64,AAAA') } },
    },
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

  // Drive it to IN_PROGRESS through the state machine rather than by writing
  // the column, so the transitions are the real ones.
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

  return {
    consultationId: consultation.id,
    consultationPublicId: publicId,
    doctorId: doctor.id,
    doctorEmail: doctorUser.email,
    pharmacyId: pharmacy.id,
    pharmacyUserId: pharmacyUser.id,
  };
}

const ITEM = {
  medication: 'Amoxicillin',
  strength: '500mg',
  form: 'Capsule',
  dose: '1 capsule',
  frequency: 'Three times daily',
  durationText: '5 days',
  quantity: '15 capsules',
};

async function issuedPrescription(fixture: Fixture) {
  const draft = await createDraft(fixture.consultationId, fixture.doctorId, [ITEM]);
  return issuePrescription(draft.id, fixture.doctorId);
}

beforeEach(async () => {
  await resetDatabase();
  setPaymentProviderForTesting(new MockPaymentProvider());
});

afterAll(async () => {
  setPaymentProviderForTesting(undefined);
  await closeTestApp();
  await disconnectPrisma();
});

// ---------------------------------------------------------------------------
// Scenario 6 — issuing
// ---------------------------------------------------------------------------

describe('issuing a prescription', () => {
  it('reaches the pharmacy as ACTIVE, signed and carrying the patient by value', async () => {
    const fixture = await liveConsultation();
    const prescription = await issuedPrescription(fixture);

    expect(prescription.state).toBe('ACTIVE');
    expect(prescription.signatureId).not.toBeNull();
    expect(prescription.issuedAt).not.toBeNull();

    // Copied by value, so the document survives the sealing of the clinical
    // record and is not a pointer into it (spec §11, D23).
    expect(prescription.patientName).toBe('Adwoa Mensah');
    expect(prescription.patientAge).toBe(34);
  });

  it('keeps a draft invisible until issued', async () => {
    const fixture = await liveConsultation();
    const draft = await createDraft(fixture.consultationId, fixture.doctorId, [ITEM]);

    expect(draft.state).toBe('DRAFT');
    // A draft carries no signature: it is not yet a document.
    expect(draft.signatureId).toBeNull();
  });

  it('records the issued version, so what was signed is recoverable', async () => {
    const fixture = await liveConsultation();
    const prescription = await issuedPrescription(fixture);

    const version = await getPrisma().prescriptionVersion.findFirstOrThrow({
      where: { prescriptionId: prescription.id },
    });
    expect(version.state).toBe('ISSUED');
    expect(JSON.stringify(version.snapshot)).toContain('Amoxicillin');
  });

  it('refuses to issue without a signature', async () => {
    const fixture = await liveConsultation();
    await getPrisma().doctorSignature.updateMany({
      where: { doctorId: fixture.doctorId },
      data: { isActive: false },
    });

    const draft = await createDraft(fixture.consultationId, fixture.doctorId, [ITEM]);

    await expect(issuePrescription(draft.id, fixture.doctorId)).rejects.toThrow(
      /not captured a digital signature/i,
    );
  });

  it('refuses to issue from a suspended doctor', async () => {
    const fixture = await liveConsultation();
    const draft = await createDraft(fixture.consultationId, fixture.doctorId, [ITEM]);

    // Suspension mid-consultation must stop the artefact that outlives the
    // session (spec §22, §55).
    await getPrisma().doctor.update({
      where: { id: fixture.doctorId },
      data: { status: 'SUSPENDED' },
    });

    await expect(issuePrescription(draft.id, fixture.doctorId)).rejects.toThrow(
      /only an active doctor/i,
    );
  });

  it('refuses to issue on an expired MDC licence', async () => {
    const fixture = await liveConsultation();
    const draft = await createDraft(fixture.consultationId, fixture.doctorId, [ITEM]);

    await getPrisma().doctor.update({
      where: { id: fixture.doctorId },
      data: { mdcExpiresAt: new Date('2020-01-01') },
    });

    await expect(issuePrescription(draft.id, fixture.doctorId)).rejects.toThrow(/licence has expired/i);
  });

  it('refuses an empty prescription', async () => {
    const fixture = await liveConsultation();

    await expect(createDraft(fixture.consultationId, fixture.doctorId, [])).rejects.toThrow(
      /at least one medication/i,
    );
  });

  it('will not let another doctor write on this consultation', async () => {
    const fixture = await liveConsultation();
    const other = await liveConsultation();

    // 404, not 403 — the existence of another doctor's consultation is itself
    // not disclosed (spec §102).
    await expect(
      createDraft(fixture.consultationId, other.doctorId, [ITEM]),
    ).rejects.toThrow(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// Scenarios 9 and 10 — revocation and its limit
// ---------------------------------------------------------------------------

describe('revocation', () => {
  it('revokes before dispensing, with a recorded reason (scenario 9)', async () => {
    const fixture = await liveConsultation();
    const prescription = await issuedPrescription(fixture);

    const revoked = await revokePrescription(
      prescription.id,
      fixture.doctorId,
      'Patient reported a penicillin allergy after the consultation.',
    );

    expect(revoked.state).toBe('REVOKED');
    expect(revoked.revokedReason).toMatch(/penicillin/i);
    expect(revoked.revokedByDoctorId).toBe(fixture.doctorId);
  });

  it('refuses to revoke once dispensed (scenario 10, spec §82)', async () => {
    const fixture = await liveConsultation();
    const prescription = await issuedPrescription(fixture);

    await dispensePrescription(prescription.id, fixture.pharmacyId, fixture.pharmacyUserId);

    // The medicine is with the patient. A record claiming withdrawal when the
    // prescription was in fact filled would be worse than no record.
    await expect(
      revokePrescription(prescription.id, fixture.doctorId, 'Changed my mind'),
    ).rejects.toThrow(/already been dispensed/i);

    const fresh = await getPrisma().prescription.findUniqueOrThrow({
      where: { id: prescription.id },
    });
    expect(fresh.state).toBe('DISPENSED');
  });

  it('requires a reason', async () => {
    const fixture = await liveConsultation();
    const prescription = await issuedPrescription(fixture);

    await expect(revokePrescription(prescription.id, fixture.doctorId, '  ')).rejects.toThrow(
      /reason is required/i,
    );
  });

  it('refuses a revoked prescription at the dispensing counter', async () => {
    const fixture = await liveConsultation();
    const prescription = await issuedPrescription(fixture);
    await revokePrescription(prescription.id, fixture.doctorId, 'Wrong medication');

    await expect(
      dispensePrescription(prescription.id, fixture.pharmacyId, fixture.pharmacyUserId),
    ).rejects.toThrow(/revoked by the doctor/i);
  });

  it('will not let another doctor revoke', async () => {
    const fixture = await liveConsultation();
    const other = await liveConsultation();
    const prescription = await issuedPrescription(fixture);

    await expect(
      revokePrescription(prescription.id, other.doctorId, 'Not mine to revoke'),
    ).rejects.toThrow(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// Scenarios 7 and 8 — substitution
// ---------------------------------------------------------------------------

describe('substitution', () => {
  it('supersedes the original item when the doctor approves (scenario 7)', async () => {
    const fixture = await liveConsultation();
    const prescription = await issuedPrescription(fixture);
    const item = prescription.items[0]!;

    const proposal = await proposeSubstitution(
      prescription.id,
      item.id,
      fixture.pharmacyId,
      fixture.pharmacyUserId,
      { medication: 'Amoxil', strength: '500mg', reason: 'Out of stock; same molecule.' },
    );

    const pending = await getPrisma().prescription.findUniqueOrThrow({
      where: { id: prescription.id },
    });
    expect(pending.state).toBe('PENDING_SUBSTITUTION');

    await decideSubstitution(proposal.id, fixture.doctorId, { approve: true });

    const items = await getPrisma().prescriptionItem.findMany({
      where: { prescriptionId: prescription.id },
      orderBy: { version: 'asc' },
    });

    // The record shows both: what was prescribed, and what replaced it.
    expect(items).toHaveLength(2);
    expect(items[0]!.isActive).toBe(false);
    expect(items[0]!.supersededByItemId).toBe(items[1]!.id);
    expect(items[1]!.medication).toBe('Amoxil');

    // The regimen carries over unchanged — the swap is of the product.
    expect(items[1]!.dose).toBe(item.dose);
    expect(items[1]!.frequency).toBe(item.frequency);
  });

  it('leaves the original standing when the doctor refuses (scenario 8)', async () => {
    const fixture = await liveConsultation();
    const prescription = await issuedPrescription(fixture);
    const item = prescription.items[0]!;

    const proposal = await proposeSubstitution(
      prescription.id,
      item.id,
      fixture.pharmacyId,
      fixture.pharmacyUserId,
      { medication: 'Something else', reason: 'Cheaper' },
    );

    await decideSubstitution(proposal.id, fixture.doctorId, {
      approve: false,
      note: 'Not therapeutically equivalent for this patient.',
    });

    const items = await getPrisma().prescriptionItem.findMany({
      where: { prescriptionId: prescription.id },
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.medication).toBe('Amoxicillin');
    expect(items[0]!.isActive).toBe(true);

    // And it is still dispensable — a refused substitution does not strand it.
    const after = await getPrisma().prescription.findUniqueOrThrow({
      where: { id: prescription.id },
    });
    expect(after.state).toBe('SUBSTITUTION_REJECTED');

    const dispensed = await dispensePrescription(
      prescription.id,
      fixture.pharmacyId,
      fixture.pharmacyUserId,
    );
    expect(dispensed.state).toBe('DISPENSED');
  });

  it('refuses to dispense while a substitution is undecided', async () => {
    const fixture = await liveConsultation();
    const prescription = await issuedPrescription(fixture);

    await proposeSubstitution(
      prescription.id,
      prescription.items[0]!.id,
      fixture.pharmacyId,
      fixture.pharmacyUserId,
      { medication: 'Amoxil', reason: 'Out of stock' },
    );

    await expect(
      dispensePrescription(prescription.id, fixture.pharmacyId, fixture.pharmacyUserId),
    ).rejects.toThrow(/awaiting the doctor/i);
  });

  it('refuses a second proposal while one is pending', async () => {
    const fixture = await liveConsultation();
    const prescription = await issuedPrescription(fixture);
    const item = prescription.items[0]!;

    await proposeSubstitution(prescription.id, item.id, fixture.pharmacyId, fixture.pharmacyUserId, {
      medication: 'Amoxil',
      reason: 'Out of stock',
    });

    // The doctor would be answering a question that has already moved.
    await expect(
      proposeSubstitution(prescription.id, item.id, fixture.pharmacyId, fixture.pharmacyUserId, {
        medication: 'Something else',
        reason: 'Also out of stock',
      }),
    ).rejects.toThrow(/already awaiting/i);
  });

  it('requires a reason for the proposal', async () => {
    const fixture = await liveConsultation();
    const prescription = await issuedPrescription(fixture);

    await expect(
      proposeSubstitution(
        prescription.id,
        prescription.items[0]!.id,
        fixture.pharmacyId,
        fixture.pharmacyUserId,
        { medication: 'Amoxil', reason: '   ' },
      ),
    ).rejects.toThrow(/reason is required/i);
  });

  it('will not let another pharmacy propose on this prescription', async () => {
    const fixture = await liveConsultation();
    const other = await liveConsultation();
    const prescription = await issuedPrescription(fixture);

    await expect(
      proposeSubstitution(
        prescription.id,
        prescription.items[0]!.id,
        other.pharmacyId,
        other.pharmacyUserId,
        { medication: 'Amoxil', reason: 'Out of stock' },
      ),
    ).rejects.toThrow(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// Dispensing
// ---------------------------------------------------------------------------

/**
 * The doctor's side of the substitution loop.
 *
 * Without this route a proposal is unanswerable in practice: the prescription
 * sits in PENDING_SUBSTITUTION, undispensable, and nothing tells the doctor a
 * decision is owed.
 */
/**
 * The pharmacy's list filter.
 *
 * `activeOnly=false` used to parse as TRUE — `z.coerce.boolean()` applies
 * JavaScript's `Boolean()`, and the string "false" is truthy. The "All"
 * toggle on the prescriptions screen therefore showed the to-dispense list,
 * and a pharmacist could not find a prescription they had already dispensed.
 */
describe('the pharmacy prescription filter', () => {
  it('treats activeOnly=false as false, so a dispensed prescription is still findable', async () => {
    const fixture = await liveConsultation();
    const prescription = await issuedPrescription(fixture);
    await dispensePrescription(prescription.id, fixture.pharmacyId, fixture.pharmacyUserId);

    const pharmacyUser = await getPrisma().user.findUniqueOrThrow({
      where: { id: fixture.pharmacyUserId },
    });
    const cookies = await signIn(pharmacyUser.email, PHARMACY_PASSWORD);

    const all = await request<Array<{ publicId: string; state: string }>>(
      '/pharmacy/prescriptions?activeOnly=false',
      { cookies },
    );
    expect(all.body.data!.map((rx) => rx.publicId)).toContain(prescription.publicId);

    const toDispense = await request<Array<{ publicId: string }>>(
      '/pharmacy/prescriptions?activeOnly=true',
      { cookies },
    );
    expect(toDispense.body.data!.map((rx) => rx.publicId)).not.toContain(prescription.publicId);
  });
});

// ---------------------------------------------------------------------------

describe('the doctor’s substitution inbox', () => {
  it('shows a proposal on this doctor’s prescription, with both products', async () => {
    const fixture = await liveConsultation();
    const prescription = await issuedPrescription(fixture);
    const item = await getPrisma().prescriptionItem.findFirstOrThrow({
      where: { prescriptionId: prescription.id },
    });

    await proposeSubstitution(prescription.id, item.id, fixture.pharmacyId, fixture.pharmacyUserId, {
      medication: 'Amoxil',
      strength: '500mg',
      reason: 'Generic out of stock.',
    });

    const cookies = await signIn(fixture.doctorEmail, DOCTOR_PASSWORD);
    const response = await request<
      Array<{
        id: string;
        reason: string;
        proposed: { medication: string };
        prescribed: { medication: string; quantity: string };
        prescriptionPublicId: string;
        consultationReference: string;
        patient: { fullName: string };
      }>
    >('/doctor/substitutions', { cookies });

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);

    const proposal = response.body.data![0]!;
    expect(proposal.proposed.medication).toBe('Amoxil');
    // The original has to travel with it — a doctor cannot judge a substitution
    // without seeing what it replaces.
    expect(proposal.prescribed.medication).toBe('Amoxicillin');
    expect(proposal.prescribed.quantity).toBe('15 capsules');
    expect(proposal.reason).toBe('Generic out of stock.');
    expect(proposal.prescriptionPublicId).toBe(prescription.publicId);
    expect(proposal.consultationReference).toBe(fixture.consultationPublicId);
    expect(proposal.patient.fullName).toBe('Adwoa Mensah');
  });

  it('shows another doctor nothing', async () => {
    const fixture = await liveConsultation();
    const prescription = await issuedPrescription(fixture);
    const item = await getPrisma().prescriptionItem.findFirstOrThrow({
      where: { prescriptionId: prescription.id },
    });
    await proposeSubstitution(prescription.id, item.id, fixture.pharmacyId, fixture.pharmacyUserId, {
      medication: 'Amoxil',
      reason: 'Generic out of stock.',
    });

    const other = await liveConsultation();
    const cookies = await signIn(other.doctorEmail, DOCTOR_PASSWORD);
    const response = await request<unknown[]>('/doctor/substitutions', { cookies });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([]);
  });

  it('drops out of the inbox once decided', async () => {
    const fixture = await liveConsultation();
    const prescription = await issuedPrescription(fixture);
    const item = await getPrisma().prescriptionItem.findFirstOrThrow({
      where: { prescriptionId: prescription.id },
    });
    const proposal = await proposeSubstitution(
      prescription.id,
      item.id,
      fixture.pharmacyId,
      fixture.pharmacyUserId,
      { medication: 'Amoxil', reason: 'Generic out of stock.' },
    );

    const cookies = await signIn(fixture.doctorEmail, DOCTOR_PASSWORD);
    expect((await request<unknown[]>('/doctor/substitutions', { cookies })).body.data).toHaveLength(
      1,
    );

    await decideSubstitution(proposal.id, fixture.doctorId, { approve: true });

    expect((await request<unknown[]>('/doctor/substitutions', { cookies })).body.data).toEqual([]);
  });

  it('is closed to a pharmacy', async () => {
    const fixture = await liveConsultation();
    const pharmacyUser = await getPrisma().user.findUniqueOrThrow({
      where: { id: fixture.pharmacyUserId },
    });

    const cookies = await signIn(pharmacyUser.email, PHARMACY_PASSWORD);
    const response = await request('/doctor/substitutions', { cookies });

    expect(response.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------

describe('dispensing', () => {
  it('is terminal and cannot be repeated', async () => {
    const fixture = await liveConsultation();
    const prescription = await issuedPrescription(fixture);

    await dispensePrescription(prescription.id, fixture.pharmacyId, fixture.pharmacyUserId);

    await expect(
      dispensePrescription(prescription.id, fixture.pharmacyId, fixture.pharmacyUserId),
    ).rejects.toThrow(/already been dispensed/i);
  });

  it('will not let another pharmacy dispense (scenario 13, D13)', async () => {
    const fixture = await liveConsultation();
    const other = await liveConsultation();
    const prescription = await issuedPrescription(fixture);

    await expect(
      dispensePrescription(prescription.id, other.pharmacyId, other.pharmacyUserId),
    ).rejects.toThrow(/not found/i);
  });

  it('records who dispensed it and when', async () => {
    const fixture = await liveConsultation();
    const prescription = await issuedPrescription(fixture);

    const dispensed = await dispensePrescription(
      prescription.id,
      fixture.pharmacyId,
      fixture.pharmacyUserId,
    );

    expect(dispensed.dispensedByUserId).toBe(fixture.pharmacyUserId);
    expect(dispensed.dispensedAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

describe('completing a consultation', () => {
  it('refuses to complete over an unsigned draft', async () => {
    const fixture = await liveConsultation();
    await createDraft(fixture.consultationId, fixture.doctorId, [ITEM]);

    await expect(
      completeConsultation(fixture.consultationId, fixture.doctorId, { outcome: 'PRESCRIPTION' }),
    ).rejects.toThrow(/still a draft/i);
  });

  it('refuses an outcome that claims a document which does not exist', async () => {
    const fixture = await liveConsultation();

    await expect(
      completeConsultation(fixture.consultationId, fixture.doctorId, { outcome: 'PRESCRIPTION' }),
    ).rejects.toThrow(/none exists/i);
  });

  it('refuses advice-only without a consultation summary (D25)', async () => {
    const fixture = await liveConsultation();

    await expect(
      completeConsultation(fixture.consultationId, fixture.doctorId, { outcome: 'ADVICE_ONLY' }),
    ).rejects.toThrow(/summary before completing/i);
  });

  it('completes with a prescription, seals the record and schedules destruction', async () => {
    const fixture = await liveConsultation();
    await issuedPrescription(fixture);

    const result = await completeConsultation(fixture.consultationId, fixture.doctorId, {
      outcome: 'PRESCRIPTION',
      notes: { notes: 'Chest clear.', diagnosis: 'Upper respiratory infection' },
    });

    expect(result.state).toBe('COMPLETED');
    expect(result.hasPrescription).toBe(true);
    expect(result.destroyAt).not.toBeNull();

    const consultation = await getPrisma().consultation.findUniqueOrThrow({
      where: { id: fixture.consultationId },
    });
    expect(consultation.state).toBe('COMPLETED');
    expect(consultation.outcome).toBe('PRESCRIPTION');
    // Sealed by the terminal transition (D23).
    expect(consultation.clinicalSealedAt).not.toBeNull();
  });

  it('leaves the prescription readable after the record is sealed (scenario 11, 12)', async () => {
    const fixture = await liveConsultation();
    const prescription = await issuedPrescription(fixture);

    await completeConsultation(fixture.consultationId, fixture.doctorId, {
      outcome: 'PRESCRIPTION',
      notes: { notes: 'Chest clear.' },
    });

    // The clinical record is sealed, but the prescription is a permanent
    // document and stays legible to its authorised parties (spec §11, D13).
    const fresh = await getPrisma().prescription.findUniqueOrThrow({
      where: { id: prescription.id },
      include: { items: true },
    });
    expect(fresh.patientName).toBe('Adwoa Mensah');
    expect(fresh.items[0]!.medication).toBe('Amoxicillin');

    // And it can still be dispensed after the consultation ended.
    const dispensed = await dispensePrescription(
      prescription.id,
      fixture.pharmacyId,
      fixture.pharmacyUserId,
    );
    expect(dispensed.state).toBe('DISPENSED');
  });

  it('will not let another doctor complete', async () => {
    const fixture = await liveConsultation();
    const other = await liveConsultation();

    await expect(
      completeConsultation(fixture.consultationId, other.doctorId, { outcome: 'OTHER' }),
    ).rejects.toThrow(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// Documents: PDFs, referrals, summaries and verification
// ---------------------------------------------------------------------------

describe('the prescription PDF', () => {
  it('is generated at issue and is a real PDF', async () => {
    const fixture = await liveConsultation();
    const prescription = await issuedPrescription(fixture);
    await generatePrescriptionPdf(prescription.id);

    const stored = await getPrisma().prescription.findUniqueOrThrow({
      where: { id: prescription.id },
    });
    expect(stored.pdfStorageKey).toBeTruthy();

    const pdf = await readDocumentPdf(stored.pdfStorageKey!);
    // The magic bytes, so this asserts a document rather than an empty buffer.
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(2_000);
  });

  it('is stored once rather than rendered per download', async () => {
    const fixture = await liveConsultation();
    const prescription = await issuedPrescription(fixture);
    await generatePrescriptionPdf(prescription.id);

    const first = await getPrisma().prescription.findUniqueOrThrow({
      where: { id: prescription.id },
    });
    const a = await readDocumentPdf(first.pdfStorageKey!);
    const b = await readDocumentPdf(first.pdfStorageKey!);

    // Byte-identical: a template change must not silently alter a document
    // already in a patient's hands.
    expect(a.equals(b)).toBe(true);
  });
});

describe('referrals', () => {
  it('issues with a PDF and records the destination, not the reason', async () => {
    const fixture = await liveConsultation();

    const referral = await issueReferral(fixture.consultationId, fixture.doctorId, {
      hospitalName: 'Korle Bu Teaching Hospital',
      department: 'Emergency',
      reasonText: 'Persistent chest pain with exertion; needs ECG and troponin.',
      urgency: 'Urgent',
    });

    const stored = await getPrisma().referral.findUniqueOrThrow({ where: { id: referral.id } });
    expect(stored.pdfStorageKey).toBeTruthy();
    expect((await readDocumentPdf(stored.pdfStorageKey!)).subarray(0, 5).toString()).toBe('%PDF-');

    // The audit log carries the destination and urgency; the clinical reason
    // is not audit-log material (spec §61).
    const entry = await getPrisma().auditLog.findFirstOrThrow({
      where: { action: 'referral.generated', entityId: referral.id },
    });
    const serialised = JSON.stringify(entry);
    expect(serialised).toContain('Korle Bu');
    expect(serialised).not.toMatch(/troponin|chest pain/i);
  });

  it('refuses a referral with no reason — the receiving clinician relies on it', async () => {
    const fixture = await liveConsultation();

    await expect(
      issueReferral(fixture.consultationId, fixture.doctorId, {
        hospitalName: 'Korle Bu',
        department: 'Emergency',
        reasonText: '   ',
      }),
    ).rejects.toThrow(/needs a reason/i);
  });
});

describe('the consultation summary (decision D25)', () => {
  const VALID = {
    presentingComplaint: 'Sore throat for two days, wants antibiotics.',
    assessment: 'Viral pharyngitis. No red flags; antibiotics would not help.',
    advice: 'Rest, fluids, paracetamol for pain.',
    safetyNetting:
      'Return or go to hospital if you cannot swallow fluids, develop difficulty breathing, ' +
      'or the fever lasts beyond four days.',
  };

  it('issues with a PDF and unblocks an advice-only completion', async () => {
    const fixture = await liveConsultation();

    const summary = await issueSummary(fixture.consultationId, fixture.doctorId, VALID);
    expect(summary.safetyNetting).toMatch(/difficulty breathing/);

    const stored = await getPrisma().consultationSummary.findUniqueOrThrow({
      where: { id: summary.id },
    });
    expect((await readDocumentPdf(stored.pdfStorageKey!)).subarray(0, 5).toString()).toBe('%PDF-');

    const result = await completeConsultation(fixture.consultationId, fixture.doctorId, {
      outcome: 'ADVICE_ONLY',
    });
    expect(result.hasSummary).toBe(true);
  });

  it('refuses without safety-netting', async () => {
    const fixture = await liveConsultation();

    // Neem's own rule, not a legal one (G7g) — but it stands on clinical
    // grounds: "no medication needed" alone reads as an all-clear.
    await expect(
      issueSummary(fixture.consultationId, fixture.doctorId, { ...VALID, safetyNetting: '  ' }),
    ).rejects.toThrow();
  });

  it('allows only one summary per consultation', async () => {
    const fixture = await liveConsultation();
    await issueSummary(fixture.consultationId, fixture.doctorId, VALID);

    await expect(
      issueSummary(fixture.consultationId, fixture.doctorId, VALID),
    ).rejects.toThrow(/already has a summary/i);
  });

  it('keeps no clinical content in the audit log', async () => {
    const fixture = await liveConsultation();
    const summary = await issueSummary(fixture.consultationId, fixture.doctorId, VALID);

    const entry = await getPrisma().auditLog.findFirstOrThrow({
      where: { action: 'summary.issued', entityId: summary.id },
    });
    expect(JSON.stringify(entry)).not.toMatch(/pharyngitis|antibiotics|swallow/i);
  });

  it('survives the sealing of the clinical record', async () => {
    const fixture = await liveConsultation();
    const summary = await issueSummary(fixture.consultationId, fixture.doctorId, VALID);
    await completeConsultation(fixture.consultationId, fixture.doctorId, {
      outcome: 'ADVICE_ONLY',
    });

    // A doctor-issued, patient-carried document is permanent, unlike the
    // working notes it sat beside (docs/data-retention.md §2).
    const after = await getPrisma().consultationSummary.findUniqueOrThrow({
      where: { id: summary.id },
    });
    expect(after.advice).toBe(VALID.advice);
  });
});

describe('the public verification page (spec §44)', () => {
  it('confirms a prescription is genuine without disclosing what it says', async () => {
    const fixture = await liveConsultation();
    const prescription = await issuedPrescription(fixture);

    const response = await request<Record<string, unknown>>(
      `/verify/rx/${prescription.verificationCode}`,
    );

    expect(response.status).toBe(200);
    expect(response.body.data!.genuine).toBe(true);

    // Whoever needs the content is holding the document. This page proves it
    // is real; it is not a way to read someone else's prescription.
    const serialised = JSON.stringify(response.body);
    expect(serialised).not.toMatch(/Amoxicillin|500mg|Three times daily/i);
    expect(serialised).not.toContain('Adwoa Mensah');
  });

  it('needs no account', async () => {
    const fixture = await liveConsultation();
    const prescription = await issuedPrescription(fixture);

    // A pharmacist or hospital clerk holding a printout must be able to check
    // it. No cookies are sent here.
    const response = await request(`/verify/rx/${prescription.verificationCode}`);
    expect(response.status).toBe(200);
  });

  it('shows a revoked prescription as revoked', async () => {
    const fixture = await liveConsultation();
    const prescription = await issuedPrescription(fixture);
    await revokePrescription(prescription.id, fixture.doctorId, 'Allergy reported');

    const response = await request<{ revoked: boolean; state: string }>(
      `/verify/rx/${prescription.verificationCode}`,
    );

    // The pharmacy must be able to see this before dispensing.
    expect(response.body.data!.revoked).toBe(true);
    expect(response.body.data!.state).toBe('REVOKED');
  });

  it('shows a dispensed prescription as dispensed', async () => {
    const fixture = await liveConsultation();
    const prescription = await issuedPrescription(fixture);
    await dispensePrescription(prescription.id, fixture.pharmacyId, fixture.pharmacyUserId);

    const response = await request<{ dispensed: boolean }>(
      `/verify/rx/${prescription.verificationCode}`,
    );
    expect(response.body.data!.dispensed).toBe(true);
  });

  it('does not verify a draft — a draft is not a document', async () => {
    const fixture = await liveConsultation();
    const draft = await createDraft(fixture.consultationId, fixture.doctorId, [ITEM]);

    const response = await request(`/verify/rx/${draft.verificationCode}`);
    expect(response.status).toBe(404);
  });

  it('refuses an unknown code without saying why', async () => {
    const response = await request('/verify/rx/aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(response.status).toBe(404);
  });

  it('verifies a referral and a summary too', async () => {
    const fixture = await liveConsultation();

    const referral = await issueReferral(fixture.consultationId, fixture.doctorId, {
      hospitalName: 'Korle Bu',
      department: 'Emergency',
      reasonText: 'Needs assessment.',
    });
    const referralCheck = await request<{ genuine: boolean }>(
      `/verify/referral/${referral.publicId}`,
    );
    expect(referralCheck.body.data!.genuine).toBe(true);
    // The reason is clinical text and stays on the document.
    expect(JSON.stringify(referralCheck.body)).not.toMatch(/Needs assessment/i);

    const summary = await issueSummary(fixture.consultationId, fixture.doctorId, {
      presentingComplaint: 'Sore throat',
      assessment: 'Viral',
      advice: 'Rest and fluids',
      safetyNetting: 'Return if you cannot swallow.',
    });
    const summaryCheck = await request<{ genuine: boolean }>(
      `/verify/summary/${summary.verificationCode}`,
    );
    expect(summaryCheck.body.data!.genuine).toBe(true);
    expect(JSON.stringify(summaryCheck.body)).not.toMatch(/Rest and fluids|swallow/i);
  });
});

describe('who may download a prescription PDF (decision D13)', () => {
  async function issuedWithPdf(fixture: Awaited<ReturnType<typeof liveConsultation>>) {
    const prescription = await issuedPrescription(fixture);
    await generatePrescriptionPdf(prescription.id);
    return prescription;
  }

  it('gives it to the dispensing pharmacy', async () => {
    const fixture = await liveConsultation();
    const prescription = await issuedWithPdf(fixture);

    const user = await getPrisma().user.findUniqueOrThrow({
      where: { id: fixture.pharmacyUserId },
    });
    const cookies = await signIn(user.email, PHARMACY_PASSWORD);

    const response = await request(`/documents/prescriptions/${prescription.publicId}.pdf`, {
      cookies,
    });

    expect(response.status).toBe(200);
    expect(response.raw.headers['content-type']).toBe('application/pdf');
    expect(response.raw.headers['cache-control']).toBe('private, no-store');
  });

  it('refuses another pharmacy (scenario 13)', async () => {
    const fixture = await liveConsultation();
    const other = await liveConsultation();
    const prescription = await issuedWithPdf(fixture);

    const otherUser = await getPrisma().user.findUniqueOrThrow({
      where: { id: other.pharmacyUserId },
    });
    const cookies = await signIn(otherUser.email, PHARMACY_PASSWORD);

    const response = await request(`/documents/prescriptions/${prescription.publicId}.pdf`, {
      cookies,
    });

    // 404, not 403 — the existence of another pharmacy's prescription is not
    // disclosed (spec §102, D13).
    expect(response.status).toBe(404);
  });

  it('refuses an unauthenticated caller', async () => {
    const fixture = await liveConsultation();
    const prescription = await issuedWithPdf(fixture);

    const response = await request(`/documents/prescriptions/${prescription.publicId}.pdf`);
    expect(response.status).toBe(401);
  });

  it('audits every download', async () => {
    const fixture = await liveConsultation();
    const prescription = await issuedWithPdf(fixture);

    const user = await getPrisma().user.findUniqueOrThrow({
      where: { id: fixture.pharmacyUserId },
    });
    const cookies = await signIn(user.email, PHARMACY_PASSWORD);
    await request(`/documents/prescriptions/${prescription.publicId}.pdf`, { cookies });

    const entry = await getPrisma().auditLog.findFirst({
      where: { action: 'document.downloaded', entityId: prescription.id },
    });
    expect(entry).not.toBeNull();
  });
});
