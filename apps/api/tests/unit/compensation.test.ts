import { describe, expect, it } from 'vitest';
import {
  computeMonthlyCompensation,
  InvalidCompensationInput,
} from '../../src/domain/compensation.ts';

/**
 * Doctor compensation (spec §26, decision D28).
 *
 * The seeded values: GHS 8,000 monthly for a 40-hour week, held in pesewas.
 */
const FULL_TIME = { fullTimeMonthlyMinor: 800_000, fullTimeHoursPerWeek: 40 };

describe('the stated formula', () => {
  it('pays a full-time doctor the full amount', () => {
    const result = computeMonthlyCompensation({ ...FULL_TIME, contractedHoursPerWeek: 40 });

    expect(result.monthlyMinor).toBe(800_000);
    expect(result.isFullTime).toBe(true);
    expect(result.remainderNumerator).toBe(0);
  });

  it('pays half for half a week', () => {
    const result = computeMonthlyCompensation({ ...FULL_TIME, contractedHoursPerWeek: 20 });

    expect(result.monthlyMinor).toBe(400_000);
    expect(result.fraction).toBe(0.5);
    expect(result.isFullTime).toBe(false);
  });

  it.each([
    [40, 800_000],
    [37, 740_000],
    [30, 600_000],
    [25, 500_000],
    [20, 400_000],
    [16, 320_000],
    [12, 240_000],
    [8, 160_000],
    [1, 20_000],
    [0, 0],
  ])('pays %i contracted hours as %i pesewas', (hours, expected) => {
    expect(
      computeMonthlyCompensation({ ...FULL_TIME, contractedHoursPerWeek: hours }).monthlyMinor,
    ).toBe(expected);
  });

  it('divides exactly at the seeded values, for every whole hour', () => {
    // GHS 8,000 over 40 hours is exactly 20,000 pesewas an hour, so nothing
    // rounds today. The tests below cover what happens when that stops being
    // true — which it will, the first time either setting changes.
    for (let hours = 0; hours <= 40; hours += 1) {
      expect(
        computeMonthlyCompensation({ ...FULL_TIME, contractedHoursPerWeek: hours })
          .remainderNumerator,
      ).toBe(0);
    }
  });
});

describe('rounding, once the settings stop dividing cleanly', () => {
  it('rounds down, so a doctor is never paid more than the formula yields', () => {
    // GHS 8,000.01 over 40 hours does not divide evenly at 3 hours.
    const result = computeMonthlyCompensation({
      fullTimeMonthlyMinor: 800_001,
      fullTimeHoursPerWeek: 40,
      contractedHoursPerWeek: 3,
    });

    // 800001 × 3 = 2400003; ÷ 40 = 60000.075
    expect(result.monthlyMinor).toBe(60_000);
  });

  it('reports the shortfall rather than discarding it', () => {
    const result = computeMonthlyCompensation({
      fullTimeMonthlyMinor: 800_001,
      fullTimeHoursPerWeek: 40,
      contractedHoursPerWeek: 3,
    });

    // 2400003 mod 40 = 3, so three fortieths of a pesewa were lost.
    expect(result.remainderNumerator).toBe(3);
  });

  it('never loses more than one pesewa', () => {
    for (let hours = 1; hours <= 40; hours += 1) {
      const result = computeMonthlyCompensation({
        fullTimeMonthlyMinor: 799_997,
        fullTimeHoursPerWeek: 40,
        contractedHoursPerWeek: hours,
      });

      expect(result.remainderNumerator).toBeLessThan(40);
    }
  });

  it('is exact under integer arithmetic, with no float drift', () => {
    // A deliberately awkward pairing: a prime-ish rate over an odd week.
    const result = computeMonthlyCompensation({
      fullTimeMonthlyMinor: 1_000_003,
      fullTimeHoursPerWeek: 37,
      contractedHoursPerWeek: 13,
    });

    const exact = 1_000_003 * 13;
    expect(result.monthlyMinor * 37 + result.remainderNumerator).toBe(exact);
  });
});

describe('refusals', () => {
  it('refuses contracted hours above a full week', () => {
    // The 40-hour ceiling is enforced at shift assignment (spec §25). If a
    // doctor somehow reaches this function over-contracted, that is a
    // scheduling bug, and multiplying their pay would turn it into a payroll
    // one.
    expect(() => computeMonthlyCompensation({ ...FULL_TIME, contractedHoursPerWeek: 41 })).toThrow(
      InvalidCompensationInput,
    );
  });

  it('refuses fractional pesewas', () => {
    expect(() =>
      computeMonthlyCompensation({
        fullTimeMonthlyMinor: 800_000.5,
        fullTimeHoursPerWeek: 40,
        contractedHoursPerWeek: 20,
      }),
    ).toThrow(InvalidCompensationInput);
  });

  it('refuses fractional hours', () => {
    expect(() =>
      computeMonthlyCompensation({ ...FULL_TIME, contractedHoursPerWeek: 17.5 }),
    ).toThrow(InvalidCompensationInput);
  });

  it('refuses a negative amount', () => {
    expect(() =>
      computeMonthlyCompensation({
        fullTimeMonthlyMinor: -1,
        fullTimeHoursPerWeek: 40,
        contractedHoursPerWeek: 20,
      }),
    ).toThrow(InvalidCompensationInput);
  });

  it('refuses a zero-hour full week, which would divide by zero', () => {
    expect(() =>
      computeMonthlyCompensation({
        fullTimeMonthlyMinor: 800_000,
        fullTimeHoursPerWeek: 0,
        contractedHoursPerWeek: 0,
      }),
    ).toThrow(InvalidCompensationInput);
  });
});
