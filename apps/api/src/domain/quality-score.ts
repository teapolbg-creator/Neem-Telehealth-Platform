/**
 * Doctor quality score (spec §52).
 *
 * Feeds the allocation engine and admin review. **Doctors never see it**, and
 * they never see the patient ratings behind it (spec §24) — there is no API
 * route that returns either to a doctor principal, and an authorization test
 * asserts that.
 *
 * Pure, so the weighting an admin configures can be reasoned about and tested
 * without a database.
 */

export interface QualityInputs {
  /** Mean patient rating in [1,5]; null when the doctor has none yet. */
  meanRating: number | null;
  ratingCount: number;

  complaints: number;
  /** Consultations in the window, the denominator for the rate measures. */
  consultations: number;

  /** Rolling median offer→accept latency in seconds; null when unknown. */
  medianResponseSeconds: number | null;
  /** The configured response window, so lateness is measured against the rule. */
  responseWindowSeconds: number;

  missedResponses: number;
  offers: number;

  completed: number;
  abandoned: number;

  /** Clinical or administrative audits, each recorded as pass or fail. */
  auditsPassed: number;
  auditsFailed: number;

  /** Revocations and rejected substitutions — prescribing quality signals. */
  prescriptionIssues: number;
  prescriptions: number;
}

export interface QualityWeights {
  rating: number;
  complaints: number;
  responseTime: number;
  missedResponses: number;
  completionRate: number;
  auditOutcomes: number;
  prescriptionIssues: number;
}

export const DEFAULT_QUALITY_WEIGHTS: QualityWeights = {
  rating: 0.3,
  complaints: 0.2,
  responseTime: 0.15,
  missedResponses: 0.15,
  completionRate: 0.1,
  auditOutcomes: 0.05,
  prescriptionIssues: 0.05,
};

export interface QualityBreakdown {
  rating: number;
  complaints: number;
  responseTime: number;
  missedResponses: number;
  completionRate: number;
  auditOutcomes: number;
  prescriptionIssues: number;
  score: number;
  /** True when too little history exists to judge — the score is provisional. */
  provisional: boolean;
}

/**
 * Below this many consultations, a doctor's score is provisional.
 *
 * A single complaint against two consultations is not evidence of a pattern,
 * and treating it as one would let one unhappy patient effectively remove a
 * clinician from rotation.
 */
export const PROVISIONAL_THRESHOLD = 10;

const unit = (value: number): number =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

/**
 * Computes the score in [0,1].
 *
 * Every component is expressed so that **higher is better**, including the
 * negative signals — `complaints` becomes "freedom from complaints". That
 * keeps the weighted sum a straightforward average rather than a mix of
 * additions and subtractions where a sign error would go unnoticed.
 *
 * Absent evidence scores the neutral 0.5, never 0.
 */
export function computeQualityScore(
  inputs: QualityInputs,
  weights: QualityWeights = DEFAULT_QUALITY_WEIGHTS,
): QualityBreakdown {
  // 1–5 stars mapped onto [0,1].
  const rating =
    inputs.meanRating === null || inputs.ratingCount === 0
      ? 0.5
      : unit((inputs.meanRating - 1) / 4);

  const complaints =
    inputs.consultations === 0 ? 0.5 : unit(1 - inputs.complaints / inputs.consultations);

  // Measured against the configured window: answering well inside it is what
  // "fast" means here, not being fastest in the pool.
  const responseTime =
    inputs.medianResponseSeconds === null || inputs.responseWindowSeconds <= 0
      ? 0.5
      : unit(1 - inputs.medianResponseSeconds / inputs.responseWindowSeconds);

  const missedResponses =
    inputs.offers === 0 ? 0.5 : unit(1 - inputs.missedResponses / inputs.offers);

  const started = inputs.completed + inputs.abandoned;
  const completionRate = started === 0 ? 0.5 : unit(inputs.completed / started);

  const audits = inputs.auditsPassed + inputs.auditsFailed;
  const auditOutcomes = audits === 0 ? 0.5 : unit(inputs.auditsPassed / audits);

  const prescriptionIssues =
    inputs.prescriptions === 0 ? 0.5 : unit(1 - inputs.prescriptionIssues / inputs.prescriptions);

  const score =
    rating * weights.rating +
    complaints * weights.complaints +
    responseTime * weights.responseTime +
    missedResponses * weights.missedResponses +
    completionRate * weights.completionRate +
    auditOutcomes * weights.auditOutcomes +
    prescriptionIssues * weights.prescriptionIssues;

  return {
    rating: round(rating),
    complaints: round(complaints),
    responseTime: round(responseTime),
    missedResponses: round(missedResponses),
    completionRate: round(completionRate),
    auditOutcomes: round(auditOutcomes),
    prescriptionIssues: round(prescriptionIssues),
    score: round(score),
    provisional: inputs.consultations < PROVISIONAL_THRESHOLD,
  };
}

/**
 * The score the allocation engine should use.
 *
 * A provisional score is blended toward the cohort median so a doctor with
 * almost no history is neither promoted nor buried by a handful of data
 * points. With no cohort to compare against, it returns neutral.
 */
export function effectiveRoutingScore(
  breakdown: QualityBreakdown,
  cohortMedian: number | null,
): number {
  if (!breakdown.provisional) return breakdown.score;

  const median = cohortMedian ?? 0.5;
  return round((breakdown.score + median) / 2);
}

function round(value: number): number {
  return Number(value.toFixed(4));
}

export function assertQualityWeightsValid(weights: QualityWeights): void {
  const total = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
  if (Math.abs(total - 1) > 1e-6) {
    throw new Error(`Quality weights must sum to 1.0; received ${total}`);
  }
}
