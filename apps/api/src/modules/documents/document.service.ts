import type { PrismaClient } from '@prisma/client';
import { getPrisma, type Db } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { generatePublicId, generateVerificationCode } from '../../lib/crypto.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit.service.ts';
import { getStorageProvider } from '../../adapters/storage/local-storage.provider.ts';
import { buildStorageKey } from '../../adapters/storage/storage.provider.ts';
import { emitToPharmacy } from '../realtime/realtime.service.ts';
import { renderPrescriptionPdf, renderReferralPdf, renderSummaryPdf } from './pdf.service.ts';

/**
 * Issuing the documents a patient carries away (spec §43, §49, decision D25).
 *
 * Prescriptions, referrals and consultation summaries are **permanent** and
 * survive the sealing of the clinical record, because each is a document a
 * doctor deliberately issued rather than a working note (docs/data-retention.md
 * §2). Every one carries the consultation reference, which under D24 is how the
 * patient identifies their own record afterwards.
 *
 * The PDF is generated once, at issue, and stored. Regenerating on each
 * download would let a later change to the template silently alter a document
 * already in someone's hands — for a signed clinical record that is not
 * acceptable.
 */

async function storePdf(scope: string, body: Buffer): Promise<string> {
  const key = buildStorageKey(scope, 'application/pdf');
  await getStorageProvider().put({ key, body, mimeType: 'application/pdf' });
  return key;
}

// ---------------------------------------------------------------------------
// Prescription PDF
// ---------------------------------------------------------------------------

/**
 * Renders and stores a prescription's PDF.
 *
 * Called after issue, and again after an approved substitution — the document
 * in the pharmacy's hands must match what the doctor actually authorised.
 */
export async function generatePrescriptionPdf(
  prescriptionId: string,
  db: PrismaClient = getPrisma(),
): Promise<string> {
  const prescription = await db.prescription.findUnique({
    where: { id: prescriptionId },
    include: {
      items: { orderBy: [{ isActive: 'desc' }, { sortOrder: 'asc' }] },
      doctor: { select: { fullName: true, mdcNumber: true } },
      pharmacy: { select: { name: true, city: true } },
      consultation: { select: { publicId: true } },
      signature: { select: { signatureDataEnc: true } },
    },
  });
  if (!prescription) throw errors.notFound('Prescription not found.');

  const pdf = await renderPrescriptionPdf({
    publicId: prescription.publicId,
    verificationCode: prescription.verificationCode,
    consultationReference: prescription.consultation.publicId,
    issuedAt: prescription.issuedAt ?? prescription.createdAt,
    patient: {
      name: prescription.patientName,
      age: prescription.patientAge,
      sex: prescription.patientSex,
    },
    doctor: prescription.doctor,
    pharmacy: prescription.pharmacy,
    signatureDataEnc: prescription.signature?.signatureDataEnc ?? null,
    items: prescription.items,
  });

  const key = await storePdf(`prescription/${prescription.id}`, pdf);
  await db.prescription.update({ where: { id: prescriptionId }, data: { pdfStorageKey: key } });

  return key;
}

// ---------------------------------------------------------------------------
// Referral
// ---------------------------------------------------------------------------

export interface ReferralInput {
  hospitalName: string;
  department: string;
  reasonText: string;
  urgency?: string;
}

/**
 * Issues a referral (spec §49).
 *
 * `reasonText` is doctor-authored clinical text on a permanent, patient-carried
 * document — a deliberate act of documentation, distinct from the working
 * notes that are sealed at completion (docs/data-retention.md §2).
 */
export async function issueReferral(
  consultationId: string,
  doctorId: string,
  input: ReferralInput,
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
) {
  const consultation = await db.consultation.findUnique({
    where: { id: consultationId },
    include: { patientSession: true },
  });
  if (!consultation) throw errors.notFound('Consultation not found.');
  if (consultation.doctorId !== doctorId) throw errors.notFound('Consultation not found.');

  if (consultation.state !== 'IN_PROGRESS') {
    throw errors.businessRule(
      `A referral can only be issued during a consultation. This one is ${consultation.state}.`,
    );
  }
  if (!input.reasonText?.trim()) {
    throw errors.businessRule('A referral needs a reason. The receiving clinician relies on it.');
  }

  const patient = consultation.patientSession;
  if (!patient?.fullNameEnc || patient.age === null || !patient.sex) {
    throw errors.businessRule('This patient has no recorded name, age or sex.');
  }

  const doctor = await db.doctor.findUniqueOrThrow({
    where: { id: doctorId },
    include: { signatures: { where: { isActive: true }, take: 1 } },
  });
  if (doctor.status !== 'ACTIVE') {
    throw errors.businessRule(`Your account is ${doctor.status}.`);
  }

  const { decryptNullable } = await import('../../lib/crypto.ts');

  const referral = await db.referral.create({
    data: {
      publicId: generatePublicId('ref'),
      consultationId,
      doctorId,
      pharmacyId: consultation.pharmacyId,
      hospitalName: input.hospitalName,
      department: input.department,
      reasonText: input.reasonText.trim(),
      urgency: input.urgency ?? null,
      // Copied by value, like a prescription's (spec §11).
      patientName: decryptNullable(patient.fullNameEnc) ?? '',
      patientAge: patient.age,
      patientSex: patient.sex,
      signatureId: doctor.signatures[0]?.id ?? null,
      issuedAt: clock.now(),
      isDemo: consultation.isDemo,
    },
  });

  const pdf = await renderReferralPdf({
    publicId: referral.publicId,
    // Referrals reuse their publicId as the verification key: unlike a
    // prescription there is nothing to dispense, so the page only confirms
    // the document is genuine.
    verificationCode: referral.publicId,
    consultationReference: consultation.publicId,
    issuedAt: referral.issuedAt,
    patient: {
      name: referral.patientName,
      age: referral.patientAge,
      sex: referral.patientSex,
    },
    doctor: { fullName: doctor.fullName, mdcNumber: doctor.mdcNumber },
    hospitalName: referral.hospitalName,
    department: referral.department,
    urgency: referral.urgency,
    reasonText: referral.reasonText,
    signatureDataEnc: doctor.signatures[0]?.signatureDataEnc ?? null,
  });

  const key = await storePdf(`referral/${referral.id}`, pdf);
  await db.referral.update({ where: { id: referral.id }, data: { pdfStorageKey: key } });

  await recordAudit(
    {
      action: AUDIT_ACTIONS.REFERRAL_GENERATED,
      actorType: 'DOCTOR',
      actorId: doctorId,
      entityType: 'referral',
      entityId: referral.id,
      // Destination and urgency only — the reason is clinical text.
      metadata: { hospitalName: referral.hospitalName, urgency: referral.urgency },
    },
    db,
  );

  emitToPharmacy(consultation.pharmacyId, 'referral.issued', {
    referralPublicId: referral.publicId,
  });

  return referral;
}

// ---------------------------------------------------------------------------
// Consultation summary (decision D25)
// ---------------------------------------------------------------------------

export interface SummaryInput {
  presentingComplaint: string;
  assessment: string;
  advice: string;
  safetyNetting: string;
}

/**
 * Issues the consultation summary.
 *
 * Mandatory for an advice-only outcome, optional otherwise. The doctor writes
 * every field; nothing here composes text from the clinical notes. A document
 * carrying a practitioner's name and signature saying "you do not need
 * medication" is a clinical opinion, and generating it would put words in
 * their mouth (D25).
 *
 * One summary per consultation — it is the record of that encounter, not a
 * series of drafts.
 */
export async function issueSummary(
  consultationId: string,
  doctorId: string,
  input: SummaryInput,
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
) {
  const consultation = await db.consultation.findUnique({
    where: { id: consultationId },
    include: {
      patientSession: true,
      summary: true,
      pharmacy: { select: { name: true, city: true } },
    },
  });
  if (!consultation) throw errors.notFound('Consultation not found.');
  if (consultation.doctorId !== doctorId) throw errors.notFound('Consultation not found.');

  if (consultation.state !== 'IN_PROGRESS') {
    throw errors.businessRule(
      `A summary can only be written during a consultation. This one is ${consultation.state}.`,
    );
  }
  if (consultation.summary) {
    throw errors.conflict('This consultation already has a summary.');
  }

  /**
   * Safety-netting is required (D25).
   *
   * G7g confirms no mandated form, so this is Neem's own rule — and it stands
   * on clinical grounds rather than legal ones. A summary saying only "no
   * medication needed" reads as an all-clear that a remote five-minute
   * assessment cannot support, and would be worse than issuing nothing.
   */
  for (const [field, value] of [
    ['presentingComplaint', input.presentingComplaint],
    ['assessment', input.assessment],
    ['advice', input.advice],
    ['safetyNetting', input.safetyNetting],
  ] as const) {
    if (!value?.trim()) {
      throw errors.validation([
        {
          field,
          issue:
            field === 'safetyNetting'
              ? 'Say what the patient should watch for and when to seek care. A summary without this reads as an all-clear.'
              : 'This is required.',
        },
      ]);
    }
  }

  const patient = consultation.patientSession;
  if (!patient?.fullNameEnc || patient.age === null || !patient.sex) {
    throw errors.businessRule('This patient has no recorded name, age or sex.');
  }

  const doctor = await db.doctor.findUniqueOrThrow({
    where: { id: doctorId },
    include: { signatures: { where: { isActive: true }, take: 1 } },
  });
  if (doctor.status !== 'ACTIVE') {
    throw errors.businessRule(`Your account is ${doctor.status}.`);
  }

  const { decryptNullable } = await import('../../lib/crypto.ts');

  const summary = await db.consultationSummary.create({
    data: {
      publicId: generatePublicId('sum'),
      verificationCode: generateVerificationCode(),
      consultationId,
      doctorId,
      pharmacyId: consultation.pharmacyId,
      patientName: decryptNullable(patient.fullNameEnc) ?? '',
      patientAge: patient.age,
      patientSex: patient.sex,
      presentingComplaint: input.presentingComplaint.trim(),
      assessment: input.assessment.trim(),
      advice: input.advice.trim(),
      safetyNetting: input.safetyNetting.trim(),
      signatureId: doctor.signatures[0]?.id ?? null,
      issuedAt: clock.now(),
      isDemo: consultation.isDemo,
    },
  });

  const pdf = await renderSummaryPdf({
    publicId: summary.publicId,
    verificationCode: summary.verificationCode,
    consultationReference: consultation.publicId,
    issuedAt: summary.issuedAt,
    patient: { name: summary.patientName, age: summary.patientAge, sex: summary.patientSex },
    doctor: { fullName: doctor.fullName, mdcNumber: doctor.mdcNumber },
    pharmacy: consultation.pharmacy,
    presentingComplaint: summary.presentingComplaint,
    assessment: summary.assessment,
    advice: summary.advice,
    safetyNetting: summary.safetyNetting,
    signatureDataEnc: doctor.signatures[0]?.signatureDataEnc ?? null,
  });

  const key = await storePdf(`summary/${summary.id}`, pdf);
  await db.consultationSummary.update({
    where: { id: summary.id },
    data: { pdfStorageKey: key },
  });

  await recordAudit(
    {
      action: AUDIT_ACTIONS.SUMMARY_ISSUED,
      actorType: 'DOCTOR',
      actorId: doctorId,
      entityType: 'consultation_summary',
      entityId: summary.id,
      // Nothing of what it says: the summary is clinical text (spec §61).
      metadata: { consultationId },
    },
    db,
  );

  return summary;
}

// ---------------------------------------------------------------------------
// Verification (spec §44)
// ---------------------------------------------------------------------------

export interface VerificationResult {
  kind: 'prescription' | 'referral' | 'summary';
  genuine: true;
  publicId: string;
  issuedAt: string;
  /** The issuing doctor, so the reader can confirm who signed it. */
  doctor: { fullName: string; mdcNumber: string };
  /** Present for a prescription; a revoked one must be visibly refused. */
  state?: string;
  revoked?: boolean;
  dispensed?: boolean;
}

/**
 * The public verification page's data (spec §44).
 *
 * Unauthenticated by design — a pharmacist or hospital clerk holding a printout
 * must be able to check it without an account. It therefore returns **only what
 * proves the document is genuine**: never the medication, never the reason for
 * referral, never the advice. Anyone who needs the content is holding it.
 *
 * The high-entropy code is the sole guard, which is why it is longer than a
 * public id and why the page is rate limited.
 */
export async function verifyDocument(
  kind: 'rx' | 'referral' | 'summary',
  code: string,
  db: Db = getPrisma(),
): Promise<VerificationResult> {
  if (kind === 'rx') {
    const prescription = await db.prescription.findUnique({
      where: { verificationCode: code },
      include: { doctor: { select: { fullName: true, mdcNumber: true } } },
    });
    // Drafts are not documents and must not verify.
    if (!prescription || prescription.state === 'DRAFT') {
      throw errors.notFound('No document matches that code.');
    }

    return {
      kind: 'prescription',
      genuine: true,
      publicId: prescription.publicId,
      issuedAt: (prescription.issuedAt ?? prescription.createdAt).toISOString(),
      doctor: prescription.doctor,
      state: prescription.state,
      revoked: prescription.state === 'REVOKED',
      dispensed: prescription.state === 'DISPENSED',
    };
  }

  if (kind === 'referral') {
    const referral = await db.referral.findUnique({
      where: { publicId: code },
      include: { doctor: { select: { fullName: true, mdcNumber: true } } },
    });
    if (!referral) throw errors.notFound('No document matches that code.');

    return {
      kind: 'referral',
      genuine: true,
      publicId: referral.publicId,
      issuedAt: referral.issuedAt.toISOString(),
      doctor: referral.doctor,
    };
  }

  const summary = await db.consultationSummary.findUnique({
    where: { verificationCode: code },
    include: { doctor: { select: { fullName: true, mdcNumber: true } } },
  });
  if (!summary) throw errors.notFound('No document matches that code.');

  return {
    kind: 'summary',
    genuine: true,
    publicId: summary.publicId,
    issuedAt: summary.issuedAt.toISOString(),
    doctor: summary.doctor,
  };
}

/** Streams a stored PDF. The caller has already established who may read it. */
export async function readDocumentPdf(storageKey: string): Promise<Buffer> {
  return getStorageProvider().get(storageKey);
}

// ---------------------------------------------------------------------------
// What a consultation produced, and what has happened to it since
// ---------------------------------------------------------------------------

export type DocumentKind = 'prescription' | 'referral' | 'summary';

/**
 * The live state of a document, which is not the same thing as the document.
 *
 * The PDF is generated once at issue and never rewritten — see the note at the
 * top of this file. So a prescription dispensed a day later cannot say so on
 * its own face, and stamping it afterwards would mean either mutating a signed
 * clinical record or keeping two versions of one prescription. Neither is
 * acceptable for a document a pharmacist may act on.
 *
 * Status therefore lives beside the document rather than inside it: here, on
 * the patient's own screen, and on the public verification page that the QR
 * code in every footer points at. The paper says what the doctor decided; this
 * says what has happened since.
 */
export interface DocumentStatus {
  code: 'AWAITING_DISPENSE' | 'DISPENSED' | 'REVOKED' | 'ISSUED';
  label: string;
  detail: string | null;
}

export interface ConsultationDocument {
  kind: DocumentKind;
  publicId: string;
  title: string;
  issuedAt: string;
  /** False when the PDF has not been written yet; the row can exist first. */
  available: boolean;
  status: DocumentStatus;
}

const isoDay = (value: Date): string => value.toISOString().slice(0, 10);

function prescriptionStatus(prescription: {
  state: string;
  dispensedAt: Date | null;
  pharmacy: { name: string };
}): DocumentStatus {
  if (prescription.state === 'REVOKED') {
    return {
      code: 'REVOKED',
      label: 'Revoked',
      /*
       * The reason is deliberately not repeated. It is free text a doctor
       * wrote, it can carry clinical detail, and this string renders on a
       * screen the patient may be holding at a counter with other people
       * behind them. That it was revoked is what changes what anyone does
       * next; why is a conversation, not a status line.
       */
      detail: 'This prescription is no longer valid. Please speak to the pharmacy.',
    };
  }

  if (prescription.state === 'DISPENSED') {
    return {
      code: 'DISPENSED',
      label: 'Dispensed',
      detail: prescription.dispensedAt
        ? `Dispensed at ${prescription.pharmacy.name} on ${isoDay(prescription.dispensedAt)}.`
        : `Dispensed at ${prescription.pharmacy.name}.`,
    };
  }

  return {
    code: 'AWAITING_DISPENSE',
    label: 'Not yet dispensed',
    /*
     * Says what the patient can actually do. Only the consultation's own
     * pharmacy can dispense this through Neem (spec §45), but any pharmacy
     * anywhere can confirm the document is genuine by scanning the code
     * printed on it — which is the thing a stranger behind a counter needs.
     */
    detail:
      `${prescription.pharmacy.name} can dispense this. Any other pharmacy can check it is ` +
      'genuine by scanning the code printed on the document.',
  };
}

/**
 * Every document a consultation produced.
 *
 * Ordered prescription, referral, summary rather than by time: that is the
 * order of urgency to someone standing at a counter, and all three are issued
 * within moments of each other anyway, so ordering by issue time would shuffle
 * them for no reason a reader could follow.
 */
export async function listConsultationDocuments(
  consultationId: string,
  db: Db = getPrisma(),
): Promise<ConsultationDocument[]> {
  const [prescriptions, referrals, summary] = await Promise.all([
    db.prescription.findMany({
      where: { consultationId, state: { not: 'DRAFT' } },
      select: {
        publicId: true,
        state: true,
        issuedAt: true,
        createdAt: true,
        dispensedAt: true,
        pdfStorageKey: true,
        pharmacy: { select: { name: true } },
      },
      orderBy: { createdAt: 'asc' },
    }),
    db.referral.findMany({
      where: { consultationId },
      select: { publicId: true, issuedAt: true, pdfStorageKey: true, hospitalName: true },
      orderBy: { issuedAt: 'asc' },
    }),
    db.consultationSummary.findUnique({
      where: { consultationId },
      select: { publicId: true, issuedAt: true, pdfStorageKey: true },
    }),
  ]);

  const documents: ConsultationDocument[] = [];

  for (const prescription of prescriptions) {
    documents.push({
      kind: 'prescription',
      publicId: prescription.publicId,
      title: 'Prescription',
      issuedAt: (prescription.issuedAt ?? prescription.createdAt).toISOString(),
      available: prescription.pdfStorageKey !== null,
      status: prescriptionStatus(prescription),
    });
  }

  for (const referral of referrals) {
    documents.push({
      kind: 'referral',
      publicId: referral.publicId,
      title: `Referral to ${referral.hospitalName}`,
      issuedAt: referral.issuedAt.toISOString(),
      available: referral.pdfStorageKey !== null,
      status: { code: 'ISSUED', label: 'Issued', detail: null },
    });
  }

  if (summary) {
    documents.push({
      kind: 'summary',
      publicId: summary.publicId,
      title: 'Consultation summary',
      issuedAt: summary.issuedAt.toISOString(),
      available: summary.pdfStorageKey !== null,
      status: { code: 'ISSUED', label: 'Issued', detail: null },
    });
  }

  return documents;
}

/**
 * A document's stored PDF, but only if it belongs to the consultation named.
 *
 * The consultation is the authorisation boundary, and it is a parameter rather
 * than something this function derives, so a caller cannot accidentally hand
 * over a document from somewhere else. A patient session is bound to exactly
 * one consultation (spec §102), so passing its id through is the whole check.
 *
 * Not found rather than forbidden when the document belongs to another
 * consultation: whether a given prescription exists at all is not something an
 * unrelated caller should be able to learn.
 */
export async function readConsultationDocument(
  consultationId: string,
  kind: DocumentKind,
  publicId: string,
  db: Db = getPrisma(),
): Promise<{ buffer: Buffer; filename: string }> {
  const found = await (async () => {
    if (kind === 'prescription') {
      const row = await db.prescription.findUnique({
        where: { publicId },
        select: { consultationId: true, pdfStorageKey: true, state: true },
      });
      // A draft is not a document and must never leave the doctor's screen.
      return row && row.state !== 'DRAFT' ? row : null;
    }
    if (kind === 'referral') {
      return db.referral.findUnique({
        where: { publicId },
        select: { consultationId: true, pdfStorageKey: true },
      });
    }
    return db.consultationSummary.findUnique({
      where: { publicId },
      select: { consultationId: true, pdfStorageKey: true },
    });
  })();

  if (!found || found.consultationId !== consultationId) {
    throw errors.notFound('Document not found.');
  }
  if (!found.pdfStorageKey) {
    throw errors.notFound('That document has not been generated.');
  }

  return {
    buffer: await readDocumentPdf(found.pdfStorageKey),
    filename: `${publicId}.pdf`,
  };
}
