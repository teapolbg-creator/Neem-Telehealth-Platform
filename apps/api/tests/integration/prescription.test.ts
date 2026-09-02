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
import { encryptField, generatePublicId } from '../../src/lib/crypto.ts';

/**
 * Prescriptions end to end (spec §41–§48, §82).
 *
 * Covers required §80 scenarios 6 (a prescription reaches the pharmacy),
 * 9 (revoked before dispensing) and 10 (a dispensed prescription cannot be
 * revoked), plus the substitution workflow of scenarios 7 and 8.
 */

const PHARMACY_PASSWORD = 'PharmacyPassword123!';

interface Fixture {
  consultationId: string;
  consultationPublicId: string;
  doctorId: string;
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
    password: 'DoctorPassword123!',
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
