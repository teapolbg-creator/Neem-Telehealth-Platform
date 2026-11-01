import { randomInt } from 'node:crypto';
import type { Prisma, ReferralStatus } from '@prisma/client';
import { startOfDay } from 'date-fns';
import {
  OPEN_REFERRAL_STATUSES,
  OPEN_VISIT_STATUSES,
  type ReferralCreate,
  type ReferralDestination,
  type ReferralRegisterRow,
  type ReferralView,
} from '@neem/contracts';
import { getPrisma, isUniqueConstraintError, type Db } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { decryptField, decryptNullable, encryptField, encryptNullable } from '../../lib/crypto.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit.service.ts';
import type { StaffContext } from './patient.service.ts';

/**
 * Tracked referrals from a CHPS compound (slice 2a, D79, D80).
 *
 * A referral records where a patient was sent, why, how urgently and how they
 * are getting there, and then what became of it. The receiving facility has
 * no Neem account (D79): every step after ISSUED is recorded by the CHO, with
 * who recorded it and how they learned it, so the record never claims more
 * than somebody actually confirmed.
 */

const OPEN = OPEN_REFERRAL_STATUSES as ReferralStatus[];
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function generateReferralNumber(): string {
  const chars = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]);
  return `RF-${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}

export const referralInclude = {
  consultation: { select: { doctor: { select: { fullName: true } } } },
  destinationFacility: { select: { publicId: true } },
} satisfies Prisma.ChpsReferralInclude;

type ReferralRow = Prisma.ChpsReferralGetPayload<{ include: typeof referralInclude }>;

/** The user ids a set of referrals names, so their staff names can be read at once. */
export function referralActorIds(rows: ReferralRow[]): string[] {
  return rows.flatMap((row) =>
    [row.issuedByUserId, row.acknowledgedByUserId, row.feedbackByUserId].filter(
      (id): id is string => Boolean(id),
    ),
  );
}

export function toReferralView(row: ReferralRow, names: Map<string, string>): ReferralView {
  const name = (id: string | null) => (id ? (names.get(id) ?? 'Former staff member') : '');
  return {
    publicId: row.publicId,
    status: row.status,
    urgency: row.urgency,
    destination: {
      name: row.destinationName,
      department: row.destinationDepartment,
      facilityPublicId: row.destinationFacility?.publicId ?? null,
    },
    reason: decryptField(row.reasonEnc),
    clinicalSummary: decryptNullable(row.clinicalSummaryEnc),
    transport: decryptNullable(row.transportEnc),
    issuedAt: row.issuedAt.toISOString(),
    issuedBy: name(row.issuedByUserId),
    doctorName: row.consultation?.doctor?.fullName ?? null,
    acknowledged:
      row.acknowledgedAt && row.acknowledgedVia
        ? {
            at: row.acknowledgedAt.toISOString(),
            by: name(row.acknowledgedByUserId),
            via: row.acknowledgedVia,
            contact: row.acknowledgedContact,
          }
        : null,
    outcomeAt: row.outcomeAt?.toISOString() ?? null,
    feedback:
      row.feedbackEnc && row.feedbackAt
        ? {
            text: decryptField(row.feedbackEnc),
            at: row.feedbackAt.toISOString(),
            by: name(row.feedbackByUserId),
          }
        : null,
    cancelled:
      row.cancelledAt && row.cancelReason
        ? { at: row.cancelledAt.toISOString(), reason: row.cancelReason }
        : null,
  };
}

async function viewOf(id: string, db: Db): Promise<ReferralView> {
  const row = await db.chpsReferral.findUniqueOrThrow({ where: { id }, include: referralInclude });
  const members = await db.facilityUser.findMany({
    where: { userId: { in: referralActorIds([row]) } },
    select: { userId: true, fullName: true },
  });
  return toReferralView(row, new Map(members.map((m) => [m.userId, m.fullName])));
}

async function audit(
  ctx: StaffContext,
  action: (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS],
  referralId: string,
  metadata: Record<string, unknown>,
  db: Db,
) {
  await recordAudit(
    {
      action,
      actorType: 'FACILITY',
      actorId: ctx.userId,
      entityType: 'chps_referral',
      entityId: referralId,
      correlationId: ctx.correlationId,
      metadata,
    },
    db,
  );
}

/** Facilities a patient may be sent to: any active facility but this one. */
export async function listDestinations(
  ctx: StaffContext,
  db: Db = getPrisma(),
): Promise<ReferralDestination[]> {
  const rows = await db.facility.findMany({
    where: { status: 'ACTIVE', NOT: { id: ctx.facilityId } },
    orderBy: [{ type: 'asc' }, { name: 'asc' }],
    take: 500,
    select: { publicId: true, name: true, type: true, district: { select: { name: true } } },
  });
  return rows.map((row) => ({
    publicId: row.publicId,
    name: row.name,
    type: row.type,
    district: row.district.name,
  }));
}

export async function createReferral(
  ctx: StaffContext,
  visitPublicId: string,
  input: ReferralCreate,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<ReferralView> {
  const visit = await db.patientVisit.findUnique({ where: { publicId: visitPublicId } });
  if (!visit || visit.facilityId !== ctx.facilityId) throw errors.notFound('Visit not found.');
  if (!(OPEN_VISIT_STATUSES as string[]).includes(visit.status)) {
    throw errors.businessRule('This visit has ended. Open a new visit to refer the patient.');
  }

  let destinationFacilityId: string | null = null;
  let destinationName = input.destinationName ?? null;
  if (input.destinationFacilityPublicId) {
    const destination = await db.facility.findUnique({
      where: { publicId: input.destinationFacilityPublicId },
    });
    if (!destination || destination.status !== 'ACTIVE' || destination.id === ctx.facilityId) {
      throw errors.validation(
        [{ field: 'destinationFacilityPublicId', issue: 'Choose a facility from the list.' }],
        'Choose a facility from the list.',
      );
    }
    destinationFacilityId = destination.id;
    destinationName = destination.name;
  }

  // The doctor whose advice this acts on: the visit's completed consultation.
  const consultation = await db.consultation.findFirst({
    where: { visitId: visit.id, state: 'COMPLETED' },
    orderBy: { completedAt: 'desc' },
    select: { id: true },
  });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const referral = await db.chpsReferral.create({
        data: {
          publicId: generateReferralNumber(),
          facilityId: ctx.facilityId,
          patientId: visit.patientId,
          visitId: visit.id,
          consultationId: consultation?.id ?? null,
          destinationFacilityId,
          destinationName: destinationName!,
          destinationDepartment: input.destinationDepartment ?? null,
          urgency: input.urgency,
          reasonEnc: encryptField(input.reason),
          clinicalSummaryEnc: encryptNullable(input.clinicalSummary),
          transportEnc: encryptNullable(input.transport),
          issuedByUserId: ctx.userId,
          issuedAt: clock.now(),
        },
      });
      await audit(
        ctx,
        AUDIT_ACTIONS.REFERRAL_ISSUED,
        referral.id,
        {
          urgency: input.urgency,
          fromRegistry: Boolean(destinationFacilityId),
        },
        db,
      );
      return viewOf(referral.id, db);
    } catch (error) {
      if (isUniqueConstraintError(error, 'publicId')) continue;
      throw error;
    }
  }
  throw errors.internal('Could not allocate a referral number.');
}

async function findReferral(ctx: StaffContext, publicId: string, db: Db) {
  const referral = await db.chpsReferral.findUnique({ where: { publicId } });
  if (!referral || referral.facilityId !== ctx.facilityId) {
    throw errors.notFound('Referral not found.');
  }
  return referral;
}

/** The receiving facility says it expects the patient. */
export async function acknowledgeReferral(
  ctx: StaffContext,
  publicId: string,
  input: { via: 'PHONE' | 'IN_PERSON' | 'OTHER'; contact?: string | null },
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<ReferralView> {
  const referral = await findReferral(ctx, publicId, db);
  if (referral.status !== 'ISSUED') {
    throw errors.businessRule('Only a referral not yet confirmed can be acknowledged.');
  }
  await db.chpsReferral.update({
    where: { id: referral.id },
    data: {
      status: 'ACKNOWLEDGED',
      acknowledgedAt: clock.now(),
      acknowledgedByUserId: ctx.userId,
      acknowledgedVia: input.via,
      acknowledgedContact: input.contact ?? null,
    },
  });
  await audit(ctx, AUDIT_ACTIONS.REFERRAL_ACKNOWLEDGED, referral.id, { via: input.via }, db);
  return viewOf(referral.id, db);
}

/** Whether the patient was seen there, as the receiving facility reported it. */
export async function recordReferralOutcome(
  ctx: StaffContext,
  publicId: string,
  input: {
    outcome: 'ATTENDED' | 'DID_NOT_ARRIVE';
    via: 'PHONE' | 'IN_PERSON' | 'OTHER';
    feedback?: string | null;
  },
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<ReferralView> {
  const referral = await findReferral(ctx, publicId, db);
  if (!OPEN.includes(referral.status)) {
    throw errors.businessRule('This referral already has an outcome.');
  }
  const now = clock.now();
  await db.chpsReferral.update({
    where: { id: referral.id },
    data: {
      status: input.outcome,
      outcomeAt: now,
      outcomeByUserId: ctx.userId,
      ...(input.feedback
        ? {
            feedbackEnc: encryptField(input.feedback),
            feedbackAt: now,
            feedbackByUserId: ctx.userId,
          }
        : {}),
    },
  });
  await audit(
    ctx,
    AUDIT_ACTIONS.REFERRAL_OUTCOME_RECORDED,
    referral.id,
    {
      outcome: input.outcome,
      via: input.via,
      hasFeedback: Boolean(input.feedback),
    },
    db,
  );
  return viewOf(referral.id, db);
}

/**
 * What the receiving facility said about the patient. Replaces any earlier
 * feedback; the audit log keeps that it changed and who changed it.
 */
export async function recordReferralFeedback(
  ctx: StaffContext,
  publicId: string,
  feedback: string,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<ReferralView> {
  const referral = await findReferral(ctx, publicId, db);
  if (referral.status === 'CANCELLED') {
    throw errors.businessRule('This referral was cancelled.');
  }
  await db.chpsReferral.update({
    where: { id: referral.id },
    data: {
      feedbackEnc: encryptField(feedback),
      feedbackAt: clock.now(),
      feedbackByUserId: ctx.userId,
    },
  });
  await audit(
    ctx,
    AUDIT_ACTIONS.REFERRAL_FEEDBACK_RECORDED,
    referral.id,
    {
      replaced: referral.feedbackEnc !== null,
    },
    db,
  );
  return viewOf(referral.id, db);
}

export async function cancelReferral(
  ctx: StaffContext,
  publicId: string,
  reason: string,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<ReferralView> {
  const referral = await findReferral(ctx, publicId, db);
  if (!OPEN.includes(referral.status)) {
    throw errors.businessRule('This referral already has an outcome and cannot be cancelled.');
  }
  await db.chpsReferral.update({
    where: { id: referral.id },
    data: { status: 'CANCELLED', cancelledAt: clock.now(), cancelReason: reason },
  });
  await audit(ctx, AUDIT_ACTIONS.REFERRAL_CANCELLED, referral.id, {}, db);
  return viewOf(referral.id, db);
}

/** The facility's referral register, newest first. */
export async function listReferrals(
  ctx: StaffContext,
  filters: { status?: ReferralStatus; open?: boolean; from?: string; to?: string },
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<ReferralRegisterRow[]> {
  const issuedAt: Prisma.DateTimeFilter = {};
  if (filters.from) issuedAt.gte = new Date(`${filters.from}T00:00:00Z`);
  if (filters.to)
    issuedAt.lt = new Date(new Date(`${filters.to}T00:00:00Z`).getTime() + 86_400_000);

  const rows = await db.chpsReferral.findMany({
    where: {
      facilityId: ctx.facilityId,
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.open ? { status: { in: OPEN } } : {}),
      ...(filters.from || filters.to ? { issuedAt } : {}),
    },
    orderBy: { issuedAt: 'desc' },
    take: 500,
    include: { patient: { select: { patientNumber: true, fullNameEnc: true } } },
  });

  const today = startOfDay(clock.now()).getTime();
  return rows.map((row) => ({
    publicId: row.publicId,
    status: row.status,
    urgency: row.urgency,
    destinationName: row.destinationName,
    issuedAt: row.issuedAt.toISOString(),
    daysOutstanding: OPEN.includes(row.status)
      ? Math.max(0, Math.floor((today - startOfDay(row.issuedAt).getTime()) / 86_400_000))
      : null,
    patient: {
      patientNumber: row.patient.patientNumber,
      fullName: decryptField(row.patient.fullNameEnc),
    },
  }));
}

/** Whether a visit has a referral that stands, for closing it as REFERRED. */
export async function visitHasReferral(visitId: string, db: Db): Promise<boolean> {
  return (await db.chpsReferral.count({ where: { visitId, status: { not: 'CANCELLED' } } })) > 0;
}
