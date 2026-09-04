import type { PrescriptionState, PrismaClient } from '@prisma/client';
import { getPrisma, type Db } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { generatePublicId, generateVerificationCode } from '../../lib/crypto.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit.service.ts';
import { emitToPharmacy, emitToDoctor } from '../realtime/realtime.service.ts';
import { notify } from '../notification/notification.service.ts';
import {
  assertPrescriptionTransition,
  canDispense,
  canProposeSubstitution,
  canRevoke,
} from '../../domain/prescription-state.ts';

/**
 * Prescriptions (spec §41–§48, §82).
 *
 * The rules that matter, and where each is enforced:
 *
 *  - **A pharmacy never alters what a doctor prescribed.** There is no route
 *    or function here by which a pharmacy edits an item. It may propose a
 *    substitution, which the issuing doctor decides (§47).
 *  - **A dispensed prescription cannot be revoked** (§82). Enforced by the
 *    state machine, and asserted again here before the write.
 *  - **A prescription is bound to the signature that signed it.** The
 *    signature id is captured at issue, so a later signature change cannot
 *    retroactively alter who signed a document already in a patient's hands.
 *  - **Only ACTIVE doctors issue.** A suspended or expired doctor cannot sign.
 */

export interface PrescriptionItemInput {
  medication: string;
  strength?: string;
  form?: string;
  dose: string;
  frequency: string;
  durationText: string;
  quantity: string;
  instructions?: string;
}

/**
 * Creates a draft prescription on a live consultation.
 *
 * A draft is invisible to the pharmacy and carries no signature. It becomes a
 * document only when the doctor issues it.
 */
export async function createDraft(
  consultationId: string,
  doctorId: string,
  items: PrescriptionItemInput[],
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
) {
  if (items.length === 0) {
    throw errors.businessRule('A prescription needs at least one medication.');
  }

  const consultation = await db.consultation.findUnique({
    where: { id: consultationId },
    include: { patientSession: true },
  });
  if (!consultation) throw errors.notFound('Consultation not found.');
  if (consultation.doctorId !== doctorId) throw errors.notFound('Consultation not found.');

  if (consultation.state !== 'IN_PROGRESS') {
    throw errors.businessRule(
      `A prescription can only be written during a consultation. This one is ${consultation.state}.`,
    );
  }

  const patient = consultation.patientSession;
  if (!patient?.fullNameEnc || patient.age === null || !patient.sex) {
    throw errors.businessRule(
      'This patient has no recorded name, age or sex. A prescription cannot be issued without them.',
    );
  }

  const { decryptNullable } = await import('../../lib/crypto.ts');

  const prescription = await db.prescription.create({
    data: {
      publicId: generatePublicId('rx'),
      verificationCode: generateVerificationCode(),
      consultationId,
      doctorId,
      pharmacyId: consultation.pharmacyId,
      state: 'DRAFT',
      /**
       * Copied BY VALUE, the sole permitted clinical carry-forward (spec §11).
       * The prescription must stay readable after the consultation's record is
       * sealed, and must not become a pointer into it.
       */
      patientName: decryptNullable(patient.fullNameEnc) ?? '',
      patientAge: patient.age,
      patientSex: patient.sex,
      isDemo: consultation.isDemo,
      createdAt: clock.now(),
      items: {
        create: items.map((item, index) => ({
          version: 1,
          medication: item.medication,
          strength: item.strength ?? null,
          form: item.form ?? null,
          dose: item.dose,
          frequency: item.frequency,
          durationText: item.durationText,
          quantity: item.quantity,
          instructions: item.instructions ?? null,
          sortOrder: index,
        })),
      },
    },
    include: { items: true },
  });

  return prescription;
}

/**
 * Issues a draft: signs it, and hands it to the pharmacy.
 *
 * This is the moment the prescription becomes a document. It binds the
 * doctor's active signature by id, so revoking or replacing that signature
 * later cannot change who signed something already issued.
 */
export async function issuePrescription(
  prescriptionId: string,
  doctorId: string,
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
) {
  const prescription = await db.prescription.findUnique({
    where: { id: prescriptionId },
    include: { items: { where: { isActive: true } } },
  });
  if (!prescription) throw errors.notFound('Prescription not found.');
  if (prescription.doctorId !== doctorId) throw errors.notFound('Prescription not found.');

  assertPrescriptionTransition(prescription.state, 'ISSUED');

  if (prescription.items.length === 0) {
    throw errors.businessRule('A prescription needs at least one medication.');
  }

  const doctor = await db.doctor.findUniqueOrThrow({
    where: { id: doctorId },
    include: { signatures: { where: { isActive: true }, take: 1 } },
  });

  /**
   * A suspended or expired doctor cannot sign.
   *
   * Checked at issue rather than only at login: a doctor may be suspended
   * mid-consultation, and the prescription is the artefact that outlives the
   * session (spec §22, §55).
   */
  if (doctor.status !== 'ACTIVE') {
    throw errors.businessRule(
      `Your account is ${doctor.status}. Only an active doctor can issue a prescription.`,
    );
  }
  if (doctor.mdcExpiresAt && doctor.mdcExpiresAt <= clock.now()) {
    throw errors.businessRule(
      'Your MDC licence has expired. A valid licence is required to issue a prescription.',
    );
  }

  const signature = doctor.signatures[0];
  if (!signature) {
    throw errors.businessRule(
      'You have not captured a digital signature. A prescription cannot be issued unsigned.',
    );
  }

  const issued = await db.$transaction(async (tx) => {
    const updated = await tx.prescription.update({
      where: { id: prescriptionId },
      data: {
        state: 'ISSUED',
        issuedAt: clock.now(),
        // Bound by id, so a later signature change cannot rewrite history.
        signatureId: signature.id,
      },
    });

    await tx.prescriptionVersion.create({
      data: {
        prescriptionId,
        version: updated.currentVersion,
        state: 'ISSUED',
        changedByType: 'DOCTOR',
        changedById: doctorId,
        reason: 'issued',
        snapshot: {
          items: prescription.items.map((item) => ({
            medication: item.medication,
            strength: item.strength,
            form: item.form,
            dose: item.dose,
            frequency: item.frequency,
            durationText: item.durationText,
            quantity: item.quantity,
            instructions: item.instructions,
          })),
        },
      },
    });

    // Straight on to ACTIVE: the pharmacy has it and may dispense. ISSUED is
    // the instant of signing, not a queue the document waits in.
    return tx.prescription.update({
      where: { id: prescriptionId },
      data: { state: 'ACTIVE' },
      include: {
        items: { where: { isActive: true }, orderBy: { sortOrder: 'asc' } },
        // The reference the pharmacy is notified with. Nothing clinical.
        consultation: { select: { publicId: true } },
      },
    });
  });

  await recordAudit(
    {
      action: AUDIT_ACTIONS.PRESCRIPTION_ISSUED,
      actorType: 'DOCTOR',
      actorId: doctorId,
      entityType: 'prescription',
      entityId: prescriptionId,
      // Counts only. What was prescribed is not audit-log material (spec §61).
      metadata: {
        itemCount: prescription.items.length,
        consultationId: prescription.consultationId,
      },
    },
    db,
  );

  emitToPharmacy(prescription.pharmacyId, 'prescription.issued', {
    prescriptionPublicId: prescription.publicId,
  });

  void notify({
    templateCode: 'pharmacy.prescription.issued',
    recipient: { type: 'PHARMACY', pharmacyId: prescription.pharmacyId },
    // The consultation reference only. What was prescribed stays behind the
    // authenticated screen (spec §60).
    variables: { consultationReference: issued.consultation.publicId },
  });

  return issued;
}

/**
 * Revokes a prescription (spec §46, §82).
 *
 * Refused once dispensed. The medicine is with the patient, and a record
 * claiming withdrawal when the prescription was in fact filled would be worse
 * than no record at all.
 */
export async function revokePrescription(
  prescriptionId: string,
  doctorId: string,
  reason: string,
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
) {
  const prescription = await db.prescription.findUnique({ where: { id: prescriptionId } });
  if (!prescription) throw errors.notFound('Prescription not found.');
  if (prescription.doctorId !== doctorId) throw errors.notFound('Prescription not found.');

  if (!reason?.trim()) {
    throw errors.businessRule('A reason is required to revoke a prescription.');
  }

  if (prescription.state === 'DISPENSED') {
    throw errors.businessRule(
      'This prescription has already been dispensed and cannot be revoked. The medicine is with ' +
        'the patient; contact the pharmacy directly.',
    );
  }
  if (!canRevoke(prescription.state)) {
    throw errors.businessRule(`A ${prescription.state} prescription cannot be revoked.`);
  }

  assertPrescriptionTransition(prescription.state, 'REVOKED');

  const revoked = await db.prescription.update({
    where: { id: prescriptionId },
    data: {
      state: 'REVOKED',
      revokedAt: clock.now(),
      revokedReason: reason.trim().slice(0, 500),
      revokedByDoctorId: doctorId,
    },
  });

  await recordAudit(
    {
      action: AUDIT_ACTIONS.PRESCRIPTION_REVOKED,
      actorType: 'DOCTOR',
      actorId: doctorId,
      entityType: 'prescription',
      entityId: prescriptionId,
      metadata: { previousState: prescription.state },
    },
    db,
  );

  emitToPharmacy(prescription.pharmacyId, 'prescription.revoked', {
    prescriptionPublicId: prescription.publicId,
  });

  return revoked;
}

/**
 * Marks a prescription dispensed (spec §48).
 *
 * Terminal and immutable. After this the prescription cannot be revoked,
 * substituted, or altered by anyone.
 */
export async function dispensePrescription(
  prescriptionId: string,
  pharmacyId: string,
  dispensedByUserId: string,
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
) {
  const prescription = await db.prescription.findUnique({
    where: { id: prescriptionId },
    include: { substitutions: { where: { state: 'PENDING' }, select: { id: true } } },
  });
  if (!prescription) throw errors.notFound('Prescription not found.');

  // A pharmacy must not learn that another pharmacy's prescription exists
  // (spec §102, decision D13).
  if (prescription.pharmacyId !== pharmacyId) throw errors.notFound('Prescription not found.');

  if (prescription.state === 'REVOKED') {
    throw errors.businessRule(
      'This prescription was revoked by the doctor and must not be dispensed.',
    );
  }
  if (prescription.state === 'DISPENSED') {
    throw errors.conflict('This prescription has already been dispensed.');
  }
  if (prescription.substitutions.length > 0) {
    throw errors.businessRule(
      'A substitution is awaiting the doctor’s decision. Dispense once they have answered.',
    );
  }
  if (!canDispense(prescription.state)) {
    throw errors.businessRule(`A ${prescription.state} prescription cannot be dispensed.`);
  }

  assertPrescriptionTransition(prescription.state, 'DISPENSED');

  const dispensed = await db.prescription.update({
    where: { id: prescriptionId },
    data: { state: 'DISPENSED', dispensedAt: clock.now(), dispensedByUserId },
  });

  await recordAudit(
    {
      action: AUDIT_ACTIONS.PRESCRIPTION_DISPENSED,
      actorType: 'PHARMACY',
      actorId: dispensedByUserId,
      entityType: 'prescription',
      entityId: prescriptionId,
    },
    db,
  );

  emitToDoctor(prescription.doctorId, 'prescription.dispensed', {
    prescriptionPublicId: prescription.publicId,
  });

  return dispensed;
}

// ---------------------------------------------------------------------------
// Substitution (spec §47)
// ---------------------------------------------------------------------------

/**
 * The pharmacy proposes swapping one item for another.
 *
 * A proposal, never a change. Nothing here writes to `prescription_items`;
 * only the doctor's approval does, and the original item is superseded rather
 * than overwritten so the record shows both.
 */
export async function proposeSubstitution(
  prescriptionId: string,
  itemId: string,
  pharmacyId: string,
  requestedByUserId: string,
  proposal: { medication: string; strength?: string; form?: string; reason: string },
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
) {
  const prescription = await db.prescription.findUnique({
    where: { id: prescriptionId },
    include: {
      items: { where: { id: itemId } },
      substitutions: { where: { state: 'PENDING' }, select: { id: true } },
      // Named in the notification to the doctor, so they know where the
      // pharmacist waiting on them is.
      pharmacy: { select: { name: true } },
    },
  });
  if (!prescription) throw errors.notFound('Prescription not found.');
  if (prescription.pharmacyId !== pharmacyId) throw errors.notFound('Prescription not found.');

  if (prescription.items.length === 0) {
    throw errors.notFound('That item is not on this prescription.');
  }
  if (!proposal.reason?.trim()) {
    throw errors.businessRule('A reason is required when proposing a substitution.');
  }
  if (prescription.substitutions.length > 0) {
    throw errors.conflict(
      'A substitution on this prescription is already awaiting the doctor’s decision.',
    );
  }
  if (!canProposeSubstitution(prescription.state)) {
    throw errors.businessRule(`A ${prescription.state} prescription cannot be substituted.`);
  }

  const request = await db.$transaction(async (tx) => {
    const created = await tx.substitutionRequest.create({
      data: {
        prescriptionId,
        prescriptionItemId: itemId,
        pharmacyId,
        requestedByUserId,
        proposedMedication: proposal.medication,
        proposedStrength: proposal.strength ?? null,
        proposedForm: proposal.form ?? null,
        reason: proposal.reason.trim().slice(0, 500),
        state: 'PENDING',
        createdAt: clock.now(),
      },
    });

    await tx.prescription.update({
      where: { id: prescriptionId },
      data: { state: 'PENDING_SUBSTITUTION' },
    });

    return created;
  });

  await recordAudit(
    {
      action: AUDIT_ACTIONS.SUBSTITUTION_REQUESTED,
      actorType: 'PHARMACY',
      actorId: requestedByUserId,
      entityType: 'prescription',
      entityId: prescriptionId,
      metadata: { substitutionId: request.id },
    },
    db,
  );

  emitToDoctor(prescription.doctorId, 'substitution.requested', {
    prescriptionPublicId: prescription.publicId,
    substitutionId: request.id,
  });

  /**
   * A pharmacist is at a counter with an undispensable prescription, so this
   * reaches the doctor off-screen too.
   */
  void notify({
    templateCode: 'doctor.substitution.requested',
    recipient: { type: 'DOCTOR', doctorId: prescription.doctorId },
    variables: { pharmacyName: prescription.pharmacy.name },
  });

  return request;
}

/**
 * The doctor decides on a proposed substitution.
 *
 * Approval supersedes the original item rather than editing it: the old row
 * stays, marked inactive and pointing at its replacement, so the record shows
 * what was prescribed *and* what was dispensed instead.
 */
export async function decideSubstitution(
  substitutionId: string,
  doctorId: string,
  decision: { approve: boolean; note?: string },
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
) {
  const request = await db.substitutionRequest.findUnique({
    where: { id: substitutionId },
    include: { prescription: true, prescriptionItem: true },
  });
  if (!request) throw errors.notFound('Substitution request not found.');
  if (request.prescription.doctorId !== doctorId) {
    throw errors.notFound('Substitution request not found.');
  }
  if (request.state !== 'PENDING') {
    throw errors.conflict(`This substitution has already been ${request.state.toLowerCase()}.`);
  }

  const nextState: PrescriptionState = decision.approve
    ? 'SUBSTITUTION_APPROVED'
    : 'SUBSTITUTION_REJECTED';
  assertPrescriptionTransition(request.prescription.state, nextState);

  await db.$transaction(async (tx) => {
    await tx.substitutionRequest.update({
      where: { id: substitutionId },
      data: {
        state: decision.approve ? 'APPROVED' : 'REJECTED',
        decidedByDoctorId: doctorId,
        decidedAt: clock.now(),
        decisionNote: decision.note?.trim().slice(0, 500) ?? null,
      },
    });

    if (decision.approve) {
      const original = request.prescriptionItem;

      const replacement = await tx.prescriptionItem.create({
        data: {
          prescriptionId: request.prescriptionId,
          version: request.prescription.currentVersion + 1,
          medication: request.proposedMedication,
          strength: request.proposedStrength,
          form: request.proposedForm,
          // Everything the doctor specified about how to take it carries over
          // unchanged — the substitution is of the product, not the regimen.
          dose: original.dose,
          frequency: original.frequency,
          durationText: original.durationText,
          quantity: original.quantity,
          instructions: original.instructions,
          sortOrder: original.sortOrder,
          isActive: true,
        },
      });

      // Superseded, not deleted. The record must show both.
      await tx.prescriptionItem.update({
        where: { id: original.id },
        data: { isActive: false, supersededByItemId: replacement.id },
      });

      await tx.prescription.update({
        where: { id: request.prescriptionId },
        data: { currentVersion: { increment: 1 } },
      });

      await tx.prescriptionVersion.create({
        data: {
          prescriptionId: request.prescriptionId,
          version: request.prescription.currentVersion + 1,
          state: 'SUBSTITUTION_APPROVED',
          changedByType: 'DOCTOR',
          changedById: doctorId,
          reason: 'substitution_approved',
          snapshot: {
            replaced: original.medication,
            with: request.proposedMedication,
          },
        },
      });
    }

    await tx.prescription.update({
      where: { id: request.prescriptionId },
      data: { state: nextState },
    });
  });

  await recordAudit(
    {
      action: AUDIT_ACTIONS.SUBSTITUTION_DECIDED,
      actorType: 'DOCTOR',
      actorId: doctorId,
      entityType: 'prescription',
      entityId: request.prescriptionId,
      outcome: decision.approve ? 'SUCCESS' : 'DENIED',
      metadata: { substitutionId, approved: decision.approve },
    },
    db,
  );

  emitToPharmacy(request.pharmacyId, 'substitution.decided', {
    prescriptionPublicId: request.prescription.publicId,
    approved: decision.approve,
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * A prescription for one of the four permitted readers (decision D13).
 *
 * The caller establishes which party it is; this shapes what they see. There
 * is deliberately no variant that returns another pharmacy's prescription.
 */
export async function readPrescription(prescriptionId: string, db: Db = getPrisma()) {
  const prescription = await db.prescription.findUnique({
    where: { id: prescriptionId },
    include: {
      items: { orderBy: [{ isActive: 'desc' }, { sortOrder: 'asc' }] },
      doctor: { select: { fullName: true, mdcNumber: true, publicId: true } },
      pharmacy: { select: { name: true, city: true } },
      consultation: { select: { publicId: true, createdAt: true } },
      substitutions: { orderBy: { createdAt: 'desc' } },
    },
  });
  if (!prescription) throw errors.notFound('Prescription not found.');

  return prescription;
}
