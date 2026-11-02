import { tellFacility } from './referral.service.ts';
import type { Prisma } from '@prisma/client';
import { addDays, startOfDay } from 'date-fns';
import {
  OPEN_VISIT_STATUSES,
  type FollowUpCreate,
  type FollowUpListRow,
  type FollowUpView,
} from '@neem/contracts';
import { getPrisma, type Db } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import {
  decryptField,
  decryptNullable,
  encryptField,
  encryptNullable,
  generatePublicId,
} from '../../lib/crypto.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit.service.ts';
import type { StaffContext } from './patient.service.ts';

/**
 * Follow-ups (CHPS slice 2b, D81).
 *
 * The CHO sets a date from what the doctor advised or what a receiving
 * facility said. A follow-up past its date is shown as overdue; it becomes
 * MISSED only when the CHO records that it was, because a patient who has not
 * come back yet may still come, and a list that marks people as lost by
 * itself stops being looked at.
 */

export const followUpInclude = {
  referral: { select: { publicId: true } },
  resolvedVisit: { select: { publicId: true } },
} satisfies Prisma.FollowUpInclude;

type FollowUpRow = Prisma.FollowUpGetPayload<{ include: typeof followUpInclude }>;

const dateOnly = (date: Date) => date.toISOString().slice(0, 10);

export function followUpActorIds(rows: FollowUpRow[]): string[] {
  return rows.flatMap((row) =>
    [row.createdByUserId, row.resolvedByUserId].filter((id): id is string => Boolean(id)),
  );
}

export function toFollowUpView(
  row: FollowUpRow,
  names: Map<string, string>,
  now: Date,
): FollowUpView {
  const name = (id: string | null) => (id ? (names.get(id) ?? 'Former staff member') : '');
  return {
    publicId: row.publicId,
    status: row.status,
    dueDate: dateOnly(row.dueDate),
    overdue: row.status === 'DUE' && row.dueDate < startOfDay(now),
    instructions: decryptField(row.instructionsEnc),
    createdAt: row.createdAt.toISOString(),
    createdBy: name(row.createdByUserId),
    referralPublicId: row.referral?.publicId ?? null,
    resolved: row.resolvedAt
      ? {
          at: row.resolvedAt.toISOString(),
          by: name(row.resolvedByUserId),
          note: decryptNullable(row.resolutionNoteEnc),
          visitPublicId: row.resolvedVisit?.publicId ?? null,
        }
      : null,
  };
}

async function viewOf(id: string, db: Db, clock: Clock): Promise<FollowUpView> {
  const row = await db.followUp.findUniqueOrThrow({ where: { id }, include: followUpInclude });
  const members = await db.facilityUser.findMany({
    where: { userId: { in: followUpActorIds([row]) } },
    select: { userId: true, fullName: true },
  });
  return toFollowUpView(row, new Map(members.map((m) => [m.userId, m.fullName])), clock.now());
}

async function audit(
  ctx: StaffContext,
  action: (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS],
  id: string,
  metadata: Record<string, unknown>,
  db: Db,
) {
  await recordAudit(
    {
      action,
      actorType: 'FACILITY',
      actorId: ctx.userId,
      entityType: 'follow_up',
      entityId: id,
      correlationId: ctx.correlationId,
      metadata,
    },
    db,
  );
}

export async function createFollowUp(
  ctx: StaffContext,
  visitPublicId: string,
  input: FollowUpCreate,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<FollowUpView> {
  const visit = await db.patientVisit.findUnique({ where: { publicId: visitPublicId } });
  if (!visit || visit.facilityId !== ctx.facilityId) throw errors.notFound('Visit not found.');

  const dueDate = new Date(`${input.dueDate}T00:00:00Z`);
  if (dueDate < startOfDay(clock.now())) {
    throw errors.validation(
      [{ field: 'dueDate', issue: 'A follow-up cannot be due in the past.' }],
      'A follow-up cannot be due in the past.',
    );
  }

  let referralId: string | null = null;
  if (input.referralPublicId) {
    const referral = await db.chpsReferral.findUnique({
      where: { publicId: input.referralPublicId },
    });
    if (
      !referral ||
      referral.facilityId !== ctx.facilityId ||
      referral.patientId !== visit.patientId
    ) {
      throw errors.notFound('Referral not found.');
    }
    referralId = referral.id;
  }

  const followUp = await db.followUp.create({
    data: {
      publicId: generatePublicId('fup'),
      facilityId: ctx.facilityId,
      patientId: visit.patientId,
      visitId: visit.id,
      referralId,
      dueDate,
      instructionsEnc: encryptField(input.instructions),
      createdByUserId: ctx.userId,
    },
  });
  await tellFacility(ctx.facilityId, visit.patientId, 'FOLLOW_UP_SET', db);
  await audit(
    ctx,
    AUDIT_ACTIONS.FOLLOW_UP_SET,
    followUp.id,
    {
      dueDate: input.dueDate,
      fromReferral: Boolean(referralId),
    },
    db,
  );
  return viewOf(followUp.id, db, clock);
}

async function findDue(ctx: StaffContext, publicId: string, db: Db) {
  const followUp = await db.followUp.findUnique({ where: { publicId } });
  if (!followUp || followUp.facilityId !== ctx.facilityId) {
    throw errors.notFound('Follow-up not found.');
  }
  if (followUp.status !== 'DUE') {
    throw errors.businessRule('This follow-up has already been resolved.');
  }
  return followUp;
}

/**
 * The patient came back. Linked to the visit they were seen at: the one
 * named, or their open visit, or none if they were seen some other way.
 */
export async function completeFollowUp(
  ctx: StaffContext,
  publicId: string,
  input: { note?: string | null; visitPublicId?: string | null },
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<FollowUpView> {
  const followUp = await findDue(ctx, publicId, db);

  const visit = input.visitPublicId
    ? await db.patientVisit.findUnique({ where: { publicId: input.visitPublicId } })
    : await db.patientVisit.findFirst({
        where: {
          patientId: followUp.patientId,
          status: { in: [...OPEN_VISIT_STATUSES] },
          NOT: { id: followUp.visitId },
        },
        orderBy: { arrivedAt: 'desc' },
      });
  if (input.visitPublicId && (!visit || visit.patientId !== followUp.patientId)) {
    throw errors.notFound('Visit not found.');
  }

  await db.followUp.update({
    where: { id: followUp.id },
    data: {
      status: 'DONE',
      resolvedAt: clock.now(),
      resolvedByUserId: ctx.userId,
      resolutionNoteEnc: encryptNullable(input.note),
      resolvedVisitId: visit?.id ?? null,
    },
  });
  await audit(ctx, AUDIT_ACTIONS.FOLLOW_UP_DONE, followUp.id, { linkedVisit: Boolean(visit) }, db);
  return viewOf(followUp.id, db, clock);
}

export async function markFollowUpMissed(
  ctx: StaffContext,
  publicId: string,
  note: string,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<FollowUpView> {
  const followUp = await findDue(ctx, publicId, db);
  await db.followUp.update({
    where: { id: followUp.id },
    data: {
      status: 'MISSED',
      resolvedAt: clock.now(),
      resolvedByUserId: ctx.userId,
      resolutionNoteEnc: encryptField(note),
    },
  });
  await audit(ctx, AUDIT_ACTIONS.FOLLOW_UP_MISSED, followUp.id, {}, db);
  return viewOf(followUp.id, db, clock);
}

export async function cancelFollowUp(
  ctx: StaffContext,
  publicId: string,
  reason: string,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<FollowUpView> {
  const followUp = await findDue(ctx, publicId, db);
  await db.followUp.update({
    where: { id: followUp.id },
    data: {
      status: 'CANCELLED',
      resolvedAt: clock.now(),
      resolvedByUserId: ctx.userId,
      resolutionNoteEnc: encryptField(reason),
    },
  });
  await audit(ctx, AUDIT_ACTIONS.FOLLOW_UP_CANCELLED, followUp.id, {}, db);
  return viewOf(followUp.id, db, clock);
}

/**
 * The facility's follow-up list. "due" is everything due today or before
 * that is still unresolved, oldest first, so the longest-waiting patient is
 * at the top; "upcoming" is the next fourteen days.
 */
export async function listFollowUps(
  ctx: StaffContext,
  view: 'due' | 'upcoming' | 'all',
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<FollowUpListRow[]> {
  const today = startOfDay(clock.now());
  const where: Prisma.FollowUpWhereInput = { facilityId: ctx.facilityId };
  if (view === 'due') {
    where.status = 'DUE';
    where.dueDate = { lte: today };
  } else if (view === 'upcoming') {
    where.status = 'DUE';
    where.dueDate = { gt: today, lte: addDays(today, 14) };
  }

  const rows = await db.followUp.findMany({
    where,
    orderBy: view === 'all' ? { dueDate: 'desc' } : { dueDate: 'asc' },
    take: 500,
    include: {
      patient: {
        select: {
          id: true,
          patientNumber: true,
          fullNameEnc: true,
          phoneEnc: true,
          community: true,
        },
      },
    },
  });

  const open = new Set(
    (
      await db.patientVisit.findMany({
        where: {
          patientId: { in: rows.map((row) => row.patientId) },
          status: { in: [...OPEN_VISIT_STATUSES] },
        },
        select: { patientId: true },
      })
    ).map((visit) => visit.patientId),
  );

  return rows.map((row) => ({
    publicId: row.publicId,
    status: row.status,
    dueDate: dateOnly(row.dueDate),
    overdue: row.status === 'DUE' && row.dueDate < today,
    instructions: decryptField(row.instructionsEnc),
    patient: {
      patientNumber: row.patient.patientNumber,
      fullName: decryptField(row.patient.fullNameEnc),
      phone: decryptNullable(row.patient.phoneEnc),
      community: row.patient.community,
      hasOpenVisit: open.has(row.patient.id),
    },
  }));
}

/** Follow-ups due today or overdue, for the day's counts. */
export async function countFollowUpsDue(facilityId: string, db: Db, clock: Clock): Promise<number> {
  return db.followUp.count({
    where: { facilityId, status: 'DUE', dueDate: { lte: startOfDay(clock.now()) } },
  });
}
