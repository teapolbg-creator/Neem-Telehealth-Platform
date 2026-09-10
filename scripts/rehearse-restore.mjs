#!/usr/bin/env node
/**
 * Backup and restore rehearsal (Phase 10, docs/data-retention.md §7).
 *
 * Backs up the live development database, restores it into a scratch database
 * under a different name, compares what came back row by row, and then drops
 * the scratch database.
 *
 * The comparison is the part that matters. A restore that runs without error
 * and produces an empty table is the failure this exists to catch, and it is
 * indistinguishable from success if all you check is the exit code.
 *
 *   npm run backup:rehearse
 *   npm run backup:rehearse -- --keep      # leave the scratch database behind
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parsePostgresUrl } from './backup.mjs';
import { readBackup } from './restore.mjs';
import { psqlArgv } from './psql-cli.mjs';
import { loadDotEnv } from './load-env.mjs';

loadDotEnv();

const SCRATCH = process.env.REHEARSAL_DATABASE ?? 'neem_restore_rehearsal';

/**
 * Tables whose contents prove a restore actually restored something.
 *
 * Reference data alone is not proof: `seedReferenceData` recreates it, so a
 * database with languages and settings in it may simply have been seeded. The
 * transactional tables are the ones that can only have come from the backup.
 */
const WITNESS_TABLES = [
  'users',
  'pharmacies',
  'doctors',
  'consultations',
  'consultation_state_events',
  'payments',
  'prescriptions',
  'audit_logs',
  'system_settings',
  'feedback',
  'complaints',
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) {
    throw new Error(
      `${command} exited ${result.status}: ${(result.stderr || '').trim().slice(0, 400)}`,
    );
  }
  return result.stdout ?? '';
}

/** Row counts for the witness tables, or null where the table is absent. */
function counts(target) {
  const selects = WITNESS_TABLES.map(
    (table) =>
      `SELECT '${table}' AS t, COUNT(*) AS present FROM information_schema.tables ` +
      `WHERE table_schema = current_schema() AND table_name = '${table}'`,
  ).join(' UNION ALL ');

  // Existence first, because COUNT(*) on a missing table is a fatal error and
  // "the table is not there" is one of the outcomes worth reporting.
  const present = new Map();
  const { command, args, env } = psqlArgv('psql', target, [
    '--tuples-only',
    '--no-align',
    '--field-separator=\t',
    '--no-psqlrc',
    '--command',
    selects,
  ]);
  for (const line of run(command, args, { env }).trim().split('\n')) {
    const [table, isPresent] = line.split('\t');
    present.set(table, isPresent !== '0');
  }

  const live = WITNESS_TABLES.filter((table) => present.get(table));
  if (live.length === 0) return new Map(WITNESS_TABLES.map((table) => [table, null]));

  // A psql session is already connected to one database, so the table is
  // named without a database qualifier — and quoted, since Postgres folds an
  // unquoted identifier to lower case.
  const countQuery = live
    .map((table) => `SELECT '${table}' AS t, COUNT(*) AS n FROM "${table}"`)
    .join(' UNION ALL ');

  const result = new Map(WITNESS_TABLES.map((table) => [table, null]));
  const counted = psqlArgv('psql', target, [
    '--tuples-only',
    '--no-align',
    '--field-separator=\t',
    '--no-psqlrc',
    '--command',
    countQuery,
  ]);
  for (const line of run(counted.command, counted.args, { env: counted.env }).trim().split('\n')) {
    const [table, n] = line.split('\t');
    result.set(table, Number(n));
  }
  return result;
}

function exec(target, sql) {
  const { command, args, env } = psqlArgv('psql', target, ['--no-psqlrc', '--command', sql]);
  run(command, args, { env });
}

/**
 * The account that may create and drop the scratch database.
 *
 * Creating and dropping a database needs CREATEDB, which the application role
 * holds only in development. The restore itself then runs as the same account,
 * because the scratch database has no other role granted on it.
 *
 * There is no `root` here. MySQL had a separate superuser; PostgreSQL's
 * bootstrap role is whatever `POSTGRES_USER` names, which in this project is
 * the same `neem` that owns the databases. Asking for `root` produced
 * "role \"root\" does not exist" at the moment the rehearsal tried to prove
 * the backups were restorable — which is the worst moment for a check to be
 * broken, because it reads as the backups being unrestorable.
 *
 * Against a managed host (Supabase) a rehearsal has to run somewhere that can
 * create a database; the connection details are the operator's to supply, and
 * are the reason this reads them from the environment rather than assuming.
 */
function adminAccount(source) {
  const user = process.env.POSTGRES_USER ?? 'neem';
  const password = process.env.POSTGRES_PASSWORD;

  if (!password) {
    throw new Error(
      'POSTGRES_PASSWORD is not set.\n' +
        'The rehearsal creates and drops a scratch database, which needs an\n' +
        'account holding CREATEDB. Set it to run the rehearsal.',
    );
  }

  /*
   * Connected to `postgres`, not to the source database.
   *
   * A database cannot be dropped by a session connected to it, and the
   * rehearsal drops its scratch database at the end — so the maintenance
   * connection is deliberately somewhere else.
   */
  return { ...source, user, password, database: 'postgres' };
}

async function node(script, argv) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [script, ...argv], { stdio: 'inherit' });
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${path.basename(script)} exited ${code}`)),
    );
  });
}

async function main() {
  if (!process.env.BACKUP_ENCRYPTION_KEY) {
    // A rehearsal must not invent its own key: it would then be rehearsing a
    // configuration nobody runs. But refusing outright makes the rehearsal
    // impossible to try, so say what to set and stop.
    console.error(
      'BACKUP_ENCRYPTION_KEY is not set.\n\n' +
        'Add it to .env (32+ characters, different from ENCRYPTION_KEY) and run\n' +
        'again. The rehearsal deliberately uses the real configuration rather\n' +
        'than a key of its own.',
    );
    process.exit(1);
  }

  const sourceUrl = process.env.DATABASE_URL;
  if (!sourceUrl) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  const source = parsePostgresUrl(sourceUrl);
  /*
   * Two connections, because PostgreSQL needs them to be different.
   *
   * `maintenance` is connected to `postgres` and is what issues CREATE and
   * DROP DATABASE — a session cannot drop the database it is connected to, and
   * cannot connect to one that does not exist yet. `scratch` is connected to
   * the restored copy and is what counts its rows.
   *
   * MySQL let a single connection do both, which is why this was one target.
   */
  const maintenance = adminAccount(source);
  const scratch = { ...maintenance, database: SCRATCH };
  const workDir = mkdtempSync(path.join(tmpdir(), 'neem-rehearsal-'));

  console.log(`rehearsal: ${source.database} → ${SCRATCH}\n`);

  try {
    const before = counts(source);
    const populated = [...before.values()].filter((n) => (n ?? 0) > 0).length;
    if (populated === 0) {
      console.error(
        'The source database has no rows in any witness table. A rehearsal\n' +
          'against an empty database proves nothing — seed it first.',
      );
      process.exit(1);
    }

    console.log('1. backing up');
    await node(path.join(import.meta.dirname, 'backup.mjs'), ['--out', workDir]);

    const [file] = readdirSync(workDir);
    if (!file) throw new Error('the backup produced no file');
    const backupPath = path.join(workDir, file);

    console.log('\n2. verifying the file decrypts before touching a database');
    const sql = readBackup(backupPath, process.env.BACKUP_ENCRYPTION_KEY);
    if (!/CREATE TABLE/i.test(sql)) {
      throw new Error('the decrypted backup contains no table definitions');
    }
    console.log(`   ok — ${(sql.length / 1024).toFixed(1)} KiB of SQL, tag verified`);

    console.log(`\n3. restoring into ${SCRATCH}`);
    exec(maintenance, `DROP DATABASE IF EXISTS "${SCRATCH}";`);
    exec(maintenance, `CREATE DATABASE "${SCRATCH}";`);
    await node(path.join(import.meta.dirname, 'restore.mjs'), [
      backupPath,
      '--url',
      `postgresql://${scratch.user}:${encodeURIComponent(scratch.password)}@` +
        `${source.host}:${source.port}/${SCRATCH}`,
    ]);

    console.log('\n4. comparing');
    const after = counts(scratch);

    let mismatches = 0;
    for (const table of WITNESS_TABLES) {
      const from = before.get(table);
      const to = after.get(table);
      const ok = from === to;
      if (!ok) mismatches += 1;
      console.log(
        `   ${ok ? 'ok  ' : 'FAIL'} ${table.padEnd(28)} ${String(from ?? 'absent').padStart(6)} → ${String(to ?? 'absent').padStart(6)}`,
      );
    }

    if (mismatches > 0) {
      console.error(`\n${mismatches} table(s) did not come back intact.`);
      process.exit(1);
    }

    console.log('\nrehearsal passed: every witness table restored with the same row count.');
  } finally {
    if (!process.argv.includes('--keep')) {
      try {
        exec(maintenance, `DROP DATABASE IF EXISTS "${SCRATCH}";`);
      } catch {
        console.warn(`could not drop ${SCRATCH}; drop it by hand.`);
      }
    } else {
      console.log(`\n${SCRATCH} left in place (--keep).`);
    }
    rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
