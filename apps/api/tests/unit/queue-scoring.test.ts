import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WEIGHTS,
  assertWeightsValid,
  buildScoringContext,
  checkEligibility,
  isLanguageStarved,
  rankDoctors,
  scoreCandidate,
  type DoctorCandidate,
} from '../../src/domain/queue-scoring.ts';

/**
 * Smart allocation (spec §28, §29).
 *
 * The properties worth guarding are fairness ones: the language gate is
 * absolute, ties never systematically favour the same doctor, and a doctor
 * with no history is not starved of the work that would give them one.
 */

function candidate(overrides: Partial<DoctorCandidate> = {}): DoctorCandidate {
  return {
    doctorId: 'doc_a',
    languageCodes: ['en', 'tw'],
    primaryLanguageCode: 'en',
    status: 'ACTIVE',
    subscriptionUsable: true,
    licenceValid: true,
    onShift: true,
    present: true,
    currentLoad: 0,
    maxLoad: 1,
    servedThisShift: 0,
    completedLast24h: 0,
    medianResponseSeconds: 30,
    qualityScore: 0.8,
    lastOfferedAt: null,
    alreadyOffered: false,
    ...overrides,
  };
}

describe('eligibility — the hard gate', () => {
  it('admits a fully eligible doctor', () => {
    expect(checkEligibility(candidate(), 'en').eligible).toBe(true);
  });

  it('excludes a doctor who does not speak the language, whatever else is true', () => {
    // The rule that is never traded against a score (spec §29). This doctor is
    // perfect on every other axis.
    const perfect = candidate({
      languageCodes: ['en'],
      qualityScore: 1,
      completedLast24h: 0,
      medianResponseSeconds: 1,
    });

    const result = checkEligibility(perfect, 'ga');
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('LANGUAGE_MISMATCH');
  });

  it('accepts a secondary language, not only the primary one', () => {
    expect(checkEligibility(candidate({ primaryLanguageCode: 'en' }), 'tw').eligible).toBe(true);
  });

  it('excludes a doctor who is not ACTIVE (spec §83)', () => {
    for (const status of [
      'PENDING',
      'UNDER_REVIEW',
      'APPROVED',
      'SUSPENDED',
      'EXPIRED',
      'REJECTED',
    ]) {
      const result = checkEligibility(candidate({ status }), 'en');
      expect(result.eligible, status).toBe(false);
      expect(result.reason).toBe('NOT_ACTIVE');
    }
  });

  it('excludes a lapsed subscription, an expired licence, an off-shift or absent doctor', () => {
    expect(checkEligibility(candidate({ subscriptionUsable: false }), 'en').reason).toBe(
      'SUBSCRIPTION_LAPSED',
    );
    expect(checkEligibility(candidate({ licenceValid: false }), 'en').reason).toBe(
      'LICENCE_EXPIRED',
    );
    expect(checkEligibility(candidate({ onShift: false }), 'en').reason).toBe('OFF_SHIFT');
    expect(checkEligibility(candidate({ present: false }), 'en').reason).toBe('NOT_PRESENT');
  });

  it('excludes a doctor at capacity', () => {
    expect(checkEligibility(candidate({ currentLoad: 1, maxLoad: 1 }), 'en').reason).toBe(
      'AT_CAPACITY',
    );
  });

  it('never re-offers the same consultation to a doctor who already had it', () => {
    // What makes reassignment progress instead of looping (spec §30).
    expect(checkEligibility(candidate({ alreadyOffered: true }), 'en').reason).toBe(
      'ALREADY_OFFERED',
    );
  });
});

describe('scoring', () => {
  const context = {
    medianServedThisShift: 4,
    maxCompletedLast24h: 10,
    maxMedianResponseSeconds: 60,
  };

  it('scores a primary-language match above a secondary one', () => {
    const primary = scoreCandidate(candidate(), 'en', DEFAULT_WEIGHTS, context);
    const secondary = scoreCandidate(candidate(), 'tw', DEFAULT_WEIGHTS, context);

    expect(primary.breakdown.language).toBe(1);
    expect(secondary.breakdown.language).toBe(0.7);
    expect(primary.score).toBeGreaterThan(secondary.score);
  });

  it('prefers the less busy of two doctors', () => {
    const quiet = scoreCandidate(candidate({ servedThisShift: 1 }), 'en', DEFAULT_WEIGHTS, context);
    const busy = scoreCandidate(candidate({ servedThisShift: 7 }), 'en', DEFAULT_WEIGHTS, context);

    expect(quiet.score).toBeGreaterThan(busy.score);
  });

  it('prefers the doctor with fewer consultations in the last 24 hours', () => {
    const fresh = scoreCandidate(
      candidate({ completedLast24h: 0 }),
      'en',
      DEFAULT_WEIGHTS,
      context,
    );
    const worked = scoreCandidate(
      candidate({ completedLast24h: 10 }),
      'en',
      DEFAULT_WEIGHTS,
      context,
    );

    expect(fresh.breakdown.recentCount).toBe(1);
    expect(worked.breakdown.recentCount).toBe(0);
    expect(fresh.score).toBeGreaterThan(worked.score);
  });

  it('gives a doctor with no history the neutral 0.5, not zero', () => {
    // Scoring absence as failure would starve every newly approved doctor of
    // the work they need to build a record.
    const newcomer = scoreCandidate(
      candidate({ medianResponseSeconds: null, qualityScore: null }),
      'en',
      DEFAULT_WEIGHTS,
      context,
    );

    expect(newcomer.breakdown.responseTime).toBe(0.5);
    expect(newcomer.breakdown.quality).toBe(0.5);
  });

  it('keeps every sub-score and the total within [0,1]', () => {
    const extremes = [
      candidate({ currentLoad: 5, maxLoad: 1 }),
      candidate({ servedThisShift: 1000 }),
      candidate({ completedLast24h: 1000 }),
      candidate({ medianResponseSeconds: 9999 }),
      candidate({ qualityScore: 5 }),
      candidate({ qualityScore: -3 }),
    ];

    for (const entry of extremes) {
      const scored = scoreCandidate(entry, 'en', DEFAULT_WEIGHTS, context);
      for (const [key, value] of Object.entries(scored.breakdown)) {
        expect(value, key).toBeGreaterThanOrEqual(0);
        expect(value, key).toBeLessThanOrEqual(1);
      }
    }
  });

  it('records a breakdown that reconstructs the total, so an offer can be explained', () => {
    const scored = scoreCandidate(candidate(), 'en', DEFAULT_WEIGHTS, context);
    const b = scored.breakdown;

    const recomputed =
      b.language * DEFAULT_WEIGHTS.language +
      b.availability * DEFAULT_WEIGHTS.availability +
      b.workload * DEFAULT_WEIGHTS.workload +
      b.responseTime * DEFAULT_WEIGHTS.responseTime +
      b.recentCount * DEFAULT_WEIGHTS.recentCount +
      b.quality * DEFAULT_WEIGHTS.quality;

    expect(recomputed).toBeCloseTo(scored.score, 3);
  });
});

describe('ranking', () => {
  it('returns nobody when no one speaks the language', () => {
    const pool = [
      candidate({ doctorId: 'a', languageCodes: ['en'] }),
      candidate({ doctorId: 'b', languageCodes: ['en', 'tw'] }),
    ];

    const result = rankDoctors(pool, 'ga');
    expect(result.ranked).toHaveLength(0);
    expect(result.excluded.every((entry) => entry.reason === 'LANGUAGE_MISMATCH')).toBe(true);
  });

  it('ranks the better-scoring doctor first', () => {
    const pool = [
      candidate({ doctorId: 'busy', servedThisShift: 9, completedLast24h: 9 }),
      candidate({ doctorId: 'quiet', servedThisShift: 0, completedLast24h: 0 }),
    ];

    expect(rankDoctors(pool, 'en').ranked[0]?.doctorId).toBe('quiet');
  });

  it('breaks a tie toward the longest-idle doctor', () => {
    const now = new Date('2026-09-01T12:00:00Z');
    const pool = [
      candidate({ doctorId: 'recent', lastOfferedAt: new Date('2026-09-01T11:59:00Z') }),
      candidate({ doctorId: 'idle', lastOfferedAt: new Date('2026-09-01T10:00:00Z') }),
    ];

    expect(rankDoctors(pool, 'en', DEFAULT_WEIGHTS, now).ranked[0]?.doctorId).toBe('idle');
  });

  it('treats a never-offered doctor as the most idle of all', () => {
    const now = new Date('2026-09-01T12:00:00Z');
    const pool = [
      candidate({ doctorId: 'seen', lastOfferedAt: new Date('2026-08-01T00:00:00Z') }),
      candidate({ doctorId: 'never', lastOfferedAt: null }),
    ];

    expect(rankDoctors(pool, 'en', DEFAULT_WEIGHTS, now).ranked[0]?.doctorId).toBe('never');
  });

  it('breaks a total tie deterministically rather than arbitrarily', () => {
    // Without a stable final tie-break, an arbitrary comparator could favour
    // the same doctor every time — the concentration this engine exists to
    // prevent (spec §28).
    const pool = [
      candidate({ doctorId: 'zeta' }),
      candidate({ doctorId: 'alpha' }),
      candidate({ doctorId: 'mid' }),
    ];

    const first = rankDoctors(pool, 'en').ranked.map((entry) => entry.doctorId);
    const second = rankDoctors([...pool].reverse(), 'en').ranked.map((entry) => entry.doctorId);

    expect(first).toEqual(second);
    expect(first[0]).toBe('alpha');
  });

  it('distributes fairly across repeated allocations', () => {
    // Simulates ten consultations: whoever is offered one gets busier, so the
    // engine should spread the load rather than concentrating it.
    const pool = ['a', 'b', 'c'].map((id) => candidate({ doctorId: id, lastOfferedAt: null }));
    const counts: Record<string, number> = { a: 0, b: 0, c: 0 };

    for (let round = 0; round < 9; round += 1) {
      const winner = rankDoctors(pool, 'en').ranked[0]!.doctorId;
      counts[winner] = (counts[winner] ?? 0) + 1;

      const chosen = pool.find((entry) => entry.doctorId === winner)!;
      chosen.servedThisShift += 1;
      chosen.completedLast24h += 1;
      chosen.lastOfferedAt = new Date();
    }

    // No doctor should be starved, and none should take the lot.
    for (const count of Object.values(counts)) {
      expect(count).toBeGreaterThan(0);
      expect(count).toBeLessThan(9);
    }
  });

  it('reports why each doctor was excluded, which is what admin alerts need', () => {
    const pool = [
      candidate({ doctorId: 'wrong-language', languageCodes: ['en'] }),
      candidate({ doctorId: 'offline', present: false }),
      candidate({ doctorId: 'suspended', status: 'SUSPENDED' }),
    ];

    const reasons = rankDoctors(pool, 'ga').excluded.map((entry) => entry.reason);
    expect(reasons).toContain('LANGUAGE_MISMATCH');
    expect(reasons).toContain('NOT_PRESENT');
    expect(reasons).toContain('NOT_ACTIVE');
  });
});

describe('language starvation', () => {
  it('is true when the only obstacle is language', () => {
    const pool = [candidate({ doctorId: 'a', languageCodes: ['en'] })];
    expect(isLanguageStarved(rankDoctors(pool, 'ga').excluded)).toBe(true);
  });

  it('is false when doctors are merely busy', () => {
    // "Everyone is busy" resolves itself; "nobody speaks Ga" needs an admin.
    const pool = [candidate({ doctorId: 'a', currentLoad: 1, maxLoad: 1 })];
    expect(isLanguageStarved(rankDoctors(pool, 'en').excluded)).toBe(false);
  });

  it('is false when the pool is offline rather than mismatched', () => {
    const pool = [candidate({ doctorId: 'a', present: false, languageCodes: ['en'] })];
    expect(isLanguageStarved(rankDoctors(pool, 'ga').excluded)).toBe(false);
  });

  it('is false when nobody was excluded at all', () => {
    expect(isLanguageStarved([])).toBe(false);
  });
});

describe('scoring context', () => {
  it('handles an empty pool without dividing by zero', () => {
    expect(buildScoringContext([])).toEqual({
      medianServedThisShift: 0,
      maxCompletedLast24h: 0,
      maxMedianResponseSeconds: 0,
    });
  });

  it('computes the median for an even-sized pool', () => {
    const pool = [0, 2, 4, 10].map((served, index) =>
      candidate({ doctorId: `d${index}`, servedThisShift: served }),
    );
    expect(buildScoringContext(pool).medianServedThisShift).toBe(3);
  });
});

describe('weight validation', () => {
  it('accepts the seeded defaults', () => {
    expect(() => assertWeightsValid(DEFAULT_WEIGHTS)).not.toThrow();
  });

  it('rejects weights that do not sum to 1', () => {
    expect(() => assertWeightsValid({ ...DEFAULT_WEIGHTS, quality: 0.5 })).toThrow(/sum to 1/);
  });

  it('rejects a negative weight', () => {
    expect(() => assertWeightsValid({ ...DEFAULT_WEIGHTS, quality: -0.05, language: 0.4 })).toThrow(
      /negative/,
    );
  });
});
