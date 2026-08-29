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
  const url = env.NODE_ENV === 'test' && env.TEST_DATABASE_URL ? env.TEST_DATABASE_URL : env.DATABASE_URL;

  const prisma = new PrismaClient({
    datasources: { db: { url } },
    log: [
      { emit: 'event', level: 'warn' },
      { emit: 'event', level: 'error' },
      ...(env.LOG_LEVEL === 'trace'
        ? ([{ emit: 'event', level: 'query' }] as const)
        : []),
    ],
  });

  const log = getLogger();
  prisma.$on('warn' as never, (e: Prisma.LogEvent) => log.warn({ prisma: e.message }, 'prisma warning'));
  prisma.$on('error' as never, (e: Prisma.LogEvent) => log.error({ prisma: e.message }, 'prisma error'));

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

export { Prisma };
