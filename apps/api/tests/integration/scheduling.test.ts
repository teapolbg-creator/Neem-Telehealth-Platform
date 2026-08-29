import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getPrisma, disconnectPrisma } from '../../src/db/prisma.ts';
import { assignShift } from '../../src/modules/scheduling/scheduling.service.ts';
import { closeTestApp, request, signIn } from '../helpers/app.ts';
import { createTestDoctor, resetDatabase } from '../helpers/database.ts';

/**
 * The 40-hour weekly ceiling, enforced against a real database (spec §25).
 *
 * The unit tests cover the arithmetic. These cover the part that only a real
 * database can verify: that the limit holds under concurrency, and that
 * cancelling a shift returns its hours to the budget.
 */

const ADMIN_ID = 'admin-test-id';

/** Monday of an ordinary mid-year ISO week, so no year-boundary effects. */
const MONDAY = '2026-09-07';
const WEEKDAYS = [
  '2026-09-07',
  '2026-09-08',
  '2026-09-09',
  '2026-09-10',
  '2026-09-11',
  '2026-09-12',
  '2026-09-13',
];

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeTestApp();
  await disconnectPrisma();
});

describe('shift assignment', () => {
  it('assigns a shift and records the planned minutes', async () => {
    const { doctor } = await createTestDoctor('Dr. Scheduler');

    const result = await assignShift(
      { doctorPublicId: doctor.publicId, shiftCode: 'MORNING', serviceDate: MONDAY },
      { adminId: ADMIN_ID },
    );

    expect(result.minutesPlanned).toBe(360);
    expect(result.weeklyMinutesScheduled).toBe(360);
    expect(result.weeklyLimitMinutes).toBe(2400);
  });

  it('allows six 6-hour shifts — 36h, the most the seeded shifts can reach', async () => {
    const { doctor } = await createTestDoctor('Dr. Full');

    for (let index = 0; index < 6; index += 1) {
      await assignShift(
        { doctorPublicId: doctor.publicId, shiftCode: 'MORNING', serviceDate: WEEKDAYS[index]! },
        { adminId: ADMIN_ID },
      );
    }

    const hours = await getPrisma().doctorServiceHours.findFirstOrThrow();
    expect(hours.minutesScheduled).toBe(36 * 60);
  });

  it('refuses the seventh shift, which would reach 42h', async () => {
    const { doctor } = await createTestDoctor('Dr. Overworked');

    // Six morning shifts = 36h. A seventh 6-hour shift would be 42h > 40h.
    for (let index = 0; index < 6; index += 1) {
      await assignShift(
        { doctorPublicId: doctor.publicId, shiftCode: 'MORNING', serviceDate: WEEKDAYS[index]! },
        { adminId: ADMIN_ID },
      );
    }

    await expect(
      assignShift(
        { doctorPublicId: doctor.publicId, shiftCode: 'AFTERNOON', serviceDate: WEEKDAYS[0]! },
        { adminId: ADMIN_ID },
      ),
    ).rejects.toThrow(/weekly limit/i);

    // The refused assignment must leave the counter untouched.
    const hours = await getPrisma().doctorServiceHours.findFirstOrThrow();
    expect(hours.minutesScheduled).toBe(36 * 60);
  });

  it('holds the ceiling under concurrent assignment (the race the spec implies)', async () => {
    const { doctor } = await createTestDoctor('Dr. Concurrent');

    // Pre-load to 30h, leaving room for exactly ONE more 6-hour shift:
    // 30 + 6 = 36 (allowed), 30 + 6 + 6 = 42 (not allowed).
    for (let index = 0; index < 5; index += 1) {
      await assignShift(
        { doctorPublicId: doctor.publicId, shiftCode: 'MORNING', serviceDate: WEEKDAYS[index]! },
        { adminId: ADMIN_ID },
      );
    }

    // Two admins assign at the same moment. A naive read-then-write would let
    // both through and land the doctor at 42h.
    const results = await Promise.allSettled([
      assignShift(
        { doctorPublicId: doctor.publicId, shiftCode: 'AFTERNOON', serviceDate: WEEKDAYS[0]! },
        { adminId: ADMIN_ID },
      ),
      assignShift(
        { doctorPublicId: doctor.publicId, shiftCode: 'AFTERNOON', serviceDate: WEEKDAYS[1]! },
        { adminId: ADMIN_ID },
      ),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);

    const hours = await getPrisma().doctorServiceHours.findFirstOrThrow();
    expect(hours.minutesScheduled).toBe(36 * 60);
    expect(hours.minutesScheduled).toBeLessThanOrEqual(2400);
  });

  it('refuses a doctor double-booked on the same day', async () => {
    const { doctor } = await createTestDoctor('Dr. Clash');

    await assignShift(
      { doctorPublicId: doctor.publicId, shiftCode: 'MORNING', serviceDate: MONDAY },
      { adminId: ADMIN_ID },
    );

    await expect(
      assignShift(
        { doctorPublicId: doctor.publicId, shiftCode: 'MORNING', serviceDate: MONDAY },
        { adminId: ADMIN_ID },
      ),
    ).rejects.toThrow();
  });

  it('permits back-to-back morning and afternoon shifts on one day', async () => {
    const { doctor } = await createTestDoctor('Dr. LongDay');

    await assignShift(
      { doctorPublicId: doctor.publicId, shiftCode: 'MORNING', serviceDate: MONDAY },
      { adminId: ADMIN_ID },
    );
    const second = await assignShift(
      { doctorPublicId: doctor.publicId, shiftCode: 'AFTERNOON', serviceDate: MONDAY },
      { adminId: ADMIN_ID },
    );

    expect(second.weeklyMinutesScheduled).toBe(720);
  });

  it('refuses to schedule a doctor who is not approved', async () => {
    const { doctor } = await createTestDoctor('Dr. Pending', 'PENDING');

    await expect(
      assignShift(
        { doctorPublicId: doctor.publicId, shiftCode: 'MORNING', serviceDate: MONDAY },
        { adminId: ADMIN_ID },
      ),
    ).rejects.toThrow(/approved or active/i);
  });

  it('refuses the inactive night shift', async () => {
    // NIGHT is seeded inactive — a future expansion, not part of the pilot.
    const { doctor } = await createTestDoctor('Dr. Night');

    await expect(
      assignShift(
        { doctorPublicId: doctor.publicId, shiftCode: 'NIGHT', serviceDate: MONDAY },
        { adminId: ADMIN_ID },
      ),
    ).rejects.toThrow(/not currently in operation/i);
  });

  it('counts hours per ISO week, not per rolling seven days', async () => {
    const { doctor } = await createTestDoctor('Dr. Boundary');

    // Sunday 2026-09-13 is the end of one ISO week; Monday 2026-09-14 starts
    // the next, so the budget resets rather than carrying over.
    await assignShift(
      { doctorPublicId: doctor.publicId, shiftCode: 'MORNING', serviceDate: '2026-09-13' },
      { adminId: ADMIN_ID },
    );
    await assignShift(
      { doctorPublicId: doctor.publicId, shiftCode: 'MORNING', serviceDate: '2026-09-14' },
      { adminId: ADMIN_ID },
    );

    const weeks = await getPrisma().doctorServiceHours.findMany({ orderBy: { isoWeek: 'asc' } });
    expect(weeks).toHaveLength(2);
    expect(weeks[0]!.minutesScheduled).toBe(360);
    expect(weeks[1]!.minutesScheduled).toBe(360);
  });
});

describe('shift cancellation', () => {
  it('returns cancelled hours to the weekly budget', async () => {
    const { doctor } = await createTestDoctor('Dr. Cancel');

    const assignment = await assignShift(
      { doctorPublicId: doctor.publicId, shiftCode: 'MORNING', serviceDate: MONDAY },
      { adminId: ADMIN_ID },
    );

    const { cancelShift } = await import('../../src/modules/scheduling/scheduling.service.ts');
    await cancelShift(assignment.id, { actorType: 'ADMIN', actorId: ADMIN_ID, reason: 'Rota change' });

    const hours = await getPrisma().doctorServiceHours.findFirstOrThrow();
    expect(hours.minutesScheduled).toBe(0);
  });

  it('frees capacity so a previously blocked assignment succeeds', async () => {
    const { doctor } = await createTestDoctor('Dr. Freed');
    const { cancelShift } = await import('../../src/modules/scheduling/scheduling.service.ts');

    const assignments = [];
    for (let index = 0; index < 6; index += 1) {
      assignments.push(
        await assignShift(
          { doctorPublicId: doctor.publicId, shiftCode: 'MORNING', serviceDate: WEEKDAYS[index]! },
          { adminId: ADMIN_ID },
        ),
      );
    }

    // At 36h, a seventh shift would reach 42h and is refused.
    await expect(
      assignShift(
        { doctorPublicId: doctor.publicId, shiftCode: 'AFTERNOON', serviceDate: WEEKDAYS[0]! },
        { adminId: ADMIN_ID },
      ),
    ).rejects.toThrow(/weekly limit/i);

    await cancelShift(assignments[0]!.id, { actorType: 'ADMIN', actorId: ADMIN_ID });

    // Back to 30h — the same assignment now fits, at 36h.
    const result = await assignShift(
      { doctorPublicId: doctor.publicId, shiftCode: 'AFTERNOON', serviceDate: WEEKDAYS[0]! },
      { adminId: ADMIN_ID },
    );
    expect(result.weeklyMinutesScheduled).toBe(36 * 60);
  });
});

/**
 * What a doctor sees on their own shift screen.
 *
 * `serviceDate` is a date at midnight UTC, so a range starting at the current
 * instant excludes today's own shift for all but the first hour of the day. A
 * doctor signing in at 09:00 could not see, let alone confirm, the shift they
 * were about to work — and unconfirmed means ineligible for allocation.
 */
describe('a doctor’s own shift list', () => {
  it('includes today’s shift when read part-way through the day', async () => {
    const { user, doctor } = await createTestDoctor('Dr. Today', 'ACTIVE');

    const today = new Date();
    const serviceDate = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
    )
      .toISOString()
      .slice(0, 10);

    await assignShift(
      { doctorPublicId: doctor.publicId, shiftCode: 'MORNING', serviceDate },
      { adminId: ADMIN_ID },
    );

    const cookies = await signIn(user.email, 'TestPassword123!');
    const response = await request<{ shifts: Array<{ serviceDate: string }> }>('/doctor/shifts', {
      cookies,
    });

    expect(response.status).toBe(200);
    expect(
      response.body.data?.shifts.map((shift) => shift.serviceDate),
      'today’s shift must be visible so the doctor can confirm it',
    ).toContain(serviceDate);
  });
});
