import type { ConsultationState, ReferralStatus, ReferralUrgency } from '@prisma/client';
import { addDays, differenceInCalendarDays } from 'date-fns';
import {
  REFERRAL_STATUSES,
  REFERRAL_URGENCIES,
  REPORT_MAX_DAYS,
  TRIAGE_CATEGORIES,
  type FacilityReport,
  type ReportDay,
  type ReportTotals,
} from '@neem/contracts';
import { getPrisma, type Db } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { decryptField } from '../../lib/crypto.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
import { isTerminal } from '../../domain/consultation-state.ts';
import type { StaffContext } from './patient.service.ts';

/**
 * A CHPS facility's report for a date range (slice 2c, brief §A8, D82).
 *
 * Counted, never estimated, from the facility's own records. Days are UTC
 * days, which in Ghana are local days. A record belongs to the day it
 * started: a visit to the day it arrived, a consultation to the day it was
 * requested, a referral to the day it was issued, a follow-up to the day it
 * was due.
 */

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  return Math.round(value * 10) / 10;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round((values.reduce((sum, v) => sum + v, 0) / values.length) * 10) / 10;
}

const dateOnly = (date: Date) => date.toISOString().slice(0, 10);

/** The range as instants, refused beyond REPORT_MAX_DAYS. */
export function reportPeriod(range: { from: string; to: string }) {
  const start = new Date(`${range.from}T00:00:00Z`);
  const lastDay = new Date(`${range.to}T00:00:00Z`);
  const end = addDays(lastDay, 1);
  const dayCount = differenceInCalendarDays(end, start);
  if (dayCount > REPORT_MAX_DAYS) {
    throw errors.validation(
      [{ field: 'to', issue: `A report covers at most ${REPORT_MAX_DAYS} days.` }],
      `A report covers at most ${REPORT_MAX_DAYS} days.`,
    );
  }
  return { start, dayCount, period: { gte: start, lt: end } };
}

export type ReportPeriod = ReturnType<typeof reportPeriod>;

/**
 * Every record a report counts, for one facility or many. Each row carries
 * its facility so a district report can split the same rows by facility
 * instead of querying each one again.
 */
export async function reportRecords(facilityIds: string[], period: ReportPeriod['period'], db: Db) {
  const facilityId = { in: facilityIds };
  const [visits, newPatients, consultations, referrals, followUps] = await Promise.all([
    db.patientVisit.findMany({
      where: { facilityId, arrivedAt: period },
      select: {
        facilityId: true,
        patientId: true,
        arrivedAt: true,
        status: true,
        escalatedAt: true,
        presentingComplaintEnc: true,
        triages: { orderBy: { recordedAt: 'desc' }, take: 1, select: { category: true } },
      },
      orderBy: { arrivedAt: 'desc' },
    }),
    db.patient.findMany({
      where: { facilityId, createdAt: period },
      select: { facilityId: true, createdAt: true },
    }),
    db.consultation.findMany({
      where: { facilityId, channel: 'CHPS', createdAt: period },
      select: {
        facilityId: true,
        createdAt: true,
        state: true,
        durationSeconds: true,
        doctor: { select: { fullName: true } },
        stateEvents: {
          where: { toState: { in: ['DOCTOR_ACCEPTED', 'CANCELLED', 'EXPIRED'] }, accepted: true },
          orderBy: { occurredAt: 'asc' },
          select: { toState: true, occurredAt: true },
        },
      },
    }),
    db.chpsReferral.findMany({
      where: { facilityId, issuedAt: period },
      select: {
        facilityId: true,
        issuedAt: true,
        urgency: true,
        status: true,
        destinationName: true,
      },
    }),
    db.followUp.findMany({
      where: { facilityId, dueDate: period },
      select: { facilityId: true, status: true },
    }),
  ]);
  return { visits, newPatients, consultations, referrals, followUps };
}

export type ReportRecords = Awaited<ReturnType<typeof reportRecords>>;

/** The records narrowed to one facility, for its line in a district comparison. */
export function recordsFor(records: ReportRecords, facilityId: string): ReportRecords {
  const mine = <T extends { facilityId: string | null }>(rows: T[]) =>
    rows.filter((row) => row.facilityId === facilityId);
  return {
    visits: mine(records.visits),
    newPatients: mine(records.newPatients),
    consultations: mine(records.consultations),
    referrals: mine(records.referrals),
    followUps: mine(records.followUps),
  };
}

/** Counts the records. Pure: everything it needs was fetched already. */
export function reportTotals(
  records: ReportRecords,
  { start, dayCount }: Pick<ReportPeriod, 'start' | 'dayCount'>,
): ReportTotals {
  const { visits, newPatients, consultations, referrals, followUps } = records;

  // ---- attendance -------------------------------------------------------
  const byTriage = Object.fromEntries(
    [...TRIAGE_CATEGORIES, 'NOT_TRIAGED'].map((key) => [key, 0]),
  ) as FacilityReport['attendance']['byTriage'];
  const outcomes = { CLOSED: 0, REFERRED: 0, CANCELLED: 0, OPEN: 0 };
  for (const visit of visits) {
    byTriage[visit.triages[0]?.category ?? 'NOT_TRIAGED'] += 1;
    if (visit.status === 'CLOSED' || visit.status === 'REFERRED' || visit.status === 'CANCELLED') {
      outcomes[visit.status] += 1;
    } else {
      outcomes.OPEN += 1;
    }
  }

  // ---- consultations ----------------------------------------------------
  const waits: number[] = [];
  const durations: number[] = [];
  const perDoctor = new Map<string, { completed: number; minutes: number[] }>();
  let completed = 0;
  let withdrawn = 0;
  let noDoctor = 0;
  let inProgress = 0;

  for (const consultation of consultations) {
    const accepted = consultation.stateEvents.find((event) => event.toState === 'DOCTOR_ACCEPTED');
    if (accepted) {
      waits.push((accepted.occurredAt.getTime() - consultation.createdAt.getTime()) / 60_000);
    }
    const state: ConsultationState = consultation.state;
    if (state === 'COMPLETED') {
      completed += 1;
      const name = consultation.doctor?.fullName ?? 'Doctor no longer listed';
      const doctor = perDoctor.get(name) ?? { completed: 0, minutes: [] };
      doctor.completed += 1;
      if (consultation.durationSeconds !== null) {
        durations.push(consultation.durationSeconds / 60);
        doctor.minutes.push(consultation.durationSeconds / 60);
      }
      perDoctor.set(name, doctor);
    } else if (state === 'CANCELLED') {
      withdrawn += 1;
    } else if (state === 'EXPIRED') {
      noDoctor += 1;
    } else if (!isTerminal(state)) {
      inProgress += 1;
    }
  }

  // ---- referrals --------------------------------------------------------
  const byUrgency = Object.fromEntries(REFERRAL_URGENCIES.map((key) => [key, 0])) as Record<
    ReferralUrgency,
    number
  >;
  const byStatus = Object.fromEntries(REFERRAL_STATUSES.map((key) => [key, 0])) as Record<
    ReferralStatus,
    number
  >;
  const destinations = new Map<string, number>();
  for (const referral of referrals) {
    byUrgency[referral.urgency] += 1;
    byStatus[referral.status] += 1;
    destinations.set(
      referral.destinationName,
      (destinations.get(referral.destinationName) ?? 0) + 1,
    );
  }

  // ---- by day -----------------------------------------------------------
  const days: ReportDay[] = Array.from({ length: dayCount }, (_, index) => ({
    date: dateOnly(addDays(start, index)),
    visits: 0,
    newPatients: 0,
    consultationsRequested: 0,
    consultationsCompleted: 0,
    referrals: 0,
  }));
  const dayOf = (date: Date) => days[differenceInCalendarDays(date, start)];
  for (const visit of visits) {
    const day = dayOf(visit.arrivedAt);
    if (day) day.visits += 1;
  }
  for (const patient of newPatients) {
    const day = dayOf(patient.createdAt);
    if (day) day.newPatients += 1;
  }
  for (const consultation of consultations) {
    const day = dayOf(consultation.createdAt);
    if (!day) continue;
    day.consultationsRequested += 1;
    if (consultation.state === 'COMPLETED') day.consultationsCompleted += 1;
  }
  for (const referral of referrals) {
    const day = dayOf(referral.issuedAt);
    if (day) day.referrals += 1;
  }

  return {
    attendance: {
      visits: visits.length,
      newPatients: newPatients.length,
      patientsSeen: new Set(visits.map((visit) => visit.patientId)).size,
      byTriage,
      emergencies: visits.filter((visit) => visit.escalatedAt !== null).length,
      outcomes,
    },
    consultations: {
      requested: consultations.length,
      completed,
      withdrawn,
      noDoctorAvailable: noDoctor,
      inProgress,
      waitMinutes: {
        median: median(waits),
        average: average(waits),
        longest: waits.length > 0 ? Math.round(Math.max(...waits) * 10) / 10 : null,
      },
      medianDurationMinutes: median(durations),
    },
    doctors: [...perDoctor.entries()]
      .map(([name, doctor]) => ({
        name,
        completed: doctor.completed,
        medianDurationMinutes: median(doctor.minutes),
      }))
      .sort((a, b) => b.completed - a.completed || a.name.localeCompare(b.name)),
    referrals: {
      issued: referrals.length,
      byUrgency,
      byStatus,
      destinations: [...destinations.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    },
    followUps: {
      due: followUps.length,
      done: followUps.filter((f) => f.status === 'DONE').length,
      missed: followUps.filter((f) => f.status === 'MISSED').length,
      cancelled: followUps.filter((f) => f.status === 'CANCELLED').length,
      stillDue: followUps.filter((f) => f.status === 'DUE').length,
    },
    days,
  };
}

export async function facilityReport(
  ctx: StaffContext,
  range: { from: string; to: string },
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<FacilityReport> {
  const period = reportPeriod(range);
  const [facility, records] = await Promise.all([
    db.facility.findUniqueOrThrow({
      where: { id: ctx.facilityId },
      select: { name: true, code: true },
    }),
    reportRecords([ctx.facilityId], period.period, db),
  ]);

  return {
    facility,
    from: range.from,
    to: range.to,
    generatedAt: clock.now().toISOString(),
    ...reportTotals(records, period),
    complaints: records.visits.slice(0, 300).map((visit) => ({
      date: dateOnly(visit.arrivedAt),
      text: decryptField(visit.presentingComplaintEnc),
    })),
  };
}
