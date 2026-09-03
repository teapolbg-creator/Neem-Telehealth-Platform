/**
 * Minimal `.env` loading for the operational scripts.
 *
 * These run outside the application, so they cannot use its config loader
 * (which validates the whole environment and would refuse to start over an
 * unrelated missing variable). They need three values at most, and existing
 * environment variables always win — that is what lets CI pass a key without
 * a file on disk.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export function loadDotEnv(file = path.join(process.cwd(), '.env')) {
  if (!existsSync(file)) return;

  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;

    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
