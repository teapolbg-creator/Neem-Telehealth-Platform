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
import { parseMysqlUrl } from './backup.mjs';
import { readBackup } from './restore.mjs';
import { mysqlArgv } from './mysql-cli.mjs';
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
      `SELECT '${table}' AS t, COUNT(*) AS present FROM information_schema.TABLES ` +
      `WHERE TABLE_SCHEMA='${target.database}' AND TABLE_NAME='${table}'`,
  ).join(' UNION ALL ');

  // Existence first, because COUNT(*) on a missing table is a fatal error and
  // "the table is not there" is one of the outcomes worth reporting.
  const present = new Map();
  const { command, args, env } = mysqlArgv('mysql', target, [
    '--skip-column-names',
    '--batch',
    '-e',
    selects,
  ]);
  for (const line of run(command, args, { env }).trim().split('\n')) {
    const [table, isPresent] = line.split('\t');
    present.set(table, isPresent !== '0');
  }

  const live = WITNESS_TABLES.filter((table) => present.get(table));
  if (live.length === 0) return new Map(WITNESS_TABLES.map((table) => [table, null]));

  const countQuery = live
    .map((table) => `SELECT '${table}' AS t, COUNT(*) AS n FROM \`${target.database}\`.\`${table}\``)
    .join(' UNION ALL ');

  const result = new Map(WITNESS_TABLES.map((table) => [table, null]));
  const counted = mysqlArgv('mysql', target, [
    '--skip-column-names',
    '--batch',
    '-e',
    countQuery,
  ]);
  for (const line of run(counted.command, counted.args, { env: counted.env })
    .trim()
    .split('\n')) {
    const [table, n] = line.split('\t');
    result.set(table, Number(n));
  }
  return result;
}

function exec(target, sql) {
  const { command, args, env } = mysqlArgv('mysql', target, ['-e', sql]);
  run(command, args, { env });
}

/**
 * The account that may create and drop the scratch database.
 *
 * The application's own user deliberately cannot — it has rights over one
 * database and no more, which is correct and is why the rehearsal needs a
 * different credential for this one step. The restore itself then runs as the
 * administrator too, because the scratch database has no application user
 * granted on it.
 */
function adminAccount(source) {
  const password = process.env.MYSQL_ROOT_PASSWORD;
  if (!password) {
    throw new Error(
      'MYSQL_ROOT_PASSWORD is not set.\n' +
        'The rehearsal creates and drops a scratch database, which the\n' +
        "application's own user is not permitted to do — by design. Set the\n" +
        'administrative password to run the rehearsal.',
    );
  }
  return { ...source, user: 'root', password };
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

  const source = parseMysqlUrl(sourceUrl);
  const scratch = { ...adminAccount(source), database: SCRATCH };
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
    exec(scratch, `DROP DATABASE IF EXISTS \`${SCRATCH}\`;`);
    exec(scratch, `CREATE DATABASE \`${SCRATCH}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;`);
    await node(path.join(import.meta.dirname, 'restore.mjs'), [
      backupPath,
      '--url',
      `mysql://${scratch.user}:${encodeURIComponent(scratch.password)}@` +
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
        exec(scratch, `DROP DATABASE IF EXISTS \`${SCRATCH}\`;`);
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
