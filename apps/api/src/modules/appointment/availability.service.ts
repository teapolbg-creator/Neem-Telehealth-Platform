import type { PrismaClient } from '@prisma/client';
import { getPrisma, type Db } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
import { getIntSetting } from '../settings/settings.service.ts';
import { SETTING_KEYS } from '../settings/settings.defaults.ts';
import { bookableServiceRow } from '../service/service.service.ts';

/**
 * When a professional can be booked, and which minutes are still free (v2).
 *
 * A professional keeps a weekly pattern — Tuesdays 09:00 to 12:00 — and the
 * slots a patient sees are that pattern cut into consultation-length pieces,
 * minus the pieces somebody has already taken.
 *
 * The times are wall-clock strings, as shift definitions are. Ghana keeps UTC
 * all year, so local time and UTC are the same thing here; the day this
 * platform serves somewhere that is not true, this is the file that has to
 * learn about timezones, and nothing else does.
 */

export interface AvailabilityWindow {
  /** 0 = Sunday, matching `Date.getUTCDay()`. */
  weekday: number;
  startsAt: string;
  endsAt: string;
}

export interface Slot {
  startsAt: string;
  endsAt: string;
  professional: { publicId: string; fullName: string };
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

function minutesOf(time: string): number {
  const match = TIME.exec(time);
  if (!match) {
    throw errors.validation([{ field: 'startsAt', issue: `"${time}" is not a time of day.` }]);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Replaces a professional's weekly pattern with the one given.
 *
 * Replacement rather than merge, because the screen that calls this shows the
 * whole week: anything the professional removed there should be gone here.
 * Removing a window does not touch appointments already booked inside it —
 * those were promised to somebody.
 */
export async function setAvailability(
  doctorId: string,
  windows: AvailabilityWindow[],
  db: PrismaClient = getPrisma(),
): Promise<AvailabilityWindow[]> {
  for (const window of windows) {
    if (window.weekday < 0 || window.weekday > 6) {
      throw errors.validation([
        { field: 'weekday', issue: 'A weekday runs from 0 (Sunday) to 6.' },
      ]);
    }
    if (minutesOf(window.endsAt) <= minutesOf(window.startsAt)) {
      throw errors.validation([{ field: 'endsAt', issue: 'A window has to end after it starts.' }]);
    }
  }

  const overlapping = [...windows]
    .sort((a, b) => a.weekday - b.weekday || minutesOf(a.startsAt) - minutesOf(b.startsAt))
    .find(
      (window, index, sorted) =>
        index > 0 &&
        sorted[index - 1]!.weekday === window.weekday &&
        minutesOf(sorted[index - 1]!.endsAt) > minutesOf(window.startsAt),
    );
  if (overlapping) {
    throw errors.validation([{ field: 'startsAt', issue: 'Two windows on the same day overlap.' }]);
  }

  await db.$transaction(async (tx) => {
    await tx.professionalAvailability.deleteMany({ where: { doctorId } });
    for (const window of windows) {
      await tx.professionalAvailability.create({ data: { doctorId, ...window } });
    }
  });

  return listAvailability(doctorId, db);
}

export async function listAvailability(
  doctorId: string,
  db: Db = getPrisma(),
): Promise<AvailabilityWindow[]> {
  const rows = await db.professionalAvailability.findMany({
    where: { doctorId, isActive: true },
    orderBy: [{ weekday: 'asc' }, { startsAt: 'asc' }],
  });

  return rows.map((row) => ({
    weekday: row.weekday,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
  }));
}

/**
 * Every free slot for a service over the next few days.
 *
 * Only professionals of the service's discipline are considered, and only
 * those signed up to deliver it — a scheduled booking names one person, so
 * unlike the queue there is no pool to fall back on and the roster is the only
 * statement that they do this work.
 *
 * A slot is free when no live appointment holds it. `slotKey` is what is asked:
 * an expired reservation has released the slot and does not block it.
 */
export async function listSlots(
  input: { serviceCode: string; from?: Date; days?: number },
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<Slot[]> {
  const service = await bookableServiceRow(input.serviceCode, db);
  const durationSeconds =
    service.durationSeconds ??
    (await getIntSetting(SETTING_KEYS.CONSULTATION_DURATION_SECONDS, db));
  const stepMinutes = Math.max(5, Math.round(durationSeconds / 60));

  const now = clock.now();
  const from = input.from && input.from > now ? input.from : now;
  const days = Math.min(Math.max(input.days ?? 7, 1), 31);
  const until = new Date(from.getTime() + days * 86_400_000);

  const professionals = await db.doctor.findMany({
    where: {
      status: 'ACTIVE',
      discipline: service.discipline,
      services: { some: { serviceId: service.id, isActive: true } },
      availability: { some: { isActive: true } },
    },
    select: {
      id: true,
      publicId: true,
      fullName: true,
      availability: { where: { isActive: true } },
    },
  });

  const taken = await db.appointment.findMany({
    where: {
      doctorId: { in: professionals.map((professional) => professional.id) },
      slotKey: { not: null },
      startsAt: { gte: from, lt: until },
    },
    select: { doctorId: true, startsAt: true },
  });

  const held = new Set(taken.map((row) => `${row.doctorId}@${row.startsAt.toISOString()}`));
  const slots: Slot[] = [];

  for (const professional of professionals) {
    for (let day = new Date(startOfUtcDay(from)); day < until; day = addDays(day, 1)) {
      for (const window of professional.availability) {
        if (window.weekday !== day.getUTCDay()) continue;

        const opens = minutesOf(window.startsAt);
        const closes = minutesOf(window.endsAt);

        for (let minute = opens; minute + stepMinutes <= closes; minute += stepMinutes) {
          const startsAt = new Date(day.getTime() + minute * 60_000);
          if (startsAt < from || startsAt >= until) continue;
          if (held.has(`${professional.id}@${startsAt.toISOString()}`)) continue;

          slots.push({
            startsAt: startsAt.toISOString(),
            endsAt: new Date(startsAt.getTime() + stepMinutes * 60_000).toISOString(),
            professional: { publicId: professional.publicId, fullName: professional.fullName },
          });
        }
      }
    }
  }

  return slots.sort(
    (a, b) =>
      Date.parse(a.startsAt) - Date.parse(b.startsAt) ||
      a.professional.publicId.localeCompare(b.professional.publicId),
  );
}

/**
 * Whether a professional's pattern actually contains this exact slot.
 *
 * Asked again when the booking arrives, rather than trusting that the slot
 * came from a listing: a listing is a screenshot of a moment, and the window
 * may have been withdrawn since.
 */
export async function slotIsOffered(
  doctorId: string,
  startsAt: Date,
  stepMinutes: number,
  db: Db = getPrisma(),
): Promise<boolean> {
  const windows = await db.professionalAvailability.findMany({
    where: { doctorId, isActive: true, weekday: startsAt.getUTCDay() },
  });

  const minute = startsAt.getUTCHours() * 60 + startsAt.getUTCMinutes();
  if (startsAt.getUTCSeconds() !== 0 || startsAt.getUTCMilliseconds() !== 0) return false;

  return windows.some((window) => {
    const opens = minutesOf(window.startsAt);
    const closes = minutesOf(window.endsAt);

    // On the grid the listing generates, and wholly inside the window.
    return (
      minute >= opens && (minute - opens) % stepMinutes === 0 && minute + stepMinutes <= closes
    );
  });
}

/** The length of one appointment for a service, in minutes. */
export async function slotMinutes(
  service: { durationSeconds: number | null },
  db: Db = getPrisma(),
): Promise<number> {
  const durationSeconds =
    service.durationSeconds ??
    (await getIntSetting(SETTING_KEYS.CONSULTATION_DURATION_SECONDS, db));
  return Math.max(5, Math.round(durationSeconds / 60));
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}
