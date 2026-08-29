/**
 * Doctor working-hours rules (spec §25).
 *
 * "The system must technically prevent scheduling beyond 40 hours/week."
 * That is enforced here as a pure calculation, and applied by the scheduling
 * service *inside the assignment transaction* so two concurrent assignments
 * cannot both pass the check and jointly exceed the ceiling.
 *
 * The limit is configurable (`doctor.maxServiceHoursPerWeek`) because the
 * specification calls it a workforce rule, not a constant.
 */

export interface IsoWeek {
  isoYear: number;
  isoWeek: number;
}

/**
 * ISO-8601 week number.
 *
 * Weeks run Monday–Sunday, and week 1 is the week containing the first
 * Thursday of the year. This matters: a shift on 1 January can legitimately
 * belong to the final week of the previous ISO year, and counting it in the
 * wrong bucket would let a doctor exceed the ceiling across a year boundary.
 */
export function isoWeekOf(date: Date): IsoWeek {
  // Work in UTC so the result does not shift with the server's timezone.
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

  // ISO days run Monday=1 … Sunday=7.
  const dayNumber = target.getUTCDay() === 0 ? 7 : target.getUTCDay();

  // Shift to the Thursday of this week; the year of that Thursday is the ISO year.
  target.setUTCDate(target.getUTCDate() + 4 - dayNumber);
  const isoYear = target.getUTCFullYear();

  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstThursdayDayNumber = firstThursday.getUTCDay() === 0 ? 7 : firstThursday.getUTCDay();
  firstThursday.setUTCDate(firstThursday.getUTCDate() + 4 - firstThursdayDayNumber);

  const isoWeek =
    1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000));

  return { isoYear, isoWeek };
}

export function isoWeeksEqual(a: IsoWeek, b: IsoWeek): boolean {
  return a.isoYear === b.isoYear && a.isoWeek === b.isoWeek;
}

/**
 * Minutes covered by a shift, handling one that crosses midnight.
 *
 * The night shift (20:00–08:00) is seeded inactive for the pilot, but the
 * calculation has to be right before it is switched on — an off-by-a-day error
 * there would silently under-count 12 hours of work.
 */
export function shiftDurationMinutes(startsAt: string, endsAt: string): number {
  const start = parseTimeOfDay(startsAt);
  const end = parseTimeOfDay(endsAt);

  const raw = end - start;
  return raw > 0 ? raw : raw + 24 * 60;
}

function parseTimeOfDay(value: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) {
    throw new Error(`Invalid time of day "${value}" — expected HH:MM in 24-hour form`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

export interface ServiceHoursCheck {
  allowed: boolean;
  currentMinutes: number;
  requestedMinutes: number;
  resultingMinutes: number;
  limitMinutes: number;
  remainingMinutes: number;
}

/**
 * Decides whether adding `requestedMinutes` keeps a doctor within the weekly
 * ceiling.
 *
 * Boundary rule: landing exactly on the limit is allowed; exceeding it is not.
 * A doctor contracted for exactly 40 hours must be schedulable for 40 hours.
 */
export function checkServiceHours(params: {
  currentMinutes: number;
  requestedMinutes: number;
  maxHoursPerWeek: number;
}): ServiceHoursCheck {
  const { currentMinutes, requestedMinutes, maxHoursPerWeek } = params;

  if (requestedMinutes < 0) {
    throw new Error('Requested minutes cannot be negative');
  }
  if (maxHoursPerWeek <= 0) {
    throw new Error('Weekly hour limit must be positive');
  }

  const limitMinutes = Math.round(maxHoursPerWeek * 60);
  const resultingMinutes = currentMinutes + requestedMinutes;

  return {
    allowed: resultingMinutes <= limitMinutes,
    currentMinutes,
    requestedMinutes,
    resultingMinutes,
    limitMinutes,
    remainingMinutes: Math.max(0, limitMinutes - currentMinutes),
  };
}

export function formatHours(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
}

/**
 * Detects an overlap between two shifts on the same service date.
 *
 * Separate from the weekly ceiling: a doctor could be under 40 hours and still
 * be double-booked, which is a scheduling error regardless of total hours.
 */
export function shiftsOverlap(
  a: { startsAt: string; endsAt: string },
  b: { startsAt: string; endsAt: string },
): boolean {
  const aStart = parseTimeOfDay(a.startsAt);
  const aEnd = aStart + shiftDurationMinutes(a.startsAt, a.endsAt);
  const bStart = parseTimeOfDay(b.startsAt);
  const bEnd = bStart + shiftDurationMinutes(b.startsAt, b.endsAt);

  return aStart < bEnd && bStart < aEnd;
}
