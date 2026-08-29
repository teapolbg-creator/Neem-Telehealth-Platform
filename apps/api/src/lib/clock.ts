/**
 * Injectable clock.
 *
 * Time-dependent rules — the 5-minute payment window, the 90-second doctor
 * response window, session expiry, the 40-hour weekly ceiling, subscription
 * expiry — must be testable without sleeping. Nothing in the codebase calls
 * `new Date()` directly; everything takes a Clock.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** Test seam: a clock that can be positioned and advanced deterministically. */
export function fixedClock(start: Date | string | number): Clock & {
  advance(ms: number): void;
  set(to: Date | string | number): void;
} {
  let current = new Date(start);
  return {
    now: () => new Date(current),
    advance: (ms) => {
      current = new Date(current.getTime() + ms);
    },
    set: (to) => {
      current = new Date(to);
    },
  };
}

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function addMinutes(from: Date, minutes: number): Date {
  return new Date(from.getTime() + minutes * MINUTE);
}

export function addHours(from: Date, hours: number): Date {
  return new Date(from.getTime() + hours * HOUR);
}

export function addSeconds(from: Date, seconds: number): Date {
  return new Date(from.getTime() + seconds * SECOND);
}

export function isPast(date: Date, clock: Clock = systemClock): boolean {
  return date.getTime() <= clock.now().getTime();
}
