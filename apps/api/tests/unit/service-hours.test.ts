import { describe, expect, it } from 'vitest';
import {
  checkServiceHours,
  formatHours,
  isoWeekOf,
  isoWeeksEqual,
  shiftDurationMinutes,
  shiftsOverlap,
} from '../../src/domain/service-hours.ts';

/**
 * The 40-hour weekly ceiling (spec §25) and the shift arithmetic it depends on.
 *
 * Getting ISO weeks or midnight-crossing shifts wrong would silently let a
 * doctor exceed the limit, so these are tested at the boundaries rather than
 * on happy-path values only.
 */

describe('shiftDurationMinutes', () => {
  it('measures the seeded pilot shifts', () => {
    expect(shiftDurationMinutes('08:00', '14:00')).toBe(360); // Morning, 6h
    expect(shiftDurationMinutes('14:00', '20:00')).toBe(360); // Afternoon, 6h
  });

  it('measures a shift that crosses midnight', () => {
    // The future night shift, 20:00–08:00, is 12 hours — not minus 12.
    expect(shiftDurationMinutes('20:00', '08:00')).toBe(720);
    expect(shiftDurationMinutes('23:30', '00:30')).toBe(60);
  });

  it('treats an identical start and end as a full day, not zero', () => {
    expect(shiftDurationMinutes('08:00', '08:00')).toBe(1440);
  });

  it('rejects malformed times rather than silently coercing them', () => {
    expect(() => shiftDurationMinutes('8:00', '14:00')).toThrow();
    expect(() => shiftDurationMinutes('24:00', '08:00')).toThrow();
    expect(() => shiftDurationMinutes('08:60', '14:00')).toThrow();
    expect(() => shiftDurationMinutes('', '14:00')).toThrow();
  });
});

describe('isoWeekOf', () => {
  it('computes ordinary mid-year weeks', () => {
    expect(isoWeekOf(new Date('2026-06-15T00:00:00Z'))).toEqual({ isoYear: 2026, isoWeek: 25 });
  });

  it('assigns early-January days to the previous ISO year where correct', () => {
    // 1 Jan 2027 is a Friday, so it belongs to ISO week 53 of 2026. Counting it
    // in 2027 week 1 would reset a doctor's hours mid-week.
    expect(isoWeekOf(new Date('2027-01-01T00:00:00Z'))).toEqual({ isoYear: 2026, isoWeek: 53 });
  });

  it('assigns late-December days to the next ISO year where correct', () => {
    // 31 Dec 2029 is a Monday — ISO week 1 of 2030.
    expect(isoWeekOf(new Date('2029-12-31T00:00:00Z'))).toEqual({ isoYear: 2030, isoWeek: 1 });
  });

  it('groups a Monday and the following Sunday into the same week', () => {
    const monday = isoWeekOf(new Date('2026-08-24T00:00:00Z'));
    const sunday = isoWeekOf(new Date('2026-08-30T00:00:00Z'));
    expect(isoWeeksEqual(monday, sunday)).toBe(true);
  });

  it('puts the next Monday into a different week', () => {
    const sunday = isoWeekOf(new Date('2026-08-30T00:00:00Z'));
    const monday = isoWeekOf(new Date('2026-08-31T00:00:00Z'));
    expect(isoWeeksEqual(sunday, monday)).toBe(false);
  });
});

describe('checkServiceHours — the 40-hour ceiling', () => {
  const LIMIT = 40;

  it('allows an assignment that stays under the limit', () => {
    const result = checkServiceHours({
      currentMinutes: 30 * 60,
      requestedMinutes: 360,
      maxHoursPerWeek: LIMIT,
    });

    expect(result.allowed).toBe(true);
    expect(result.resultingMinutes).toBe(36 * 60);
    expect(result.remainingMinutes).toBe(10 * 60);
  });

  it('allows landing exactly on the limit', () => {
    // A doctor contracted for exactly 40 hours must be schedulable for 40.
    const result = checkServiceHours({
      currentMinutes: 34 * 60,
      requestedMinutes: 360,
      maxHoursPerWeek: LIMIT,
    });

    expect(result.allowed).toBe(true);
    expect(result.resultingMinutes).toBe(40 * 60);
    expect(result.remainingMinutes).toBe(6 * 60);
  });

  it('refuses one minute over the limit', () => {
    const result = checkServiceHours({
      currentMinutes: 40 * 60,
      requestedMinutes: 1,
      maxHoursPerWeek: LIMIT,
    });

    expect(result.allowed).toBe(false);
    expect(result.remainingMinutes).toBe(0);
  });

  it('refuses a seventh six-hour shift in one week', () => {
    // Six 6-hour shifts is 36h; a seventh would be 42h.
    const afterSix = 6 * 360;
    expect(checkServiceHours({ currentMinutes: afterSix, requestedMinutes: 360, maxHoursPerWeek: LIMIT }).allowed).toBe(
      false,
    );
  });

  it('reports remaining capacity so the UI can explain the refusal', () => {
    const result = checkServiceHours({
      currentMinutes: 38 * 60,
      requestedMinutes: 360,
      maxHoursPerWeek: LIMIT,
    });

    expect(result.allowed).toBe(false);
    expect(result.remainingMinutes).toBe(120);
    expect(formatHours(result.remainingMinutes)).toBe('2h');
  });

  it('honours a reconfigured limit, since the rule is a setting not a constant', () => {
    const result = checkServiceHours({
      currentMinutes: 40 * 60,
      requestedMinutes: 360,
      maxHoursPerWeek: 48,
    });
    expect(result.allowed).toBe(true);
  });

  it('never reports negative remaining capacity', () => {
    const result = checkServiceHours({
      currentMinutes: 100 * 60,
      requestedMinutes: 60,
      maxHoursPerWeek: LIMIT,
    });
    expect(result.remainingMinutes).toBe(0);
  });

  it('rejects nonsensical inputs instead of producing a wrong answer', () => {
    expect(() => checkServiceHours({ currentMinutes: 0, requestedMinutes: -60, maxHoursPerWeek: LIMIT })).toThrow();
    expect(() => checkServiceHours({ currentMinutes: 0, requestedMinutes: 60, maxHoursPerWeek: 0 })).toThrow();
  });
});

describe('shiftsOverlap', () => {
  it('detects an exact clash', () => {
    expect(shiftsOverlap({ startsAt: '08:00', endsAt: '14:00' }, { startsAt: '08:00', endsAt: '14:00' })).toBe(true);
  });

  it('detects a partial clash', () => {
    expect(shiftsOverlap({ startsAt: '08:00', endsAt: '14:00' }, { startsAt: '13:00', endsAt: '18:00' })).toBe(true);
  });

  it('treats back-to-back shifts as non-overlapping', () => {
    // Morning ends exactly when Afternoon begins — that is a legitimate
    // 12-hour day, not a double booking.
    expect(shiftsOverlap({ startsAt: '08:00', endsAt: '14:00' }, { startsAt: '14:00', endsAt: '20:00' })).toBe(false);
  });

  it('treats separated shifts as non-overlapping', () => {
    expect(shiftsOverlap({ startsAt: '08:00', endsAt: '12:00' }, { startsAt: '14:00', endsAt: '20:00' })).toBe(false);
  });
});

describe('formatHours', () => {
  it('formats whole and partial hours', () => {
    expect(formatHours(0)).toBe('0h');
    expect(formatHours(360)).toBe('6h');
    expect(formatHours(150)).toBe('2h 30m');
  });
});
