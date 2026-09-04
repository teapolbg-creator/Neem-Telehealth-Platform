import { getPrisma, type Db } from '../../db/prisma.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';

/**
 * Analytics (spec §54, §100).
 *
 * One rule governs this whole module, and it is the Phase 9 exit criterion:
 * **analytics never manufacture deleted clinical data.**
 *
 * Neem seals a consultation's clinical record at completion and destroys it
 * when its retention period ends (D23). Anything derived from that record is
 * therefore unavailable for older consultations — not zero, not estimated,
 * *unavailable* — and every figure here that could be affected reports its own
 * coverage alongside it.
 *
 * What is left is deliberately operational: how many consultations, how long
 * they took, what they cost, whether a doctor was found. None of it needs the
 * clinical record, so none of it degrades as records are destroyed.
 *
 * What this module will not do:
 *
 *  - Read a sealed clinical record. The guarded module refuses, and nothing
 *    here asks.
 *  - Report a diagnosis, a medication or a test result, in aggregate or
 *    otherwise. There is no query for it, because a "most common condition"
 *    chart is a medical history with a bar chart on top (spec §13).
 *  - Present a figure whose underlying data has been destroyed as though it
 *    were complete.
 */

export interface Period {
  from: Date;
  to: Date;
}

export function last30Days(clock: Clock = systemClock): Period {
  const to = clock.now();
  return { from: new Date(to.getTime() - 30 * 86_400_000), to };
}

/**
 * How much of a period's clinical data still exists.
 *
 * Reported beside anything derived from it, so a figure can never be read as
 * complete when it is not. For recent periods this is always 100% — records
 * are kept for years — and it exists for the day it is not.
 */
export interface ClinicalCoverage {
  consultationsInPeriod: number;
  /** Those whose clinical record has been destroyed under the retention job. */
  recordsDestroyed: number;
  /** True when every record behind the period still exists. */
  complete: boolean;
}

export async function clinicalCoverage(
  period: Period,
  db: Db = getPrisma(),
): Promise<ClinicalCoverage> {
  const consultationsInPeriod = await db.consultation.count({
    where: { createdAt: { gte: period.from, lte: period.to } },
  });

  const recordsDestroyed = await db.retentionJob.count({
    where: {
      status: 'COMPLETED',
      consultation: { createdAt: { gte: period.from, lte: period.to } },
    },
  });

  return {
    consultationsInPeriod,
    recordsDestroyed,
    complete: recordsDestroyed === 0,
  };
}

export interface OperationalSummary {
  period: { from: string; to: string };
  consultations: {
    created: number;
    completed: number;
    cancelled: number;
    expired: number;
    abandoned: number;
    refunded: number;
    /** Completed as a proportion of those that were paid for. */
    completionRate: number | null;
  };
  queue: {
    waitingNow: number;
    /** Median seconds from entering the queue to a doctor accepting. */
    medianTimeToDoctorSeconds: number | null;
    noLanguageMatch: number;
    missedOffers: number;
  };
  consultationMinutes: {
    median: number | null;
    total: number;
  };
  doctors: { active: number; onlineNow: number };
  pharmacies: { active: number; withConsultationsInPeriod: number };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  // Even counts average the two middle values; an integer result is not
  // assumed, because a median of seconds legitimately lands on a half.
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

/**
 * The operational picture (spec §54).
 *
 * Every figure here comes from the consultation row, the queue entry or the
 * assignment — none from the clinical record — so it stays accurate for the
 * full life of the operational data rather than decaying as records are
 * destroyed.
 */
export async function operationalSummary(
  period: Period,
  db: Db = getPrisma(),
): Promise<OperationalSummary> {
  const window = { gte: period.from, lte: period.to };

  const [consultations, assignments, presence, doctors, pharmacies, waitingNow] = await Promise.all(
    [
      db.consultation.findMany({
        where: { createdAt: window },
        select: {
          state: true,
          durationSeconds: true,
          pharmacyId: true,
          queuedAt: true,
          assignedAt: true,
        },
      }),
      db.consultationAssignment.findMany({
        where: { offeredAt: window },
        select: { result: true },
      }),
      db.doctorPresence.count({ where: { onlineSince: { not: null } } }),
      db.doctor.count({ where: { status: 'ACTIVE' } }),
      db.pharmacy.count({ where: { status: 'ACTIVE' } }),
      db.consultationQueueEntry.count({ where: { state: { in: ['WAITING', 'OFFERING'] } } }),
    ],
  );

  const counted = (state: string) => consultations.filter((row) => row.state === state).length;

  const completed = counted('COMPLETED');
  const paidFor = consultations.filter(
    (row) => !['PENDING_PAYMENT', 'PAYMENT_PROCESSING', 'PAYMENT_FAILED'].includes(row.state),
  ).length;

  // Queue entry to acceptance. Only where both timestamps exist — a
  // consultation that never reached a doctor has no such interval, and
  // treating its absence as zero would flatter the figure.
  const timesToDoctor = consultations
    .filter((row) => row.queuedAt && row.assignedAt)
    .map((row) => (row.assignedAt!.getTime() - row.queuedAt!.getTime()) / 1000);

  const durations = consultations
    .filter((row) => row.durationSeconds !== null && row.state === 'COMPLETED')
    .map((row) => row.durationSeconds!);

  const noLanguageMatch = await db.consultationQueueEntry.count({
    where: { enqueuedAt: window, noMatchAlertedAt: { not: null } },
  });

  return {
    period: { from: period.from.toISOString(), to: period.to.toISOString() },
    consultations: {
      created: consultations.length,
      completed,
      cancelled: counted('CANCELLED'),
      expired: counted('EXPIRED'),
      abandoned: counted('ABANDONED'),
      refunded: counted('REFUNDED'),
      // Null rather than zero when nothing was paid for: "no consultations"
      // and "none completed" are different statements.
      completionRate: paidFor === 0 ? null : completed / paidFor,
    },
    queue: {
      waitingNow,
      medianTimeToDoctorSeconds: median(timesToDoctor),
      noLanguageMatch,
      missedOffers: assignments.filter((row) => row.result === 'MISSED').length,
    },
    consultationMinutes: {
      median: median(durations.map((seconds) => seconds / 60)),
      total: Math.round(durations.reduce((sum, seconds) => sum + seconds, 0) / 60),
    },
    doctors: { active: doctors, onlineNow: presence },
    pharmacies: {
      active: pharmacies,
      withConsultationsInPeriod: new Set(consultations.map((row) => row.pharmacyId)).size,
    },
  };
}

export interface FinancialSummary {
  period: { from: string; to: string };
  currency: string;
  grossMinor: number;
  discountMinor: number;
  netMinor: number;
  pharmacyShareMinor: number;
  neemShareMinor: number;
  refundedMinor: number;
  membershipMinor: number;
  paidConsultations: number;
  /** Allocations reversed by a refund, excluded from every figure above. */
  reversedAllocations: number;
}

/**
 * The financial picture (spec §54).
 *
 * Reversed allocations are excluded rather than netted off, for the same
 * reason payouts exclude them: a refunded consultation never earned anything,
 * and subtracting it from unrelated revenue makes the total impossible to
 * reconcile against the consultations behind it. What was refunded is reported
 * separately, which is the number an administrator actually asks for.
 */
export async function financialSummary(
  period: Period,
  db: Db = getPrisma(),
): Promise<FinancialSummary> {
  const window = { gte: period.from, lte: period.to };

  const [allocations, reversed, refunds, membership] = await Promise.all([
    db.revenueAllocation.findMany({
      where: { calculatedAt: window, reversedAt: null },
      select: {
        grossMinor: true,
        discountMinor: true,
        netMinor: true,
        pharmacyShareMinor: true,
        neemShareMinor: true,
        currency: true,
      },
    }),
    db.revenueAllocation.count({ where: { calculatedAt: window, reversedAt: { not: null } } }),
    db.refund.aggregate({
      where: { state: 'COMPLETED', completedAt: window },
      _sum: { amountMinor: true },
    }),
    db.payment.aggregate({
      where: { status: 'SUCCESS', paidAt: window, doctorSubscriptionId: { not: null } },
      _sum: { amountMinor: true },
    }),
  ]);

  const sum = (field: keyof (typeof allocations)[number]) =>
    allocations.reduce((total, row) => total + (row[field] as number), 0);

  return {
    period: { from: period.from.toISOString(), to: period.to.toISOString() },
    currency: allocations[0]?.currency ?? 'GHS',
    grossMinor: sum('grossMinor'),
    discountMinor: sum('discountMinor'),
    netMinor: sum('netMinor'),
    pharmacyShareMinor: sum('pharmacyShareMinor'),
    neemShareMinor: sum('neemShareMinor'),
    refundedMinor: refunds._sum.amountMinor ?? 0,
    // A doctor's membership is Neem income with no pharmacy share, so it is
    // reported beside the split rather than inside it.
    membershipMinor: membership._sum.amountMinor ?? 0,
    paidConsultations: allocations.length,
    reversedAllocations: reversed,
  };
}

export interface SatisfactionSummary {
  period: { from: string; to: string };
  responses: number;
  meanDoctorRating: number | null;
  meanNeemRating: number | null;
  compliments: number;
  suggestions: number;
  complaints: number;
  openComplaints: number;
  /** Consultations completed in the period, for a response rate. */
  completedConsultations: number;
  responseRate: number | null;
}

/**
 * Satisfaction and complaints (spec §51, §54).
 *
 * Ratings, counts and a response rate. Deliberately not the comments: those
 * are patients' own words about their care, they are read on the complaint
 * itself where an administrator has the context, and a dashboard that
 * displayed them in bulk would be a feed of clinical anecdote.
 */
export async function satisfactionSummary(
  period: Period,
  db: Db = getPrisma(),
): Promise<SatisfactionSummary> {
  const window = { gte: period.from, lte: period.to };

  const [feedback, openComplaints, completedConsultations] = await Promise.all([
    db.feedback.findMany({
      where: { submittedAt: window },
      select: { doctorRating: true, neemRating: true, category: true },
    }),
    db.complaint.count({ where: { state: 'OPEN' } }),
    db.consultation.count({ where: { state: 'COMPLETED', completedAt: window } }),
  ]);

  const mean = (values: number[]) =>
    values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;

  return {
    period: { from: period.from.toISOString(), to: period.to.toISOString() },
    responses: feedback.length,
    meanDoctorRating: mean(feedback.map((row) => row.doctorRating)),
    meanNeemRating: mean(feedback.map((row) => row.neemRating)),
    compliments: feedback.filter((row) => row.category === 'COMPLIMENT').length,
    suggestions: feedback.filter((row) => row.category === 'SUGGESTION').length,
    complaints: feedback.filter((row) => row.category === 'COMPLAINT').length,
    openComplaints,
    completedConsultations,
    responseRate: completedConsultations === 0 ? null : feedback.length / completedConsultations,
  };
}

export interface OutcomeMix {
  period: { from: string; to: string };
  /**
   * What each consultation concluded with — advice, a prescription, a
   * referral. An outcome is operational metadata: it drives the pharmacy's
   * next step and the revenue split, and it survives sealing. It says what
   * *kind* of thing was issued, never what was in it.
   */
  outcomes: Array<{ outcome: string; count: number }>;
  /** Completed consultations with no outcome recorded, so the mix is honest. */
  unrecorded: number;
  coverage: ClinicalCoverage;
}

export async function outcomeMix(period: Period, db: Db = getPrisma()): Promise<OutcomeMix> {
  const completed = await db.consultation.findMany({
    where: { state: 'COMPLETED', completedAt: { gte: period.from, lte: period.to } },
    select: { outcome: true },
  });

  const counts = new Map<string, number>();
  let unrecorded = 0;

  for (const row of completed) {
    if (!row.outcome) {
      unrecorded += 1;
      continue;
    }
    counts.set(row.outcome, (counts.get(row.outcome) ?? 0) + 1);
  }

  return {
    period: { from: period.from.toISOString(), to: period.to.toISOString() },
    outcomes: [...counts.entries()]
      .map(([outcome, count]) => ({ outcome, count }))
      .sort((a, b) => b.count - a.count),
    unrecorded,
    // Carried even though the outcome column survives destruction, so the
    // screen can say what proportion of the period's records still exist.
    coverage: await clinicalCoverage(period, db),
  };
}
