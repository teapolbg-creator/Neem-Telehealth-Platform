import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUALITY_WEIGHTS,
  PROVISIONAL_THRESHOLD,
  assertQualityWeightsValid,
  computeQualityScore,
  effectiveRoutingScore,
  type QualityInputs,
} from '../../src/domain/quality-score.ts';

/**
 * Doctor quality score (spec §52).
 *
 * The score influences routing and admin decisions about a real clinician's
 * livelihood, so the properties tested here are about not judging on thin
 * evidence as much as about arithmetic.
 */

function inputs(overrides: Partial<QualityInputs> = {}): QualityInputs {
  return {
    meanRating: 4,
    ratingCount: 20,
    complaints: 0,
    consultations: 50,
    medianResponseSeconds: 20,
    responseWindowSeconds: 90,
    missedResponses: 0,
    offers: 50,
    completed: 48,
    abandoned: 2,
    auditsPassed: 3,
    auditsFailed: 0,
    prescriptionIssues: 0,
    prescriptions: 30,
    ...overrides,
  };
}

describe('component scoring', () => {
  it('maps a 1–5 rating onto [0,1]', () => {
    expect(computeQualityScore(inputs({ meanRating: 5 })).rating).toBe(1);
    expect(computeQualityScore(inputs({ meanRating: 3 })).rating).toBe(0.5);
    expect(computeQualityScore(inputs({ meanRating: 1 })).rating).toBe(0);
  });

  it('scores every component so that higher is better, including the negatives', () => {
    // Keeping all components same-signed makes the weighted sum an average
    // rather than a mix where a sign error would pass unnoticed.
    const clean = computeQualityScore(inputs({ complaints: 0 }));
    const complained = computeQualityScore(inputs({ complaints: 10 }));

    expect(clean.complaints).toBeGreaterThan(complained.complaints);
    expect(clean.score).toBeGreaterThan(complained.score);
  });

  it('measures response time against the configured window, not the pool', () => {
    const fast = computeQualityScore(inputs({ medianResponseSeconds: 9, responseWindowSeconds: 90 }));
    const slow = computeQualityScore(inputs({ medianResponseSeconds: 81, responseWindowSeconds: 90 }));

    expect(fast.responseTime).toBeCloseTo(0.9, 2);
    expect(slow.responseTime).toBeCloseTo(0.1, 2);
  });

  it('penalises missed responses in proportion to offers', () => {
    const reliable = computeQualityScore(inputs({ missedResponses: 0, offers: 50 }));
    const unreliable = computeQualityScore(inputs({ missedResponses: 25, offers: 50 }));

    expect(reliable.missedResponses).toBe(1);
    expect(unreliable.missedResponses).toBe(0.5);
  });

  it('scores absent evidence as neutral, never as failure', () => {
    const blank = computeQualityScore({
      meanRating: null,
      ratingCount: 0,
      complaints: 0,
      consultations: 0,
      medianResponseSeconds: null,
      responseWindowSeconds: 90,
      missedResponses: 0,
      offers: 0,
      completed: 0,
      abandoned: 0,
      auditsPassed: 0,
      auditsFailed: 0,
      prescriptionIssues: 0,
      prescriptions: 0,
    });

    expect(blank.rating).toBe(0.5);
    expect(blank.complaints).toBe(0.5);
    expect(blank.responseTime).toBe(0.5);
    expect(blank.score).toBe(0.5);
  });

  it('keeps the score within [0,1] for the best and worst possible doctor', () => {
    const best = computeQualityScore(
      inputs({
        meanRating: 5,
        complaints: 0,
        medianResponseSeconds: 0,
        missedResponses: 0,
        completed: 50,
        abandoned: 0,
        auditsPassed: 10,
        auditsFailed: 0,
        prescriptionIssues: 0,
      }),
    );
    const worst = computeQualityScore(
      inputs({
        meanRating: 1,
        complaints: 50,
        medianResponseSeconds: 900,
        missedResponses: 50,
        completed: 0,
        abandoned: 50,
        auditsPassed: 0,
        auditsFailed: 10,
        prescriptionIssues: 30,
      }),
    );

    expect(best.score).toBeLessThanOrEqual(1);
    expect(worst.score).toBeGreaterThanOrEqual(0);
    expect(best.score).toBeGreaterThan(worst.score);
  });
});

describe('provisional scores', () => {
  it('marks a doctor with little history as provisional', () => {
    expect(computeQualityScore(inputs({ consultations: 3 })).provisional).toBe(true);
    expect(
      computeQualityScore(inputs({ consultations: PROVISIONAL_THRESHOLD })).provisional,
    ).toBe(false);
  });

  it('blends a provisional score toward the cohort median', () => {
    // One unhappy patient must not effectively remove a new clinician from
    // rotation before they have a record.
    const harsh = computeQualityScore(inputs({ consultations: 2, meanRating: 1, complaints: 2 }));
    expect(harsh.provisional).toBe(true);

    const routing = effectiveRoutingScore(harsh, 0.8);
    expect(routing).toBeGreaterThan(harsh.score);
    expect(routing).toBeLessThan(0.8);
  });

  it('does not blend a settled score', () => {
    const settled = computeQualityScore(inputs({ consultations: 100 }));
    expect(effectiveRoutingScore(settled, 0.2)).toBe(settled.score);
  });

  it('falls back to neutral when there is no cohort to compare against', () => {
    const provisional = computeQualityScore(inputs({ consultations: 1 }));
    const routing = effectiveRoutingScore(provisional, null);

    expect(routing).toBeCloseTo((provisional.score + 0.5) / 2, 4);
  });
});

describe('weight validation', () => {
  it('accepts the seeded defaults', () => {
    expect(() => assertQualityWeightsValid(DEFAULT_QUALITY_WEIGHTS)).not.toThrow();
  });

  it('rejects weights that do not sum to 1', () => {
    expect(() =>
      assertQualityWeightsValid({ ...DEFAULT_QUALITY_WEIGHTS, rating: 0.9 }),
    ).toThrow(/sum to 1/);
  });
});
