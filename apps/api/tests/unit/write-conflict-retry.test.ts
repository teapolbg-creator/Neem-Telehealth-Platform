import { describe, expect, it, vi } from 'vitest';
import { Prisma, isWriteConflictError, withWriteConflictRetry } from '../../src/db/prisma.ts';

/**
 * Deadlock retry (found in Phase 11).
 *
 * `offerNextDoctor` writes four rows across three tables, and the ten-second
 * queue sweep can be doing that for the same consultation as an
 * administrator's manual reallocation. InnoDB breaks the tie by rolling one
 * transaction back with `P2034`, whose message ends "Please retry your
 * transaction". Nothing retried: the offer was lost, a paid patient waiting in
 * the queue was offered to nobody, and on the request path the administrator
 * got a 500.
 *
 * Tested here rather than through the queue because a deadlock cannot be
 * provoked reliably from the outside — which is exactly why it went unnoticed
 * until an end-to-end run on a clean checkout happened to lose the race.
 */

function writeConflict(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    'Transaction failed due to a write conflict or a deadlock. Please retry your transaction',
    { code: 'P2034', clientVersion: 'test' },
  );
}

function uniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

describe('recognising a write conflict', () => {
  it('recognises P2034', () => {
    expect(isWriteConflictError(writeConflict())).toBe(true);
  });

  it('does not mistake a unique-constraint violation for one', () => {
    // The distinction matters: a duplicate means the work is already done and
    // retrying it will fail identically forever.
    expect(isWriteConflictError(uniqueViolation())).toBe(false);
  });

  it('does not treat an ordinary error as retryable', () => {
    expect(isWriteConflictError(new Error('connection reset'))).toBe(false);
    expect(isWriteConflictError(undefined)).toBe(false);
  });
});

describe('retrying a transaction the database rolled back', () => {
  it('succeeds on a retry after one deadlock', async () => {
    let calls = 0;
    const result = await withWriteConflictRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw writeConflict();
        return 'offered';
      },
      { baseDelayMs: 1 },
    );

    expect(result).toBe('offered');
    expect(calls).toBe(2);
  });

  it('does not retry work that succeeded', async () => {
    const work = vi.fn(async () => 'offered');
    await withWriteConflictRetry(work, { baseDelayMs: 1 });
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('gives up after the configured number of attempts, and still throws', async () => {
    // A bounded retry makes a lost offer unlikely, not impossible. The caller
    // must still see the failure rather than a silent success.
    let calls = 0;
    await expect(
      withWriteConflictRetry(
        async () => {
          calls += 1;
          throw writeConflict();
        },
        { attempts: 3, baseDelayMs: 1 },
      ),
    ).rejects.toMatchObject({ code: 'P2034' });

    expect(calls).toBe(3);
  });

  it('does not retry an error that is not a write conflict', async () => {
    let calls = 0;
    await expect(
      withWriteConflictRetry(
        async () => {
          calls += 1;
          throw uniqueViolation();
        },
        { baseDelayMs: 1 },
      ),
    ).rejects.toMatchObject({ code: 'P2002' });

    // Retrying a duplicate would burn the budget re-failing, and could mask an
    // ALREADY_ASSIGNED result the caller handles deliberately.
    expect(calls).toBe(1);
  });

  it('backs off between attempts rather than retrying instantly', async () => {
    // Two transactions that deadlock and retry in lockstep deadlock again.
    const started = Date.now();
    let calls = 0;

    await withWriteConflictRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw writeConflict();
        return true;
      },
      { attempts: 4, baseDelayMs: 20 },
    );

    // Two waits, each at least half the nominal delay after jitter.
    expect(Date.now() - started).toBeGreaterThanOrEqual(20);
  });
});
