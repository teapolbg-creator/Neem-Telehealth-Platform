import type { Prisma } from '@prisma/client';
import type { VisitPrescription } from '@neem/contracts';
import { getPrisma, type Db } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
import { canDispense } from '../../domain/prescription-state.ts';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit.service.ts';
import { emitToDoctor } from '../realtime/realtime.service.ts';
import type { StaffContext } from './patient.service.ts';

/**
 * Prescriptions for CHPS patients, as the facility handles them (slice 2d,
 * D79, D83).
 *
 * The doctor issues a prescription exactly as for any other channel, signed
 * and with its verification code. The patient may take the printout to any
 * pharmacy; when the compound has the medicine in stock, the CHO gives it and
 * records that here. A prescription is dispensed once, wherever that is.
 */

export const visitPrescriptionInclude = {
  where: { state: { not: 'DRAFT' } },
  orderBy: { issuedAt: 'asc' },
  include: {
    doctor: { select: { fullName: true } },
    items: { where: { isActive: true }, orderBy: { sortOrder: 'asc' } },
  },
} satisfies Prisma.Consultation$prescriptionsArgs;

type PrescriptionRow = Prisma.PrescriptionGetPayload<{
  include: (typeof visitPrescriptionInclude)['include'];
}>;

export function toVisitPrescription(row: PrescriptionRow): VisitPrescription {
  return {
    publicId: row.publicId,
    state: row.state,
    issuedAt: row.issuedAt?.toISOString() ?? null,
    doctorName: row.doctor.fullName,
    items: row.items.map((item) => ({
      medication: item.medication,
      strength: item.strength,
      form: item.form,
      dose: item.dose,
      frequency: item.frequency,
      duration: item.durationText,
      quantity: item.quantity,
      instructions: item.instructions,
    })),
    dispensedAt: row.dispensedAt?.toISOString() ?? null,
    dispensedHere: row.dispensedFacilityId !== null,
  };
}

/** The CHO gives the medicine from the compound's stock. */
export async function dispenseAtFacility(
  ctx: StaffContext,
  publicId: string,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<VisitPrescription> {
  const prescription = await db.prescription.findUnique({
    where: { publicId },
    include: {
      consultation: { select: { facilityId: true } },
      substitutions: { where: { state: 'PENDING' }, select: { id: true } },
    },
  });
  // Another facility's prescription, or a pharmacy channel's, does not exist here.
  if (!prescription || prescription.consultation.facilityId !== ctx.facilityId) {
    throw errors.notFound('Prescription not found.');
  }
  if (prescription.state === 'REVOKED') {
    throw errors.businessRule('The doctor revoked this prescription. Do not give it.');
  }
  if (prescription.state === 'DISPENSED') {
    throw errors.conflict('This prescription has already been dispensed.');
  }
  if (prescription.substitutions.length > 0 || !canDispense(prescription.state)) {
    throw errors.businessRule(`A ${prescription.state} prescription cannot be dispensed.`);
  }

  await db.prescription.update({
    where: { id: prescription.id },
    data: {
      state: 'DISPENSED',
      dispensedAt: clock.now(),
      dispensedByUserId: ctx.userId,
      dispensedFacilityId: ctx.facilityId,
    },
  });
  await recordAudit(
    {
      action: AUDIT_ACTIONS.PRESCRIPTION_DISPENSED,
      actorType: 'FACILITY',
      actorId: ctx.userId,
      entityType: 'prescription',
      entityId: prescription.id,
      correlationId: ctx.correlationId,
      metadata: { atFacility: true },
    },
    db,
  );
  emitToDoctor(prescription.doctorId, 'prescription.dispensed', {
    prescriptionPublicId: prescription.publicId,
  });

  const row = await db.prescription.findUniqueOrThrow({
    where: { id: prescription.id },
    include: visitPrescriptionInclude.include,
  });
  return toVisitPrescription(row);
}
