import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PERMISSIONS } from '@neem/contracts';
import { getPrisma } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { guard, requireAuth } from '../../middleware/auth.ts';
import {
  completeConsultation,
  readWorkspace,
  saveClinicalNotes,
} from './clinical.service.ts';
import {
  createDraft,
  decideSubstitution,
  dispensePrescription,
  issuePrescription,
  proposeSubstitution,
  readPrescription,
  revokePrescription,
} from '../prescription/prescription.service.ts';
import {
  generatePrescriptionPdf,
  issueReferral,
  issueSummary,
  readDocumentPdf,
  verifyDocument,
} from '../documents/document.service.ts';
import {
  isSealed,
  readClinicalRecord,
  recordTest,
  recordVitals,
} from '../retention/clinical-record.service.ts';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit.service.ts';
import { queryBoolean } from '../../lib/query.ts';

/**
 * The clinical workflow (spec §41–§50).
 *
 * Who may do what is the whole design here, so it is worth stating plainly:
 *
 *  - **The pharmacy** records vitals and point-of-care results, receives
 *    prescriptions, proposes substitutions and dispenses. It never writes or
 *    edits a prescription (spec §47).
 *  - **The doctor** writes notes, prescribes, refers, decides substitutions,
 *    revokes before dispensing, and completes. Only the doctor completes
 *    (spec §16).
 *  - **Anyone** may verify a document is genuine, without an account — and
 *    learns nothing from it beyond that (spec §44).
 */

function requireDoctor(request: FastifyRequest): string {
  const principal = requireAuth(request);
  if (principal.role !== 'DOCTOR' || !principal.organisationId) {
    throw errors.forbidden('This area is for doctor accounts.');
  }
  return principal.organisationId;
}

function requirePharmacy(request: FastifyRequest): { pharmacyId: string; userId: string } {
  const principal = requireAuth(request);
  if (principal.role !== 'PHARMACY' || !principal.organisationId) {
    throw errors.forbidden('This area is for pharmacy accounts.');
  }
  return { pharmacyId: principal.organisationId, userId: principal.userId };
}

/** Resolves a consultation the calling doctor is assigned to. */
async function doctorConsultation(publicId: string, doctorId: string): Promise<string> {
  const consultation = await getPrisma().consultation.findUnique({
    where: { publicId },
    select: { id: true, doctorId: true },
  });
  // 404, never 403 (spec §102).
  if (!consultation || consultation.doctorId !== doctorId) {
    throw errors.notFound('Consultation not found.');
  }
  return consultation.id;
}

/** Resolves a consultation belonging to the calling pharmacy. */
async function pharmacyConsultation(publicId: string, pharmacyId: string): Promise<string> {
  const consultation = await getPrisma().consultation.findUnique({
    where: { publicId },
    select: { id: true, pharmacyId: true },
  });
  if (!consultation || consultation.pharmacyId !== pharmacyId) {
    throw errors.notFound('Consultation not found.');
  }
  return consultation.id;
}

const publicIdParams = z.object({ publicId: z.string().min(1).max(64) });

const itemSchema = z.object({
  medication: z.string().trim().min(1).max(200),
  strength: z.string().trim().max(80).optional(),
  form: z.string().trim().max(80).optional(),
  dose: z.string().trim().min(1).max(120),
  frequency: z.string().trim().min(1).max(120),
  durationText: z.string().trim().min(1).max(120),
  quantity: z.string().trim().min(1).max(80),
  instructions: z.string().trim().max(500).optional(),
});

export async function clinicalRoutes(app: FastifyInstance): Promise<void> {
  const doctorOnly = guard({ roles: ['DOCTOR'], permissions: [PERMISSIONS.CONSULTATION_CONDUCT] });
  const pharmacyOnly = guard({ roles: ['PHARMACY'] });

  // -------------------------------------------------------------------------
  // Pharmacy: vitals and point-of-care results (spec §50)
  // -------------------------------------------------------------------------

  /**
   * What this pharmacy has already recorded for this consultation.
   *
   * A pharmacist needs to see it: without a read-back they cannot tell whether
   * the reading went in, and the natural response to that doubt is to enter it
   * a second time.
   *
   * It returns observations only. The doctor's notes, diagnosis and treatment
   * live in the same guarded record and are deliberately not selected here — a
   * pharmacy records vitals, it does not read the consultation (spec §50).
   */
  app.get(
    '/pharmacy/consultations/:publicId/observations',
    { preHandler: pharmacyOnly },
    async (request, reply) => {
      const { pharmacyId } = requirePharmacy(request);
      const { publicId } = publicIdParams.parse(request.params);
      const consultationId = await pharmacyConsultation(publicId, pharmacyId);

      // Once the consultation is over the record is sealed and nobody reads it
      // back, the recording pharmacy included (D23).
      if (await isSealed(consultationId)) {
        return reply.send({
          data: { sealed: true, vitals: null, tests: [] },
          meta: { requestId: request.correlationId },
        });
      }

      const record = await readClinicalRecord(consultationId);

      return reply.send({
        data: { sealed: false, vitals: record.vitals, tests: record.tests },
        meta: { requestId: request.correlationId },
      });
    },
  );

  app.post(
    '/pharmacy/consultations/:publicId/vitals',
    { preHandler: pharmacyOnly },
    async (request, reply) => {
      const { pharmacyId, userId } = requirePharmacy(request);
      const { publicId } = publicIdParams.parse(request.params);
      const consultationId = await pharmacyConsultation(publicId, pharmacyId);

      const readings = z
        .object({
          bpSystolic: z.number().int().min(40).max(300).optional(),
          bpDiastolic: z.number().int().min(20).max(200).optional(),
          pulseBpm: z.number().int().min(20).max(250).optional(),
          temperatureC: z.number().min(25).max(45).optional(),
          weightKg: z.number().min(1).max(400).optional(),
          spo2Percent: z.number().int().min(50).max(100).optional(),
        })
        .parse(request.body);

      await recordVitals(consultationId, readings, userId);

      return reply.status(201).send({
        data: { recorded: true },
        meta: { requestId: request.correlationId },
      });
    },
  );

  app.post(
    '/pharmacy/consultations/:publicId/tests',
    { preHandler: pharmacyOnly },
    async (request, reply) => {
      const { pharmacyId, userId } = requirePharmacy(request);
      const { publicId } = publicIdParams.parse(request.params);
      const consultationId = await pharmacyConsultation(publicId, pharmacyId);

      const body = z
        .object({
          code: z.string().trim().min(1).max(60),
          label: z.string().trim().min(1).max(160),
          // Free text, per the answers doc: pharmacies type what the device
          // or strip showed rather than picking from a fixed list.
          result: z.string().trim().min(1).max(500),
        })
        .parse(request.body);

      await recordTest(consultationId, body, userId);

      return reply.status(201).send({
        data: { recorded: true },
        meta: { requestId: request.correlationId },
      });
    },
  );

  // -------------------------------------------------------------------------
  // Doctor: the clinical workspace
  // -------------------------------------------------------------------------

  app.get(
    '/doctor/consultations/:publicId/workspace',
    { preHandler: doctorOnly },
    async (request, reply) => {
      const doctorId = requireDoctor(request);
      const { publicId } = publicIdParams.parse(request.params);
      const consultationId = await doctorConsultation(publicId, doctorId);

      return reply.send({
        data: await readWorkspace(consultationId),
        meta: { requestId: request.correlationId },
      });
    },
  );

  app.put(
    '/doctor/consultations/:publicId/notes',
    { preHandler: doctorOnly },
    async (request, reply) => {
      const doctorId = requireDoctor(request);
      const { publicId } = publicIdParams.parse(request.params);
      const consultationId = await doctorConsultation(publicId, doctorId);

      const body = z
        .object({
          notes: z.string().max(20_000).nullish(),
          diagnosis: z.string().max(2_000).nullish(),
          treatment: z.string().max(4_000).nullish(),
        })
        .parse(request.body);

      await saveClinicalNotes(consultationId, body);

      return reply.send({ data: { saved: true }, meta: { requestId: request.correlationId } });
    },
  );

  // -------------------------------------------------------------------------
  // Doctor: prescribing
  // -------------------------------------------------------------------------

  app.post(
    '/doctor/consultations/:publicId/prescriptions',
    { preHandler: doctorOnly },
    async (request, reply) => {
      const doctorId = requireDoctor(request);
      const { publicId } = publicIdParams.parse(request.params);
      const consultationId = await doctorConsultation(publicId, doctorId);

      const body = z.object({ items: z.array(itemSchema).min(1).max(20) }).parse(request.body);
      const draft = await createDraft(consultationId, doctorId, body.items);

      return reply.status(201).send({
        data: { publicId: draft.publicId, state: draft.state },
        meta: { requestId: request.correlationId },
      });
    },
  );

  /**
   * Issues the prescription: signs it and hands it to the pharmacy.
   *
   * The PDF is generated here, once, and stored. Rendering on each download
   * would let a template change silently alter a document already in a
   * patient's hands.
   */
  app.post(
    '/doctor/prescriptions/:publicId/issue',
    { preHandler: doctorOnly },
    async (request, reply) => {
      const doctorId = requireDoctor(request);
      const { publicId } = publicIdParams.parse(request.params);

      const prescription = await getPrisma().prescription.findUnique({
        where: { publicId },
        select: { id: true, doctorId: true },
      });
      if (!prescription || prescription.doctorId !== doctorId) {
        throw errors.notFound('Prescription not found.');
      }

      const issued = await issuePrescription(prescription.id, doctorId);
      await generatePrescriptionPdf(prescription.id);

      return reply.send({
        data: { publicId: issued.publicId, state: issued.state },
        meta: { requestId: request.correlationId },
      });
    },
  );

  app.post(
    '/doctor/prescriptions/:publicId/revoke',
    { preHandler: doctorOnly },
    async (request, reply) => {
      const doctorId = requireDoctor(request);
      const { publicId } = publicIdParams.parse(request.params);
      const { reason } = z
        .object({ reason: z.string().trim().min(3).max(500) })
        .parse(request.body);

      const prescription = await getPrisma().prescription.findUnique({
        where: { publicId },
        select: { id: true, doctorId: true },
      });
      if (!prescription || prescription.doctorId !== doctorId) {
        throw errors.notFound('Prescription not found.');
      }

      const revoked = await revokePrescription(prescription.id, doctorId, reason);

      return reply.send({
        data: { publicId: revoked.publicId, state: revoked.state },
        meta: { requestId: request.correlationId },
      });
    },
  );

  /**
   * There is deliberately no route by which a prescription's items can be
   * edited after issue. A correction is a revocation plus a new prescription,
   * so the trail shows what actually happened.
   */

  /**
   * Substitutions awaiting this doctor's decision.
   *
   * Without this the loop does not close. A pharmacy can propose a
   * substitution, and the prescription then sits in PENDING_SUBSTITUTION —
   * undispensable — with nothing anywhere telling the doctor a decision is
   * owed. The realtime event reaches a doctor who happens to be online; this
   * is what a doctor who was not sees when they come back.
   *
   * Scoped to prescriptions this doctor signed. It is not consultation
   * history: what it returns is the doctor's own prescription and the
   * pharmacy's proposal against it, which is the minimum needed to answer
   * responsibly. Nothing clinical from the consultation appears here, and the
   * sealed record is not read (D23).
   */
  app.get('/doctor/substitutions', { preHandler: doctorOnly }, async (request, reply) => {
    const doctorId = requireDoctor(request);

    const pending = await getPrisma().substitutionRequest.findMany({
      where: {
        state: 'PENDING',
        prescription: { doctorId, state: 'PENDING_SUBSTITUTION' },
      },
      include: {
        prescription: {
          select: {
            publicId: true,
            patientName: true,
            patientAge: true,
            patientSex: true,
            issuedAt: true,
            pharmacy: { select: { name: true, city: true } },
            consultation: { select: { publicId: true } },
          },
        },
        prescriptionItem: {
          select: {
            id: true,
            medication: true,
            strength: true,
            form: true,
            dose: true,
            frequency: true,
            durationText: true,
            quantity: true,
            instructions: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    return reply.send({
      data: pending.map((proposal) => ({
        id: proposal.id,
        requestedAt: proposal.createdAt.toISOString(),
        reason: proposal.reason,
        proposed: {
          medication: proposal.proposedMedication,
          strength: proposal.proposedStrength,
          form: proposal.proposedForm,
        },
        prescribed: proposal.prescriptionItem,
        prescriptionPublicId: proposal.prescription.publicId,
        consultationReference: proposal.prescription.consultation.publicId,
        issuedAt: proposal.prescription.issuedAt?.toISOString() ?? null,
        pharmacy: proposal.prescription.pharmacy,
        patient: {
          fullName: proposal.prescription.patientName,
          age: proposal.prescription.patientAge,
          sex: proposal.prescription.patientSex,
        },
      })),
      meta: { requestId: request.correlationId },
    });
  });

  app.post(
    '/doctor/substitutions/:id/decide',
    { preHandler: doctorOnly },
    async (request, reply) => {
      const doctorId = requireDoctor(request);
      const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
      const body = z
        .object({ approve: z.boolean(), note: z.string().trim().max(500).optional() })
        .parse(request.body);

      await decideSubstitution(id, doctorId, body);

      const request_ = await getPrisma().substitutionRequest.findUniqueOrThrow({
        where: { id },
        select: { prescriptionId: true },
      });
      // The document must match what the doctor actually authorised.
      await generatePrescriptionPdf(request_.prescriptionId);

      return reply.send({
        data: { id, approved: body.approve },
        meta: { requestId: request.correlationId },
      });
    },
  );

  // -------------------------------------------------------------------------
  // Doctor: referral and summary
  // -------------------------------------------------------------------------

  app.post(
    '/doctor/consultations/:publicId/referrals',
    { preHandler: doctorOnly },
    async (request, reply) => {
      const doctorId = requireDoctor(request);
      const { publicId } = publicIdParams.parse(request.params);
      const consultationId = await doctorConsultation(publicId, doctorId);

      const body = z
        .object({
          hospitalName: z.string().trim().min(2).max(200),
          department: z.string().trim().min(2).max(160),
          reasonText: z.string().trim().min(5).max(5_000),
          urgency: z.string().trim().max(40).optional(),
        })
        .parse(request.body);

      const referral = await issueReferral(consultationId, doctorId, body);

      return reply.status(201).send({
        data: { publicId: referral.publicId },
        meta: { requestId: request.correlationId },
      });
    },
  );

  app.post(
    '/doctor/consultations/:publicId/summary',
    { preHandler: doctorOnly },
    async (request, reply) => {
      const doctorId = requireDoctor(request);
      const { publicId } = publicIdParams.parse(request.params);
      const consultationId = await doctorConsultation(publicId, doctorId);

      const body = z
        .object({
          presentingComplaint: z.string().trim().min(3).max(500),
          assessment: z.string().trim().min(3).max(5_000),
          advice: z.string().trim().min(3).max(5_000),
          // Required. See the note on `issueSummary` (decision D25).
          safetyNetting: z.string().trim().min(3).max(5_000),
        })
        .parse(request.body);

      const summary = await issueSummary(consultationId, doctorId, body);

      return reply.status(201).send({
        data: { publicId: summary.publicId },
        meta: { requestId: request.correlationId },
      });
    },
  );

  // -------------------------------------------------------------------------
  // Doctor: completion — the only path (spec §16)
  // -------------------------------------------------------------------------

  app.post(
    '/doctor/consultations/:publicId/complete',
    { preHandler: doctorOnly },
    async (request, reply) => {
      const doctorId = requireDoctor(request);
      const { publicId } = publicIdParams.parse(request.params);
      const consultationId = await doctorConsultation(publicId, doctorId);

      const body = z
        .object({
          outcome: z.enum([
            'ADVICE_ONLY',
            'PRESCRIPTION',
            'REFERRAL',
            'EMERGENCY_REFERRAL',
            'OTHER',
          ]),
          notes: z
            .object({
              notes: z.string().max(20_000).nullish(),
              diagnosis: z.string().max(2_000).nullish(),
              treatment: z.string().max(4_000).nullish(),
            })
            .optional(),
        })
        .parse(request.body);

      const result = await completeConsultation(consultationId, doctorId, body);

      return reply.send({ data: result, meta: { requestId: request.correlationId } });
    },
  );

  // -------------------------------------------------------------------------
  // Pharmacy: receiving, substituting, dispensing
  // -------------------------------------------------------------------------

  app.get('/pharmacy/prescriptions', { preHandler: pharmacyOnly }, async (request, reply) => {
    const { pharmacyId } = requirePharmacy(request);
    const query = z
      .object({ activeOnly: queryBoolean.optional(), limit: z.coerce.number().int().min(1).max(100).optional() })
      .parse(request.query);

    const prescriptions = await getPrisma().prescription.findMany({
      where: {
        pharmacyId,
        // A draft is not a document and the pharmacy never sees one.
        state: query.activeOnly
          ? { in: ['ACTIVE', 'PENDING_SUBSTITUTION', 'SUBSTITUTION_APPROVED', 'SUBSTITUTION_REJECTED'] }
          : { not: 'DRAFT' },
      },
      include: {
        items: { where: { isActive: true }, orderBy: { sortOrder: 'asc' } },
        doctor: { select: { fullName: true, mdcNumber: true } },
        consultation: { select: { publicId: true } },
        /**
         * The most recent substitution, so the counter can see what the doctor
         * said. A refusal is the case that matters: SUBSTITUTION_REJECTED on
         * its own tells a pharmacist the answer was no but not why, and "why"
         * is what they have to explain to the patient standing there.
         */
        substitutions: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            state: true,
            proposedMedication: true,
            reason: true,
            decisionNote: true,
            decidedAt: true,
          },
        },
      },
      orderBy: { issuedAt: 'desc' },
      take: query.limit ?? 50,
    });

    return reply.send({
      data: prescriptions.map((rx) => ({
        publicId: rx.publicId,
        consultationReference: rx.consultation.publicId,
        state: rx.state,
        patientName: rx.patientName,
        patientAge: rx.patientAge,
        doctor: rx.doctor,
        issuedAt: rx.issuedAt?.toISOString() ?? null,
        dispensedAt: rx.dispensedAt?.toISOString() ?? null,
        revokedAt: rx.revokedAt?.toISOString() ?? null,
        revokedReason: rx.revokedReason,
        lastSubstitution: rx.substitutions[0]
          ? {
              state: rx.substitutions[0].state,
              proposedMedication: rx.substitutions[0].proposedMedication,
              reason: rx.substitutions[0].reason,
              decisionNote: rx.substitutions[0].decisionNote,
              decidedAt: rx.substitutions[0].decidedAt?.toISOString() ?? null,
            }
          : null,
        items: rx.items,
      })),
      meta: { requestId: request.correlationId },
    });
  });

  app.post(
    '/pharmacy/prescriptions/:publicId/dispense',
    { preHandler: pharmacyOnly },
    async (request, reply) => {
      const { pharmacyId, userId } = requirePharmacy(request);
      const { publicId } = publicIdParams.parse(request.params);

      const prescription = await getPrisma().prescription.findUnique({
        where: { publicId },
        select: { id: true, pharmacyId: true },
      });
      // A pharmacy must not learn another pharmacy's prescription exists
      // (spec §102, decision D13).
      if (!prescription || prescription.pharmacyId !== pharmacyId) {
        throw errors.notFound('Prescription not found.');
      }

      const dispensed = await dispensePrescription(prescription.id, pharmacyId, userId);

      return reply.send({
        data: { publicId: dispensed.publicId, state: dispensed.state },
        meta: { requestId: request.correlationId },
      });
    },
  );

  app.post(
    '/pharmacy/prescriptions/:publicId/substitutions',
    { preHandler: pharmacyOnly },
    async (request, reply) => {
      const { pharmacyId, userId } = requirePharmacy(request);
      const { publicId } = publicIdParams.parse(request.params);

      const body = z
        .object({
          itemId: z.string().min(1),
          medication: z.string().trim().min(1).max(200),
          strength: z.string().trim().max(80).optional(),
          form: z.string().trim().max(80).optional(),
          reason: z.string().trim().min(3).max(500),
        })
        .parse(request.body);

      const prescription = await getPrisma().prescription.findUnique({
        where: { publicId },
        select: { id: true, pharmacyId: true },
      });
      if (!prescription || prescription.pharmacyId !== pharmacyId) {
        throw errors.notFound('Prescription not found.');
      }

      const proposal = await proposeSubstitution(
        prescription.id,
        body.itemId,
        pharmacyId,
        userId,
        body,
      );

      return reply.status(201).send({
        data: { id: proposal.id, state: proposal.state },
        meta: { requestId: request.correlationId },
      });
    },
  );

  // -------------------------------------------------------------------------
  // Documents
  // -------------------------------------------------------------------------

  /**
   * Streams a prescription PDF to one of the four permitted readers
   * (decision D13): the issuing doctor, the dispensing pharmacy, the patient
   * through their session, and Neem Admin.
   *
   * Every read is audited — access to a clinical document is exactly what a
   * regulator asks about (spec §61).
   */
  app.get('/documents/prescriptions/:publicId.pdf', async (request, reply) => {
    const principal = requireAuth(request);
    const { publicId } = z
      .object({ publicId: z.string().min(1).max(64) })
      .parse({ publicId: (request.params as { publicId: string }).publicId });

    const prescription = await getPrisma().prescription.findUnique({
      where: { publicId },
      select: { id: true, doctorId: true, pharmacyId: true, pdfStorageKey: true, state: true },
    });
    if (!prescription || prescription.state === 'DRAFT') {
      throw errors.notFound('Prescription not found.');
    }

    const permitted =
      principal.role === 'ADMIN' ||
      (principal.role === 'DOCTOR' && principal.organisationId === prescription.doctorId) ||
      (principal.role === 'PHARMACY' && principal.organisationId === prescription.pharmacyId);

    if (!permitted) throw errors.notFound('Prescription not found.');
    if (!prescription.pdfStorageKey) throw errors.notFound('That document has not been generated.');

    await recordAudit(
      {
        action: AUDIT_ACTIONS.DOCUMENT_DOWNLOADED,
        actorType: principal.role,
        actorId: principal.userId,
        entityType: 'prescription',
        entityId: prescription.id,
        correlationId: request.correlationId,
      },
      getPrisma(),
    );

    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `inline; filename="${publicId}.pdf"`)
      .header('cache-control', 'private, no-store')
      .send(await readDocumentPdf(prescription.pdfStorageKey));
  });

  /**
   * The public verification page (spec §44).
   *
   * Unauthenticated by design: a pharmacist or hospital clerk holding a
   * printout must be able to check it without an account. It returns only
   * whether the document is genuine and who signed it — never the medication,
   * the reason for referral, or the advice. Anyone who needs the content is
   * already holding it.
   *
   * The high-entropy code is the sole guard, so the endpoint is rate limited
   * against enumeration.
   */
  app.get(
    '/verify/:kind/:code',
    { config: { rateLimit: { max: 30, timeWindow: '5 minutes' } } },
    async (request, reply) => {
      const params = z
        .object({
          kind: z.enum(['rx', 'referral', 'summary']),
          code: z.string().min(8).max(64),
        })
        .parse(request.params);

      const result = await verifyDocument(params.kind, params.code);

      return reply.send({ data: result, meta: { requestId: request.correlationId } });
    },
  );
}
