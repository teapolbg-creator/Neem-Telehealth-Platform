import type { PrismaClient } from '@prisma/client';
import { getPrisma, type Db } from '../../db/prisma.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
import { getIntSetting, getNumberSetting } from '../settings/settings.service.ts';
import { SETTING_KEYS } from '../settings/settings.defaults.ts';
import {
  computeQualityScore,
  effectiveRoutingScore,
  type QualityInputs,
  type QualityWeights,
} from '../../domain/quality-score.ts';

/**
 * Doctor quality scoring (spec §52).
 *
 * Recomputed on a schedule from `doctor_performance_events` and feedback.
 *
 * **Never exposed to doctors.** There is no route in the doctor module that
 * returns a score or a rating, and `tests/unit/permissions.test.ts` asserts
 * the permission does not exist for that role (spec §24).
 */

const WINDOW_DAYS = 90;

export async function loadQualityWeights(db: Db = getPrisma()): Promise<QualityWeights> {
  const [rating, complaints, responseTime, missedResponses, completionRate, auditOutcomes, prescriptionIssues] =
    await Promise.all([
      getNumberSetting(SETTING_KEYS.QUALITY_WEIGHT_RATING, db),
      getNumberSetting(SETTING_KEYS.QUALITY_WEIGHT_COMPLAINTS, db),
      getNumberSetting(SETTING_KEYS.QUALITY_WEIGHT_RESPONSE_TIME, db),
      getNumberSetting(SETTING_KEYS.QUALITY_WEIGHT_MISSED, db),
      getNumberSetting(SETTING_KEYS.QUALITY_WEIGHT_COMPLETION, db),
      getNumberSetting(SETTING_KEYS.QUALITY_WEIGHT_AUDIT, db),
      getNumberSetting(SETTING_KEYS.QUALITY_WEIGHT_RX_ISSUES, db),
    ]);

  return {
    rating,
    complaints,
    responseTime,
    missedResponses,
    completionRate,
    auditOutcomes,
    prescriptionIssues,
  };
}

/** Gathers the evidence for one doctor over the scoring window. */
export async function collectQualityInputs(
  doctorId: string,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<QualityInputs> {
  const now = clock.now();
  const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000);
  const responseWindowSeconds = await getIntSetting(SETTING_KEYS.QUEUE_RESPONSE_WINDOW_SECONDS, db);

  const [events, assignments, consultations, feedback, prescriptions] = await Promise.all([
    db.doctorPerformanceEvent.findMany({
      where: { doctorId, occurredAt: { gte: since } },
    }),
    db.consultationAssignment.findMany({
      where: { doctorId, offeredAt: { gte: since } },
      select: { offeredAt: true, acceptedAt: true, result: true },
    }),
    db.consultation.findMany({
      where: { doctorId, createdAt: { gte: since } },
      select: { state: true },
    }),
    db.feedback.findMany({
      where: { consultation: { doctorId }, submittedAt: { gte: since } },
      select: { doctorRating: true, category: true },
    }),
    db.prescription.findMany({
      where: { doctorId, createdAt: { gte: since } },
      select: { state: true },
    }),
  ]);

  const latencies = assignments
    .filter((assignment) => assignment.acceptedAt)
    .map((assignment) => (assignment.acceptedAt!.getTime() - assignment.offeredAt.getTime()) / 1000)
    .sort((a, b) => a - b);

  const ratings = feedback.map((entry) => entry.doctorRating);

  return {
    meanRating:
      ratings.length === 0
        ? null
        : ratings.reduce((sum, value) => sum + value, 0) / ratings.length,
    ratingCount: ratings.length,

    complaints: feedback.filter((entry) => entry.category === 'COMPLAINT').length,
    consultations: consultations.length,

    medianResponseSeconds:
      latencies.length === 0 ? null : (latencies[Math.floor(latencies.length / 2)] ?? null),
    responseWindowSeconds,

    missedResponses: assignments.filter((assignment) => assignment.result === 'MISSED').length,
    offers: assignments.length,

    completed: consultations.filter((consultation) => consultation.state === 'COMPLETED').length,
    abandoned: consultations.filter((consultation) => consultation.state === 'ABANDONED').length,

    auditsPassed: events.filter(
      (event) => event.type === 'AUDIT' && Number(event.numericValue ?? 0) >= 1,
    ).length,
    auditsFailed: events.filter(
      (event) => event.type === 'AUDIT' && Number(event.numericValue ?? 0) < 1,
    ).length,

    prescriptionIssues: prescriptions.filter((prescription) => prescription.state === 'REVOKED')
      .length,
    prescriptions: prescriptions.length,
  };
}

export interface QualitySweepResult {
  scored: number;
  cohortMedian: number | null;
}

/**
 * Recomputes every active doctor's score.
 *
 * Two passes: score everyone, then blend the provisional ones toward the
 * cohort median. A doctor with almost no history is neither promoted nor
 * buried by a handful of data points (see `effectiveRoutingScore`).
 */
export async function recomputeQualityScores(
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<QualitySweepResult> {
  const weights = await loadQualityWeights(db);
  const now = clock.now();
  const periodStart = new Date(now.getTime() - WINDOW_DAYS * 86_400_000);

  const doctors = await db.doctor.findMany({
    where: { status: { in: ['ACTIVE', 'APPROVED', 'SUSPENDED'] } },
    select: { id: true },
  });

  const computed = await Promise.all(
    doctors.map(async (doctor) => ({
      doctorId: doctor.id,
      breakdown: computeQualityScore(await collectQualityInputs(doctor.id, db, clock), weights),
    })),
  );

  const settled = computed.filter((entry) => !entry.breakdown.provisional).map((e) => e.breakdown.score);
  const cohortMedian =
    settled.length === 0
      ? null
      : (settled.sort((a, b) => a - b)[Math.floor(settled.length / 2)] ?? null);

  for (const entry of computed) {
    const routingScore = effectiveRoutingScore(entry.breakdown, cohortMedian);

    await db.doctorQualityScore.upsert({
      where: {
        doctorId_periodStart_periodEnd: {
          doctorId: entry.doctorId,
          periodStart,
          periodEnd: now,
        },
      },
      update: { score: routingScore, breakdown: entry.breakdown as never, computedAt: now },
      create: {
        doctorId: entry.doctorId,
        periodStart,
        periodEnd: now,
        score: routingScore,
        breakdown: entry.breakdown as never,
        computedAt: now,
      },
    });
  }

  return { scored: computed.length, cohortMedian };
}

/** Admin-only view. Never reachable by a doctor principal. */
export async function getQualityForAdmin(doctorId: string, db: Db = getPrisma()) {
  return db.doctorQualityScore.findFirst({
    where: { doctorId },
    orderBy: { computedAt: 'desc' },
  });
}
