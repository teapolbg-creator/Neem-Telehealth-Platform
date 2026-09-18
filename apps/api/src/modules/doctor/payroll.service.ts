import { getPrisma, type Db } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
import { getIntSetting } from '../settings/settings.service.ts';
import { SETTING_KEYS } from '../settings/settings.defaults.ts';
import { computeMonthlyCompensation } from '../../domain/compensation.ts';
import { formatHours, isoWeekOf } from '../../domain/service-hours.ts';
import { counterShareFrom } from '../payment/earnings.service.ts';

/**
 * Doctor payroll (spec §26, decision D28).
 *
 * **Neem calculates and never pays.** There is no transfer anywhere in this
 * module, no provider call, and no route that marks a salary sent. It produces
 * a figure for whoever runs payroll to act on outside the system, and that
 * boundary is the difference between a reporting feature and a payroll system.
 *
 * The arithmetic itself lives in `domain/compensation.ts` as a pure function.
 * This module's job is to gather the inputs — the doctor's contract, the
 * configured full-time figures — and to report the hours actually served
 * alongside the contracted amount, because those are different numbers and
 * conflating them is how someone gets paid for a month they did not work.
 */

export interface DoctorPayrollLine {
  doctorPublicId: string;
  fullName: string;
  employmentType: string | null;
  contractedHoursPerWeek: number | null;
  /** What the contract yields for the month, in pesewas. */
  monthlyMinor: number;
  currency: string;
  /** Fraction of a full week this doctor is contracted for. */
  fraction: number;
  isFullTime: boolean;
  /** Minutes the doctor was scheduled for, in the weeks covered. */
  minutesScheduled: number;
  /** Minutes actually served. */
  minutesServed: number;
  scheduledLabel: string;
  servedLabel: string;
  /**
   * True when served hours fall short of contracted hours for the period.
   *
   * Surfaced rather than acted on: the formula pays the contract (D28), so a
   * shortfall is something for a human to ask about, not something this
   * module silently deducts for.
   */
  shortOfContract: boolean;
  /** Unpaid fraction of a pesewa, over `fullTimeHoursPerWeek`. */
  remainderNumerator: number;
}

export interface PayrollPeriod {
  isoYear: number;
  /** Inclusive ISO week range. */
  fromIsoWeek: number;
  toIsoWeek: number;
}

export interface PayrollResult {
  /**
   * True for a period on or after the switch from salary to shares. The run is
   * then empty on purpose, and says so — a blank payroll that did not explain
   * itself would read as a fault, and somebody would go and pay salaries.
   */
  salaryEnded: boolean;
  period: PayrollPeriod;
  fullTimeMonthlyMinor: number;
  fullTimeHoursPerWeek: number;
  currency: string;
  totalMinor: number;
  lines: DoctorPayrollLine[];
}

/** The ISO week range covering the current month, which is what payroll runs on. */
export function currentPayrollPeriod(clock: Clock = systemClock): PayrollPeriod {
  const now = clock.now();
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));

  const from = isoWeekOf(first);
  const to = isoWeekOf(last);

  return {
    // Reported against the month's own year. A month whose first days fall in
    // the previous ISO year is a real case every January.
    isoYear: to.isoYear,
    fromIsoWeek: from.isoYear === to.isoYear ? from.isoWeek : 1,
    toIsoWeek: to.isoWeek,
  };
}

/** The Monday that begins an ISO week, in UTC. */
function mondayOfIsoWeek(isoYear: number, isoWeek: number): Date {
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const weekday = jan4.getUTCDay() || 7;
  const firstMonday = jan4.getTime() - (weekday - 1) * 86_400_000;
  return new Date(firstMonday + (isoWeek - 1) * 7 * 86_400_000);
}

/**
 * Whether a payroll period is still paid as salary (2026-09-18).
 *
 * A month's payroll runs from the ISO week containing its first day, so the
 * month the shares begin is exactly the one whose first week is the week
 * containing the cut-over. Comparing those two Mondays — rather than dates
 * inside the weeks — keeps the answer right when the 1st falls on a weekend
 * and its week belongs mostly to the month before.
 */
export async function salaryApplies(period: PayrollPeriod, db: Db = getPrisma()): Promise<boolean> {
  const cutover = await counterShareFrom(db);
  const cutoverWeek = isoWeekOf(cutover);

  return (
    mondayOfIsoWeek(period.isoYear, period.fromIsoWeek) <
    mondayOfIsoWeek(cutoverWeek.isoYear, cutoverWeek.isoWeek)
  );
}

/**
 * What each active doctor is owed for a period.
 *
 * A doctor with no contracted hours recorded is **omitted rather than assumed**
 * to be full-time. Guessing a contract is how a salary figure becomes fiction,
 * and the count of omissions is returned so the gap is visible instead of
 * silently reducing the total.
 */
export async function calculatePayroll(
  period: PayrollPeriod,
  db: Db = getPrisma(),
): Promise<PayrollResult & { doctorsWithoutContract: number }> {
  if (period.toIsoWeek < period.fromIsoWeek) {
    throw errors.businessRule('The period ends before it starts.');
  }

  const fullTimeMonthlyMinor = await getIntSetting(SETTING_KEYS.DOCTOR_FULL_TIME_MONTHLY_MINOR, db);
  const fullTimeHoursPerWeek = await getIntSetting(SETTING_KEYS.DOCTOR_MAX_HOURS_PER_WEEK, db);

  // From the cut-over, doctors are paid by share and nobody is owed a salary.
  if (!(await salaryApplies(period, db))) {
    return {
      salaryEnded: true,
      period,
      fullTimeMonthlyMinor,
      fullTimeHoursPerWeek,
      currency: 'GHS',
      totalMinor: 0,
      lines: [],
      doctorsWithoutContract: 0,
    };
  }

  const doctors = await db.doctor.findMany({
    where: { status: { in: ['ACTIVE', 'SUSPENDED'] } },
    select: {
      publicId: true,
      fullName: true,
      employmentType: true,
      contractedHoursPerWeek: true,
      serviceHours: {
        where: {
          isoYear: period.isoYear,
          isoWeek: { gte: period.fromIsoWeek, lte: period.toIsoWeek },
        },
        select: { minutesScheduled: true, minutesServed: true },
      },
    },
    orderBy: { fullName: 'asc' },
  });

  const lines: DoctorPayrollLine[] = [];
  let doctorsWithoutContract = 0;

  for (const doctor of doctors) {
    if (!doctor.contractedHoursPerWeek) {
      doctorsWithoutContract += 1;
      continue;
    }

    const compensation = computeMonthlyCompensation({
      fullTimeMonthlyMinor,
      fullTimeHoursPerWeek,
      contractedHoursPerWeek: doctor.contractedHoursPerWeek,
    });

    const minutesScheduled = doctor.serviceHours.reduce(
      (sum, week) => sum + week.minutesScheduled,
      0,
    );
    const minutesServed = doctor.serviceHours.reduce((sum, week) => sum + week.minutesServed, 0);

    const weeks = period.toIsoWeek - period.fromIsoWeek + 1;
    const contractedMinutes = doctor.contractedHoursPerWeek * 60 * weeks;

    lines.push({
      doctorPublicId: doctor.publicId,
      fullName: doctor.fullName,
      employmentType: doctor.employmentType,
      contractedHoursPerWeek: doctor.contractedHoursPerWeek,
      monthlyMinor: compensation.monthlyMinor,
      currency: 'GHS',
      fraction: compensation.fraction,
      isFullTime: compensation.isFullTime,
      minutesScheduled,
      minutesServed,
      scheduledLabel: formatHours(minutesScheduled),
      servedLabel: formatHours(minutesServed),
      shortOfContract: minutesServed < contractedMinutes,
      remainderNumerator: compensation.remainderNumerator,
    });
  }

  return {
    salaryEnded: false,
    period,
    fullTimeMonthlyMinor,
    fullTimeHoursPerWeek,
    currency: 'GHS',
    totalMinor: lines.reduce((sum, line) => sum + line.monthlyMinor, 0),
    lines,
    doctorsWithoutContract,
  };
}

/**
 * One doctor's own figure.
 *
 * A doctor may see what they are owed and the hours behind it. They may not
 * see anyone else's, and nothing here returns a rating or a quality score
 * (spec §24, §52).
 */
export async function doctorEarnings(
  doctorId: string,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<{
  /** How this month is paid: the contract, or a share of each consultation. */
  paidBy: 'SALARY' | 'SHARE';
  period: PayrollPeriod;
  contractedHoursPerWeek: number | null;
  employmentType: string | null;
  monthlyMinor: number | null;
  currency: string;
  scheduledLabel: string;
  servedLabel: string;
  consultationsThisPeriod: number;
}> {
  const period = currentPayrollPeriod(clock);

  const doctor = await db.doctor.findUniqueOrThrow({
    where: { id: doctorId },
    select: {
      discipline: true,
      employmentType: true,
      contractedHoursPerWeek: true,
      serviceHours: {
        where: {
          isoYear: period.isoYear,
          isoWeek: { gte: period.fromIsoWeek, lte: period.toIsoWeek },
        },
        select: { minutesScheduled: true, minutesServed: true },
      },
    },
  });

  const fullTimeMonthlyMinor = await getIntSetting(SETTING_KEYS.DOCTOR_FULL_TIME_MONTHLY_MINOR, db);
  const fullTimeHoursPerWeek = await getIntSetting(SETTING_KEYS.DOCTOR_MAX_HOURS_PER_WEEK, db);

  const monthStart = new Date(Date.UTC(clock.now().getUTCFullYear(), clock.now().getUTCMonth(), 1));
  // A dietitian or a trainer was never salaried; only doctors were, and only
  // until the cut-over.
  const salaried = doctor.discipline === 'DOCTOR' && (await salaryApplies(period, db));

  return {
    paidBy: salaried ? 'SALARY' : 'SHARE',
    period,
    contractedHoursPerWeek: doctor.contractedHoursPerWeek,
    employmentType: doctor.employmentType,
    // Null rather than zero when no contract is recorded: "we have not agreed
    // your hours" and "you are owed nothing" are different statements. Null,
    // too, once pay is by share: there is no monthly figure to show.
    monthlyMinor:
      salaried && doctor.contractedHoursPerWeek
        ? computeMonthlyCompensation({
            fullTimeMonthlyMinor,
            fullTimeHoursPerWeek,
            contractedHoursPerWeek: doctor.contractedHoursPerWeek,
          }).monthlyMinor
        : null,
    currency: 'GHS',
    scheduledLabel: formatHours(
      doctor.serviceHours.reduce((sum, week) => sum + week.minutesScheduled, 0),
    ),
    servedLabel: formatHours(
      doctor.serviceHours.reduce((sum, week) => sum + week.minutesServed, 0),
    ),
    consultationsThisPeriod: await db.consultation.count({
      where: { doctorId, state: 'COMPLETED', completedAt: { gte: monthStart } },
    }),
  };
}
