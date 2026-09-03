#!/usr/bin/env node
/**
 * Restore an encrypted backup (spec §79, docs/data-retention.md §7).
 *
 * The half people skip. A backup that has never been restored is a hope, and
 * the failure mode is always the same: it is discovered at the moment the
 * original is already gone.
 *
 * Two deliberate refusals here:
 *
 *  - **It will not restore over a non-empty database unless told to.** The
 *    default is to refuse, because the common accident is restoring
 *    yesterday's copy over today's live data.
 *  - **It verifies the authentication tag before running a single statement.**
 *    A truncated or tampered backup fails as a decryption error rather than
 *    as a half-restored database, which is much harder to notice.
 *
 * Usage:
 *   node scripts/restore.mjs <file> --url mysql://...
 *   node scripts/restore.mjs <file> --url mysql://... --allow-non-empty
 */
import { spawn } from 'node:child_process';
import { createDecipheriv, scryptSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { parseMysqlUrl } from './backup.mjs';
import { loadDotEnv } from './load-env.mjs';
import { mysqlArgv } from './mysql-cli.mjs';

loadDotEnv();

const HEADER = 'NEEMBK01';
const HEADER_BYTES = HEADER.length + 16 + 12; // magic + salt + iv
const TAG_BYTES = 16;

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

/** Decrypts and decompresses a backup file into SQL text. */
export function readBackup(file, key) {
  const blob = readFileSync(file);

  if (blob.subarray(0, HEADER.length).toString() !== HEADER) {
    throw new Error(`${file} is not a Neem backup (bad magic).`);
  }

  const salt = blob.subarray(HEADER.length, HEADER.length + 16);
  const iv = blob.subarray(HEADER.length + 16, HEADER_BYTES);
  const tag = blob.subarray(blob.length - TAG_BYTES);
  const body = blob.subarray(HEADER_BYTES, blob.length - TAG_BYTES);

  const decipher = createDecipheriv('aes-256-gcm', scryptSync(key, salt, 32), iv);
  decipher.setAuthTag(tag);

  // `final()` throws if the tag does not verify, which is the whole point:
  // nothing reaches the database until the file is proven intact.
  const compressed = Buffer.concat([decipher.update(body), decipher.final()]);
  return gunzipSync(compressed).toString('utf8');
}

async function tableCount(target) {
  return new Promise((resolve, reject) => {
    const { command, args, env } = mysqlArgv('mysql', target, [
      '--skip-column-names',
      '--batch',
      '-e',
      `SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${target.database}'`,
    ]);

    const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'inherit'], env });

    let out = '';
    proc.stdout.on('data', (chunk) => (out += chunk));
    proc.on('close', (code) =>
      code === 0 ? resolve(Number(out.trim())) : reject(new Error(`mysql exited ${code}`)),
    );
  });
}

async function main() {
  const file = process.argv[2];
  if (!file || file.startsWith('--')) {
    console.error('Usage: node scripts/restore.mjs <file> --url mysql://...');
    process.exit(1);
  }

  const key = process.env.BACKUP_ENCRYPTION_KEY;
  if (!key) {
    console.error('BACKUP_ENCRYPTION_KEY is not set; the backup cannot be decrypted.');
    process.exit(1);
  }

  const raw = arg('url', process.env.DATABASE_URL);
  if (!raw) {
    console.error('No database URL. Set DATABASE_URL or pass --url.');
    process.exit(1);
  }
  const target = parseMysqlUrl(raw);

  const sql = readBackup(file, key);
  console.log(`decrypted and verified: ${file} (${(sql.length / 1024).toFixed(1)} KiB of SQL)`);

  const existing = await tableCount(target);
  if (existing > 0 && !process.argv.includes('--allow-non-empty')) {
    console.error(
      `\n${target.database} already has ${existing} tables. Refusing.\n` +
        'Restoring over live data is the accident this guard exists for.\n' +
        'Pass --allow-non-empty if overwriting is genuinely what you want.',
    );
    process.exit(1);
  }

  const invocation = mysqlArgv('mysql', target, [
    '--default-character-set=utf8mb4',
    target.database,
  ]);

  const load = spawn(invocation.command, invocation.args, {
    stdio: ['pipe', 'inherit', 'inherit'],
    env: invocation.env,
  });

  load.stdin.end(sql);

  await new Promise((resolve, reject) => {
    load.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`mysql exited ${code}`)),
    );
  });

  const restored = await tableCount(target);
  console.log(`restored into ${target.database}: ${restored} tables`);
}

// See the note in backup.mjs: a hand-assembled `file://` URL never matches on
// Windows, so this guard has to go through `pathToFileURL`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
