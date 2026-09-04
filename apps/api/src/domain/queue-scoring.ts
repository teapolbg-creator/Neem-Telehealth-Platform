/**
 * Smart consultation allocation (spec §28, §29, §30).
 *
 * The business document described "the first available doctor to accept gets
 * the patient" and then argued against it in its own strategic recommendation;
 * the answers document settled on the smart queue. First-to-click is not
 * implemented anywhere.
 *
 * This module is pure — `(candidates, weights, clock) → ranked list`. No I/O,
 * so the fairness properties are cheap to test exhaustively, and the stored
 * `scoreBreakdown` on every offer makes a real allocation reproducible after
 * the fact.
 *
 * The one rule that is NOT a weight: **language**. A doctor who does not speak
 * the patient's selected language is excluded before scoring begins and cannot
 * be assigned at any score (spec §29).
 */

export interface DoctorCandidate {
  doctorId: string;
  /** Language codes this doctor consults in. */
  languageCodes: string[];
  /** The doctor's primary language, which scores higher than a secondary one. */
  primaryLanguageCode: string | null;

  status: string;
  subscriptionUsable: boolean;
  licenceValid: boolean;
  onShift: boolean;
  present: boolean;

  currentLoad: number;
  maxLoad: number;

  /** Consultations served during the current shift, for workload balance. */
  servedThisShift: number;
  /** Completed in the trailing 24 hours, for fair distribution. */
  completedLast24h: number;
  /** Rolling median offer→accept latency in seconds; null for a new doctor. */
  medianResponseSeconds: number | null;
  /** Internal quality score in [0,1]; null for a doctor with no history. */
  qualityScore: number | null;

  /** When this doctor last received an offer — the primary tie-break. */
  lastOfferedAt: Date | null;
  /** Doctors already offered this consultation, so they are not re-offered. */
  alreadyOffered: boolean;
}

export interface QueueWeights {
  language: number;
  availability: number;
  workload: number;
  responseTime: number;
  recentCount: number;
  quality: number;
}

export const DEFAULT_WEIGHTS: QueueWeights = {
  language: 0.3,
  availability: 0.2,
  workload: 0.2,
  responseTime: 0.15,
  recentCount: 0.1,
  quality: 0.05,
};

export type IneligibilityReason =
  | 'NOT_ACTIVE'
  | 'SUBSCRIPTION_LAPSED'
  | 'LICENCE_EXPIRED'
  | 'OFF_SHIFT'
  | 'NOT_PRESENT'
  | 'LANGUAGE_MISMATCH'
  | 'AT_CAPACITY'
  | 'ALREADY_OFFERED';

export interface EligibilityResult {
  eligible: boolean;
  reason?: IneligibilityReason;
}

/**
 * The hard gate. Every condition must hold; none is tradeable against a score.
 *
 * Order matters only for the reason reported, which is what tells an admin why
 * a queue is starved — "no doctor speaks Ga right now" is a different
 * operational problem from "everyone is at capacity".
 */
export function checkEligibility(
  candidate: DoctorCandidate,
  requiredLanguageCode: string,
): EligibilityResult {
  if (candidate.alreadyOffered) return { eligible: false, reason: 'ALREADY_OFFERED' };
  // Spec §83 — only ACTIVE doctors receive consultations.
  if (candidate.status !== 'ACTIVE') return { eligible: false, reason: 'NOT_ACTIVE' };
  if (!candidate.subscriptionUsable) return { eligible: false, reason: 'SUBSCRIPTION_LAPSED' };
  if (!candidate.licenceValid) return { eligible: false, reason: 'LICENCE_EXPIRED' };
  if (!candidate.onShift) return { eligible: false, reason: 'OFF_SHIFT' };
  if (!candidate.present) return { eligible: false, reason: 'NOT_PRESENT' };

  // The rule that is never a weight (spec §29).
  if (!candidate.languageCodes.includes(requiredLanguageCode)) {
    return { eligible: false, reason: 'LANGUAGE_MISMATCH' };
  }

  if (candidate.currentLoad >= candidate.maxLoad) return { eligible: false, reason: 'AT_CAPACITY' };

  return { eligible: true };
}

export interface ScoreBreakdown {
  language: number;
  availability: number;
  workload: number;
  responseTime: number;
  recentCount: number;
  quality: number;
  total: number;
}

export interface ScoredDoctor {
  doctorId: string;
  score: number;
  breakdown: ScoreBreakdown;
}

/** Clamps to [0,1] so no sub-score can distort the weighted total. */
function unit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Context the scorer needs to normalise a candidate against the current pool.
 *
 * Normalising against the pool rather than against fixed constants is what
 * makes "workload balance" mean anything: being busy only matters relative to
 * how busy everyone else is right now.
 */
export interface ScoringContext {
  /** Median consultations served this shift across the eligible pool. */
  medianServedThisShift: number;
  /** Highest 24-hour completion count in the pool, for normalisation. */
  maxCompletedLast24h: number;
  /** Slowest median response in the pool, in seconds. */
  maxMedianResponseSeconds: number;
}

export function buildScoringContext(candidates: DoctorCandidate[]): ScoringContext {
  if (candidates.length === 0) {
    return { medianServedThisShift: 0, maxCompletedLast24h: 0, maxMedianResponseSeconds: 0 };
  }

  const served = candidates.map((candidate) => candidate.servedThisShift).sort((a, b) => a - b);
  const middle = Math.floor(served.length / 2);
  const medianServedThisShift =
    served.length % 2 === 0
      ? ((served[middle - 1] ?? 0) + (served[middle] ?? 0)) / 2
      : (served[middle] ?? 0);

  return {
    medianServedThisShift,
    maxCompletedLast24h: Math.max(...candidates.map((c) => c.completedLast24h), 0),
    maxMedianResponseSeconds: Math.max(...candidates.map((c) => c.medianResponseSeconds ?? 0), 0),
  };
}

/**
 * Scores one eligible candidate.
 *
 * A doctor with no history — no recorded response time, no quality score —
 * receives the neutral 0.5 rather than 0. Scoring absence as failure would
 * starve every newly approved doctor of the work they need to build a record,
 * which is the opposite of the fair distribution the specification asks for.
 */
export function scoreCandidate(
  candidate: DoctorCandidate,
  requiredLanguageCode: string,
  weights: QueueWeights,
  context: ScoringContext,
): ScoredDoctor {
  // Primary language scores full; a secondary language still qualifies.
  const language = candidate.primaryLanguageCode === requiredLanguageCode ? 1 : 0.7;

  const availability =
    candidate.maxLoad <= 0 ? 0 : unit(1 - candidate.currentLoad / candidate.maxLoad);

  // Below the pool median scores above 0.5; above it, below.
  const workload =
    context.medianServedThisShift <= 0
      ? 1
      : unit(1 - candidate.servedThisShift / (context.medianServedThisShift * 2));

  const responseTime =
    candidate.medianResponseSeconds === null
      ? 0.5
      : context.maxMedianResponseSeconds <= 0
        ? 1
        : unit(1 - candidate.medianResponseSeconds / context.maxMedianResponseSeconds);

  const recentCount =
    context.maxCompletedLast24h <= 0
      ? 1
      : unit(1 - candidate.completedLast24h / context.maxCompletedLast24h);

  const quality = candidate.qualityScore === null ? 0.5 : unit(candidate.qualityScore);

  const total =
    language * weights.language +
    availability * weights.availability +
    workload * weights.workload +
    responseTime * weights.responseTime +
    recentCount * weights.recentCount +
    quality * weights.quality;

  return {
    doctorId: candidate.doctorId,
    score: Number(total.toFixed(6)),
    breakdown: {
      language: Number(language.toFixed(4)),
      availability: Number(availability.toFixed(4)),
      workload: Number(workload.toFixed(4)),
      responseTime: Number(responseTime.toFixed(4)),
      recentCount: Number(recentCount.toFixed(4)),
      quality: Number(quality.toFixed(4)),
      total: Number(total.toFixed(6)),
    },
  };
}

export interface RankingResult {
  ranked: ScoredDoctor[];
  /** Why each excluded doctor was excluded — the material for admin alerts. */
  excluded: Array<{ doctorId: string; reason: IneligibilityReason }>;
}

/**
 * Filters, scores and ranks the pool for one consultation.
 *
 * Ties break on longest-idle, then fewest completed in 24h, then doctor id.
 * A deterministic final tie-break matters: without one, an arbitrary
 * comparator could favour the same doctor every time two are otherwise equal,
 * which is precisely the concentration the smart queue exists to prevent.
 */
export function rankDoctors(
  candidates: DoctorCandidate[],
  requiredLanguageCode: string,
  weights: QueueWeights = DEFAULT_WEIGHTS,
  now: Date = new Date(),
): RankingResult {
  const eligible: DoctorCandidate[] = [];
  const excluded: RankingResult['excluded'] = [];

  for (const candidate of candidates) {
    const result = checkEligibility(candidate, requiredLanguageCode);
    if (result.eligible) {
      eligible.push(candidate);
    } else {
      excluded.push({ doctorId: candidate.doctorId, reason: result.reason! });
    }
  }

  const context = buildScoringContext(eligible);
  const scored = eligible.map((candidate) =>
    scoreCandidate(candidate, requiredLanguageCode, weights, context),
  );

  const byId = new Map(eligible.map((candidate) => [candidate.doctorId, candidate]));

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;

    const left = byId.get(a.doctorId)!;
    const right = byId.get(b.doctorId)!;

    // Longest idle first. A doctor never offered anything is the most idle.
    const leftIdle = left.lastOfferedAt ? now.getTime() - left.lastOfferedAt.getTime() : Infinity;
    const rightIdle = right.lastOfferedAt
      ? now.getTime() - right.lastOfferedAt.getTime()
      : Infinity;
    if (leftIdle !== rightIdle) return rightIdle - leftIdle;

    if (left.completedLast24h !== right.completedLast24h) {
      return left.completedLast24h - right.completedLast24h;
    }

    return a.doctorId.localeCompare(b.doctorId);
  });

  return { ranked: scored, excluded };
}

/**
 * Whether a starved queue is starved *because of language*.
 *
 * Distinguishes "nobody who speaks Ga is online" — which needs an admin to
 * find a Ga-speaking doctor — from "everyone is simply busy", which resolves
 * itself. Only the former raises NO_LANGUAGE_MATCH (spec §29).
 */
export function isLanguageStarved(excluded: RankingResult['excluded']): boolean {
  if (excluded.length === 0) return false;

  const languageMismatches = excluded.filter((entry) => entry.reason === 'LANGUAGE_MISMATCH');
  const otherwiseAvailable = excluded.filter(
    (entry) => entry.reason === 'LANGUAGE_MISMATCH' || entry.reason === 'AT_CAPACITY',
  );

  return languageMismatches.length > 0 && otherwiseAvailable.length === excluded.length;
}

export function assertWeightsValid(weights: QueueWeights): void {
  const total = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
  if (Math.abs(total - 1) > 1e-6) {
    throw new Error(`Queue weights must sum to 1.0; received ${total}`);
  }
  for (const [name, weight] of Object.entries(weights)) {
    if (weight < 0) throw new Error(`Queue weight "${name}" cannot be negative`);
  }
}
