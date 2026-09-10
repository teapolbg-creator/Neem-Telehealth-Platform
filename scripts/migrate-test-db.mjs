/**
 * Applies migrations to the test database.
 *
 *   npm run db:migrate:test
 *
 * `docker/postgres-init` creates `neem_test` empty, and nothing filled it. The
 * test suite runs against a real PostgreSQL database rather than mocks, so on a
 * clean checkout `npm test` met a schema with no tables — while the README
 * said it runs against `neem_test`. It worked on this machine because the
 * database had been migrated by hand months earlier, which is the definition
 * of a setup step that does not exist.
 *
 * `migrate deploy` rather than `migrate dev`: this applies what is committed
 * and never generates, prompts, or resets. The test database is not where
 * schema changes are authored.
 *
 * Prisma takes the connection from `DATABASE_URL`, so the test URL is put
 * there for the child process only — the parent's environment is untouched,
 * and nothing else in the run can pick up the wrong database.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadDotEnv } from './load-env.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
  loadDotEnv();

  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    console.error(
      'TEST_DATABASE_URL is not set, so there is no test database to migrate.\n' +
        'It is in .env.example; copy that to .env if you have not already.',
    );
    process.exit(1);
  }

  const result = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
    /**
     * The test URL for this child process only.
     *
     * `prisma.config.ts` loads the root `.env` itself, but dotenv does not
     * overwrite a variable that is already set — so this wins, and the
     * parent's environment is left alone.
     *
     * **Both** URLs, and that is not belt-and-braces. The schema declares
     * `directUrl`, which is what Prisma Migrate actually connects over — it
     * exists because Supabase's pooled connection cannot carry migrations
     * (decision D43). Overriding only `DATABASE_URL` pointed the migration at
     * the *development* database, which was already up to date, so this
     * printed "test database migrated" while `neem_test` sat with no tables
     * at all. A setup step that reports success without doing anything is
     * worse than one that fails.
     */
    env: { ...process.env, DATABASE_URL: url, DIRECT_DATABASE_URL: url },
    stdio: 'inherit',
    shell: process.platform === 'win32',
    // Where `prisma.config.ts` lives, which is how the CLI finds the schema.
    cwd: path.join(ROOT, 'apps', 'api'),
  });

  if (result.status !== 0) process.exit(result.status ?? 1);

  /*
   * Confirm the tables are there.
   *
   * "No pending migrations to apply" is what Prisma says both when a database
   * is up to date and when it has been pointed at a different database that
   * happens to be up to date. The first is success and the second is the bug
   * above, and the exit code cannot tell them apart. Counting the tables can.
   */
  const database = new URL(url).pathname.replace(/^\//, '');
  const tables = await countTables(url);

  if (tables === 0) {
    console.error(
      `  ✗ ${database} still has no tables after a migration that reported success.\n` +
        '    Prisma was probably pointed at a different database — check DATABASE_URL\n' +
        '    and DIRECT_DATABASE_URL.',
    );
    process.exit(1);
  }

  console.log(`  ✓ test database migrated — ${database} (${tables} tables)`);
}

/**
 * How many tables the migrated database actually has.
 *
 * Connects with Prisma's own client, in this process, pointed explicitly at
 * the URL passed in. The first attempt at this shelled out to `npx tsx -e`
 * with an inline script, and the nested quoting did not survive Windows: it
 * returned nothing, parsed as zero, and reported a failure against a database
 * that had in fact just been migrated correctly. A check that cries wolf gets
 * ignored, which makes it worse than no check.
 */
async function countTables(url) {
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient({ datasources: { db: { url } } });

  try {
    const rows = await prisma.$queryRawUnsafe(
      'SELECT count(*)::int AS n FROM information_schema.tables ' +
        "WHERE table_schema = 'public' AND table_type = 'BASE TABLE' " +
        "AND table_name <> '_prisma_migrations'",
    );
    return Number(rows[0]?.n ?? 0);
  } finally {
    await prisma.$disconnect();
  }
}

// `pathToFileURL` rather than string-building: on Windows a path compared as a
// raw string never matches `import.meta.url`, and the script silently does
// nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
