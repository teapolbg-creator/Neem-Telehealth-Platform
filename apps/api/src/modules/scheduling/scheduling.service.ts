import type { PrismaClient } from '@prisma/client';
import { notify } from '../notification/notification.service.ts';
import { getPrisma, isUniqueConstraintError, type Db } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit.service.ts';
import { getIntSetting } from '../settings/settings.service.ts';
import { SETTING_KEYS } from '../settings/settings.defaults.ts';
import {
  checkServiceHours,
  formatHours,
  isoWeekOf,
  shiftDurationMinutes,
  shiftsOverlap,
} from '../../domain/service-hours.ts';

/**
 * Shift scheduling and the weekly service-hours ceiling (spec §25).
 *
 * The specification is explicit: "The system must technically prevent
 * scheduling beyond 40 hours/week." That means the check cannot live in the
 * admin UI, and it cannot be a read-then-write that two concurrent requests
 * can both pass.
 *
 * The enforcement below runs inside a single transaction and takes a row lock
 * on the doctor's weekly counter before reading it, so two admins assigning
 * shifts at the same moment serialise rather than racing.
 */

export interface AssignShiftInput {
  doctorPublicId: string;
  shiftCode: string;
  serviceDate: string;
}

export interface AssignShiftResult {
  id: string;
  serviceDate: string;
  shift: { code: string; label: string; startsAt: string; endsAt: string };
  status: string;
  minutesPlanned: number;
  weeklyMinutesScheduled: number;
  weeklyLimitMinutes: number;
}

export async function assignShift(
  input: AssignShiftInput,
  context: { adminId: string; correlationId?: string },
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<AssignShiftResult> {
  const doctor = await db.doctor.findUnique({
    where: { publicId: input.doctorPublicId },
    select: { id: true, status: true, fullName: true },
  });
  if (!doctor) throw errors.notFound('Doctor not found.');

  // Scheduling an unapproved doctor would create a shift they can never work.
  if (doctor.status !== 'ACTIVE' && doctor.status !== 'APPROVED') {
    throw errors.businessRule(
      `Shifts can only be assigned to approved or active doctors. This doctor is ${doctor.status}.`,
    );
  }

  const shift = await db.shiftDefinition.findUnique({ where: { code: input.shiftCode } });
  if (!shift) throw errors.notFound('That shift does not exist.');
  if (!shift.isActive) {
    throw errors.businessRule(`The ${shift.label} shift is not currently in operation.`);
  }

  const serviceDate = new Date(`${input.serviceDate}T00:00:00.000Z`);
  if (Number.isNaN(serviceDate.getTime())) {
    throw errors.validation([{ field: 'serviceDate', issue: 'Invalid date' }]);
  }

  const minutesPlanned = shiftDurationMinutes(shift.startsAt, shift.endsAt);
  const { isoYear, isoWeek } = isoWeekOf(serviceDate);
  const maxHours = await getIntSetting(SETTING_KEYS.DOCTOR_MAX_HOURS_PER_WEEK, db);

  try {
    const result = await db.$transaction(async (tx) => {
      // Serialise concurrent assignments for this doctor and week. Without
      // this, two requests could both read 36h, both add 6h, and land at 48h.
      /*
       * PostgreSQL placeholders and quoted identifiers.
       *
       * `$1` rather than `?`, and every camel-cased column in double quotes:
       * Postgres folds an unquoted identifier to lower case, so `doctorId`
       * would look for a column named `doctorid`, which does not exist
       * (decision D43).
       */
      await tx.$queryRawUnsafe(
        `SELECT id FROM doctor_service_hours
         WHERE "doctorId" = $1 AND "isoYear" = $2 AND "isoWeek" = $3
         FOR UPDATE`,
        doctor.id,
        isoYear,
        isoWeek,
      );

      const counter = await tx.doctorServiceHours.findUnique({
        where: { doctorId_isoYear_isoWeek: { doctorId: doctor.id, isoYear, isoWeek } },
      });
      const currentMinutes = counter?.minutesScheduled ?? 0;

      const check = checkServiceHours({
        currentMinutes,
        requestedMinutes: minutesPlanned,
        maxHoursPerWeek: maxHours,
      });

      if (!check.allowed) {
        throw errors.businessRule(
          `This would put ${doctor.fullName} at ${formatHours(check.resultingMinutes)} in ISO week ${isoWeek}, ` +
            `over the ${maxHours}-hour weekly limit. ${formatHours(check.remainingMinutes)} remaining.`,
          {
            doctorId: doctor.id,
            isoYear,
            isoWeek,
            currentMinutes,
            requestedMinutes: minutesPlanned,
            limitMinutes: check.limitMinutes,
          },
        );
      }

      // A doctor under the weekly ceiling can still be double-booked on one day.
      const sameDay = await tx.doctorShiftAssignment.findMany({
        where: {
          doctorId: doctor.id,
          serviceDate,
          status: { in: ['ASSIGNED', 'CONFIRMED'] },
        },
        include: { shiftDefinition: true },
      });

      const clash = sameDay.find((existing) =>
        shiftsOverlap(
          { startsAt: shift.startsAt, endsAt: shift.endsAt },
          { startsAt: existing.shiftDefinition.startsAt, endsAt: existing.shiftDefinition.endsAt },
        ),
      );
      if (clash) {
        throw errors.conflict(
          `${doctor.fullName} is already scheduled for the ${clash.shiftDefinition.label} shift that day.`,
        );
      }

      const assignment = await tx.doctorShiftAssignment.create({
        data: {
          doctorId: doctor.id,
          shiftDefinitionId: shift.id,
          serviceDate,
          status: 'ASSIGNED',
          assignedByAdminId: context.adminId,
          minutesPlanned,
        },
      });

      await tx.doctorServiceHours.upsert({
        where: { doctorId_isoYear_isoWeek: { doctorId: doctor.id, isoYear, isoWeek } },
        update: { minutesScheduled: { increment: minutesPlanned } },
        create: { doctorId: doctor.id, isoYear, isoWeek, minutesScheduled: minutesPlanned },
      });

      return {
        assignment,
        weeklyMinutesScheduled: check.resultingMinutes,
        limitMinutes: check.limitMinutes,
      };
    });

    await recordAudit(
      {
        action: AUDIT_ACTIONS.SHIFT_ASSIGNED,
        actorType: 'ADMIN',
        actorId: context.adminId,
        entityType: 'doctor_shift_assignment',
        entityId: result.assignment.id,
        correlationId: context.correlationId,
        metadata: { shiftCode: shift.code, isoYear, isoWeek, minutesPlanned },
      },
      db,
    );

    /**
     * An assigned shift is not a confirmed one — the doctor has to accept it,
     * and until they do, nobody is on shift. Telling them is therefore not a
     * courtesy: an unconfirmed shift is a gap in cover that neither side knows
     * about, and the doctor would otherwise find out only by opening the app.
     */
    void notify({
      templateCode: 'doctor.shift.assigned',
      recipient: { type: 'DOCTOR', doctorId: doctor.id },
      variables: { shiftLabel: shift.label, serviceDate: input.serviceDate },
      correlationId: context.correlationId,
    });

    return {
      id: result.assignment.id,
      serviceDate: input.serviceDate,
      shift: {
        code: shift.code,
        label: shift.label,
        startsAt: shift.startsAt,
        endsAt: shift.endsAt,
      },
      status: result.assignment.status,
      minutesPlanned,
      weeklyMinutesScheduled: result.weeklyMinutesScheduled,
      weeklyLimitMinutes: result.limitMinutes,
    };
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw errors.conflict('That doctor is already assigned to this shift on this date.');
    }
    // A blocked assignment is an operationally interesting event: it means
    // demand is outrunning the approved workforce.
    if (error instanceof Error && error.message.includes('weekly limit')) {
      await recordAudit(
        {
          action: AUDIT_ACTIONS.SHIFT_LIMIT_BLOCKED,
          actorType: 'ADMIN',
          actorId: context.adminId,
          entityType: 'doctor',
          entityId: doctor.id,
          outcome: 'DENIED',
          correlationId: context.correlationId,
          metadata: { isoYear, isoWeek, requestedMinutes: minutesPlanned },
        },
        db,
      );
    }
    throw error;
  }
}

/** Doctors confirm the shifts an admin has assigned them (spec §25). */
export async function confirmShift(
  assignmentId: string,
  doctorId: string,
  context: { correlationId?: string },
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<void> {
  const assignment = await db.doctorShiftAssignment.findUnique({ where: { id: assignmentId } });

  if (!assignment || assignment.doctorId !== doctorId) {
    throw errors.notFound('Shift assignment not found.');
  }
  if (assignment.status !== 'ASSIGNED') {
    throw errors.invalidStateTransition(assignment.status, 'CONFIRMED', 'shift assignment');
  }

  await db.doctorShiftAssignment.update({
    where: { id: assignmentId },
    data: { status: 'CONFIRMED', confirmedAt: clock.now() },
  });

  await recordAudit(
    {
      action: AUDIT_ACTIONS.SHIFT_CONFIRMED,
      actorType: 'DOCTOR',
      actorId: doctorId,
      entityType: 'doctor_shift_assignment',
      entityId: assignmentId,
      correlationId: context.correlationId,
    },
    db,
  );
}

/** Cancelling releases the hours back into the doctor's weekly budget. */
export async function cancelShift(
  assignmentId: string,
  context: {
    actorType: 'ADMIN' | 'DOCTOR';
    actorId: string;
    reason?: string;
    correlationId?: string;
  },
  db: PrismaClient = getPrisma(),
): Promise<void> {
  const assignment = await db.doctorShiftAssignment.findUnique({ where: { id: assignmentId } });
  if (!assignment) throw errors.notFound('Shift assignment not found.');

  if (assignment.status === 'CANCELLED') {
    throw errors.conflict('That shift is already cancelled.');
  }

  const { isoYear, isoWeek } = isoWeekOf(assignment.serviceDate);

  await db.$transaction(async (tx) => {
    await tx.doctorShiftAssignment.update({
      where: { id: assignmentId },
      data: { status: 'CANCELLED' },
    });
    await tx.doctorServiceHours.updateMany({
      where: { doctorId: assignment.doctorId, isoYear, isoWeek },
      data: { minutesScheduled: { decrement: assignment.minutesPlanned } },
    });
  });

  await recordAudit(
    {
      action: AUDIT_ACTIONS.SHIFT_CANCELLED,
      actorType: context.actorType,
      actorId: context.actorId,
      entityType: 'doctor_shift_assignment',
      entityId: assignmentId,
      correlationId: context.correlationId,
      metadata: { reason: context.reason, minutesReleased: assignment.minutesPlanned },
    },
    db,
  );
}

export async function getServiceHours(
  doctorId: string,
  reference: Date,
  db: Db = getPrisma(),
): Promise<{
  isoYear: number;
  isoWeek: number;
  minutesScheduled: number;
  minutesServed: number;
  limitMinutes: number;
  remainingMinutes: number;
}> {
  const { isoYear, isoWeek } = isoWeekOf(reference);
  const maxHours = await getIntSetting(SETTING_KEYS.DOCTOR_MAX_HOURS_PER_WEEK, db);
  const limitMinutes = maxHours * 60;

  const counter = await db.doctorServiceHours.findUnique({
    where: { doctorId_isoYear_isoWeek: { doctorId, isoYear, isoWeek } },
  });

  const minutesScheduled = counter?.minutesScheduled ?? 0;

  return {
    isoYear,
    isoWeek,
    minutesScheduled,
    minutesServed: counter?.minutesServed ?? 0,
    limitMinutes,
    remainingMinutes: Math.max(0, limitMinutes - minutesScheduled),
  };
}

export async function listShiftsForDoctor(
  doctorId: string,
  range: { from: Date; to: Date },
  db: Db = getPrisma(),
) {
  return db.doctorShiftAssignment.findMany({
    where: { doctorId, serviceDate: { gte: range.from, lte: range.to } },
    include: { shiftDefinition: true },
    orderBy: [{ serviceDate: 'asc' }],
  });
}

export async function listShiftDefinitions(db: Db = getPrisma()) {
  return db.shiftDefinition.findMany({ orderBy: { startsAt: 'asc' } });
}
