import { PrismaClient, Prisma } from '@prisma/client';
import { getEnv } from '../config/env.ts';
import { getLogger } from '../lib/logger.ts';

/**
 * Prisma client.
 *
 * Repositories are the only code permitted to import this. Services own
 * transactions; routes never touch the database (docs/architecture.md §3).
 */

let client: PrismaClient | undefined;

function createClient(): PrismaClient {
  const env = getEnv();
  const url =
    env.NODE_ENV === 'test' && env.TEST_DATABASE_URL ? env.TEST_DATABASE_URL : env.DATABASE_URL;

  const prisma = new PrismaClient({
    datasources: { db: { url } },
    log: [
      { emit: 'event', level: 'warn' },
      { emit: 'event', level: 'error' },
      ...(env.LOG_LEVEL === 'trace' ? ([{ emit: 'event', level: 'query' }] as const) : []),
    ],
  });

  const log = getLogger();
  prisma.$on('warn' as never, (e: Prisma.LogEvent) =>
    log.warn({ prisma: e.message }, 'prisma warning'),
  );
  prisma.$on('error' as never, (e: Prisma.LogEvent) =>
    log.error({ prisma: e.message }, 'prisma error'),
  );

  return prisma;
}

export function getPrisma(): PrismaClient {
  client ??= createClient();
  return client;
}

export async function disconnectPrisma(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = undefined;
  }
}

/** Anything usable as a Prisma context — the client itself or a transaction. */
export type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Unique-constraint helper.
 *
 * Idempotency in the payment path is enforced by database constraints rather
 * than application checks, because only the database can win a race
 * (docs/payment-flow.md §3). Callers use this to distinguish "a duplicate
 * already exists, which is fine" from a genuine failure.
 */
export function isUniqueConstraintError(error: unknown, target?: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  if (!target) return true;

  const meta = error.meta as { target?: string | string[] } | undefined;
  const fields = Array.isArray(meta?.target) ? meta.target : meta?.target ? [meta.target] : [];
  return fields.some((f) => f.includes(target));
}

export function isForeignKeyError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003';
}

export function isNotFoundError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025';
}

/**
 * A transaction InnoDB rolled back to break a deadlock or lock-wait.
 *
 * Prisma reports this as `P2034`, and its own message ends "Please retry your
 * transaction" — because unlike a unique-constraint violation, nothing is
 * wrong. The database picked one of two transactions to sacrifice, and the
 * sacrificed one is expected to run again.
 */
export function isWriteConflictError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';
}

/**
 * Runs a transaction, retrying it if the database rolls it back for a deadlock.
 *
 * Found in Phase 11 by running the end-to-end suite against a clean checkout:
 * `offerNextDoctor` writes four rows across three tables, and the ten-second
 * queue sweep can be doing the same thing for the same consultation as an
 * administrator's manual reallocation. InnoDB broke the tie and the loser
 * threw. Nothing retried, so the offer was simply lost — a paid patient
 * waiting in the queue was offered to nobody — and on the request path the
 * administrator got a 500.
 *
 * That contradicts the rule this system is built around: "patients are never
 * abandoned" (docs/consultation-flow.md §4).
 *
 * The retry is bounded and the backoff is jittered, because two transactions
 * that deadlock and then retry in lockstep deadlock again. A caller that
 * exhausts its attempts still throws — this makes a lost offer unlikely, not
 * impossible, and pretending otherwise would be the same mistake in a
 * different place.
 */
export async function withWriteConflictRetry<T>(
  work: () => Promise<T>,
  options: { attempts?: number; baseDelayMs?: number } = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 25;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (!isWriteConflictError(error) || attempt >= attempts) throw error;

      const delay = baseDelayMs * 2 ** (attempt - 1) * (0.5 + Math.random());
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

export { Prisma };
