#!/usr/bin/env node
/**
 * Encrypted database backup (spec §79, docs/data-retention.md §7).
 *
 * Three properties this has to have, and the reason each one is not optional:
 *
 *  1. **Encrypted at rest, with a key that is not the application's.** A
 *     backup is a complete copy of every clinical record Neem holds. An
 *     unencrypted dump on a build agent is the single largest disclosure
 *     risk the product has, and it is the one that does not look like a
 *     security decision when someone makes it.
 *  2. **A stated, bounded window.** Destruction at the end of the retention
 *     period is only real if backups taken before that date age out. The
 *     window is printed on every run so it cannot quietly grow.
 *  3. **Restorable, proven by restoring it.** `restore.mjs` is the other half,
 *     and `npm run backup:rehearse` runs both against a scratch database. A
 *     backup nobody has restored is a hope, not a backup.
 *
 * Usage:
 *   node scripts/backup.mjs                       # backs up DATABASE_URL
 *   node scripts/backup.mjs --url mysql://...     # or an explicit target
 *   node scripts/backup.mjs --out backups/        # default: ./backups
 *
 * The key comes from BACKUP_ENCRYPTION_KEY. It must not be ENCRYPTION_KEY:
 * field-level encryption and backup encryption protect against different
 * failures, and one key for both means a leaked application key also opens
 * every historical copy.
 */
import { spawn } from 'node:child_process';
import { loadDotEnv } from './load-env.mjs';
import { mysqlArgv } from './mysql-cli.mjs';
import { createCipheriv, randomBytes, scryptSync } from 'node:crypto';
import { createWriteStream, mkdirSync, statSync } from 'node:fs';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

loadDotEnv();

const RETENTION_DAYS = Number(process.env.BACKUP_RETENTION_DAYS ?? 30);

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

/** Splits a MySQL URL into the pieces `mysqldump` wants as flags. */
export function parseMysqlUrl(raw) {
  const url = new URL(raw);
  return {
    host: url.hostname,
    port: url.port || '3306',
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ''),
  };
}

function requireKey() {
  const key = process.env.BACKUP_ENCRYPTION_KEY;
  if (!key || key.length < 32) {
    console.error(
      'BACKUP_ENCRYPTION_KEY is missing or shorter than 32 characters.\n' +
        'A backup is a complete copy of every clinical record Neem holds; it is\n' +
        'not written unencrypted. Set the variable and run again.',
    );
    process.exit(1);
  }
  if (key === process.env.ENCRYPTION_KEY) {
    console.error(
      'BACKUP_ENCRYPTION_KEY must differ from ENCRYPTION_KEY.\n' +
        'Using one key for both means a leaked application key also opens every\n' +
        'historical copy of the database.',
    );
    process.exit(1);
  }
  return key;
}

async function main() {
  const raw = arg('url', process.env.DATABASE_URL);
  if (!raw) {
    console.error('No database URL. Set DATABASE_URL or pass --url.');
    process.exit(1);
  }

  const key = requireKey();
  const target = parseMysqlUrl(raw);
  const outDir = path.resolve(arg('out', 'backups'));
  mkdirSync(outDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(outDir, `${target.database}-${stamp}.sql.gz.enc`);

  // A random salt and IV per backup, stored in the file's own header, so two
  // backups of the same database are not byte-comparable and a repeated IV
  // cannot happen by construction.
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const derived = scryptSync(key, salt, 32);
  const cipher = createCipheriv('aes-256-gcm', derived, iv);

  const invocation = mysqlArgv('mysqldump', target, [
    '--single-transaction',
    '--quick',
    // A backup user should not need the server-wide PROCESS privilege, and
    // a least-privilege one will not have it. Without this flag mysqldump
    // asks for tablespace metadata and prints an access-denied error into
    // the middle of an otherwise complete dump.
    '--no-tablespaces',
    // Routines and triggers travel with the data; a restore that silently
    // dropped them would appear to work until something needed one.
    '--routines',
    '--triggers',
    '--events',
    // Without this a restore into a differently-named database fails on the
    // embedded USE statement.
    '--no-create-db',
    '--default-character-set=utf8mb4',
    target.database,
  ]);

  if (invocation.viaDocker) {
    console.log(
      `(no local mysqldump; using the client in ${process.env.NEEM_MYSQL_CONTAINER ?? 'neem-mysql'})`,
    );
  }

  const dump = spawn(invocation.command, invocation.args, {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: invocation.env,
  });

  const out = createWriteStream(file);
  // Header: magic, version, salt, iv. The auth tag is appended at the end,
  // because GCM only knows it once the whole stream has passed through.
  out.write(Buffer.concat([Buffer.from('NEEMBK01'), salt, iv]));

  await pipeline(dump.stdout, createGzip({ level: 9 }), cipher, out, { end: false });

  await new Promise((resolve, reject) => {
    dump.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`mysqldump exited ${code}`)),
    );
  });

  out.end(cipher.getAuthTag());
  await new Promise((resolve) => out.on('close', resolve));

  const { size } = statSync(file);
  console.log(`backup written: ${file}`);
  console.log(`  size:            ${(size / 1024).toFixed(1)} KiB`);
  console.log(`  encryption:      AES-256-GCM, scrypt-derived, per-file salt and IV`);
  console.log(`  retention:       ${RETENTION_DAYS} days (BACKUP_RETENTION_DAYS)`);
  console.log(
    `  destruction lag: a clinical record destroyed today remains in backups\n` +
      `                   for up to ${RETENTION_DAYS} days. This window is stated in\n` +
      `                   the privacy notice rather than concealed.`,
  );
}

// `pathToFileURL` rather than string-building the URL: on Windows a path
// becomes `file:///C:/...` with three slashes, and spaces are percent-encoded.
// Comparing against a hand-assembled `file://` string silently never matched,
// so the script exited 0 having done nothing at all.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
