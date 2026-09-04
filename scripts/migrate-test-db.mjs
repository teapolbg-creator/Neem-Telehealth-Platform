/**
 * Applies migrations to the test database.
 *
 *   npm run db:migrate:test
 *
 * `docker/mysql-init` creates `neem_test` empty, and nothing filled it. The
 * test suite runs against a real MySQL database rather than mocks, so on a
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

function main() {
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
     */
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
    shell: process.platform === 'win32',
    // Where `prisma.config.ts` lives, which is how the CLI finds the schema.
    cwd: path.join(ROOT, 'apps', 'api'),
  });

  if (result.status !== 0) process.exit(result.status ?? 1);

  console.log(`  ✓ test database migrated — ${new URL(url).pathname.replace(/^\//, '')}`);
}

// `pathToFileURL` rather than string-building: on Windows a path compared as a
// raw string never matches `import.meta.url`, and the script silently does
// nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
