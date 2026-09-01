/**
 * Doctor compensation (spec §26, decision D28).
 *
 * > A full-time doctor working 40 hours is paid GHS 8,000 monthly. For
 * > part-time doctors, monthly compensation = GHS 8,000 × (contracted weekly
 * > hours ÷ 40).
 *
 * A pure function, so payroll arithmetic can be reasoned about and tested
 * without a database — the same treatment `splitRevenue` gets, and for the same
 * reason: money that is computed wrong is worse than money that is not
 * computed at all.
 *
 * **Neem never transfers doctor salary.** This produces a figure for a human to
 * act on (spec §26). That boundary is the difference between a reporting
 * feature and a payroll system, and Neem is not a payroll system.
 */

export interface CompensationInput {
  /** Monthly pay for a doctor working the full contracted week, in pesewas. */
  fullTimeMonthlyMinor: number;
  /** Hours that constitute a full week. Configured, not assumed to be 40. */
  fullTimeHoursPerWeek: number;
  /** The doctor's contracted hours. */
  contractedHoursPerWeek: number;
}

export interface Compensation {
  /** What the doctor is owed this month, in pesewas, rounded down. */
  monthlyMinor: number;
  /**
   * The fraction of a pesewa lost to rounding, as a numerator over
   * `fullTimeHoursPerWeek`. Reported rather than discarded so that whoever
   * runs payroll can see it, however small.
   */
  remainderNumerator: number;
  /** The proportion of a full week this doctor works, for display. */
  fraction: number;
  /** True when the doctor works the full contracted week. */
  isFullTime: boolean;
}

export class InvalidCompensationInput extends Error {}

/**
 * Computes a doctor's monthly compensation.
 *
 * Rounds **down** to the pesewa. At the seeded values the arithmetic is exact —
 * GHS 8,000 over 40 hours is exactly 20,000 pesewas an hour, so any whole
 * number of hours divides cleanly — but that will not survive the first change
 * to either setting, so the remainder is resolved deliberately rather than left
 * to whichever way a float happens to fall.
 *
 * Rounding down means a doctor is never paid more than the formula yields. The
 * shortfall is at most one pesewa and is returned, not swallowed.
 */
export function computeMonthlyCompensation(input: CompensationInput): Compensation {
  const { fullTimeMonthlyMinor, fullTimeHoursPerWeek, contractedHoursPerWeek } = input;

  if (!Number.isInteger(fullTimeMonthlyMinor) || fullTimeMonthlyMinor < 0) {
    throw new InvalidCompensationInput(
      'Full-time monthly pay must be a whole, non-negative number of pesewas.',
    );
  }
  if (!Number.isInteger(fullTimeHoursPerWeek) || fullTimeHoursPerWeek <= 0) {
    throw new InvalidCompensationInput('A full week must be a positive whole number of hours.');
  }
  if (!Number.isInteger(contractedHoursPerWeek) || contractedHoursPerWeek < 0) {
    throw new InvalidCompensationInput(
      'Contracted hours must be a whole, non-negative number of hours.',
    );
  }

  /**
   * Contracted hours above a full week do not increase pay.
   *
   * The 40-hour ceiling is enforced when a shift is assigned (spec §25), so
   * this should be unreachable — but a compensation function that silently
   * multiplied pay for an over-contracted doctor would turn a scheduling bug
   * into a payroll one.
   */
  if (contractedHoursPerWeek > fullTimeHoursPerWeek) {
    throw new InvalidCompensationInput(
      `Contracted hours (${contractedHoursPerWeek}) exceed a full week (${fullTimeHoursPerWeek}). ` +
        'The weekly ceiling should have prevented this.',
    );
  }

  // Integer arithmetic throughout: multiply first, then divide, so no
  // intermediate float can introduce error (spec §98, decision D5).
  const scaled = fullTimeMonthlyMinor * contractedHoursPerWeek;
  const monthlyMinor = Math.floor(scaled / fullTimeHoursPerWeek);
  const remainderNumerator = scaled % fullTimeHoursPerWeek;

  return {
    monthlyMinor,
    remainderNumerator,
    fraction: contractedHoursPerWeek / fullTimeHoursPerWeek,
    isFullTime: contractedHoursPerWeek === fullTimeHoursPerWeek,
  };
}
