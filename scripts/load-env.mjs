/**
 * `.env` loading for the operational scripts.
 *
 * These run outside the application, so they cannot use its config loader
 * (which validates the whole environment and would refuse to start over an
 * unrelated missing variable). They need a handful of values at most, and
 * existing environment variables always win — that is what lets CI pass a key
 * without a file on disk.
 *
 * **It uses the same `dotenv` the application uses, and that is the point.**
 * This was a hand-rolled parser, which skipped lines *beginning* with `#` and
 * otherwise took the rest of the line verbatim. `dotenv` treats an unquoted
 * `#` as the start of a comment wherever it appears. So a password beginning
 * with `#` was read correctly here and discarded by the application — and
 * `npm run smtp:check` reported a healthy relay while the API failed to
 * authenticate against the same account with "Missing credentials for PLAIN".
 *
 * A check that parses configuration differently from the application can pass
 * while the application fails, which is worse than no check: it converts a
 * visible misconfiguration into a confident all-clear. One parser, so the
 * scripts and the API always disagree about nothing.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenvFile } from 'dotenv';

/**
 * The repository root, found from this file rather than from the shell.
 *
 * It used to default to `process.cwd()`, which is correct under `npm run` —
 * npm sets the working directory to the package root — and wrong every other
 * way a script gets started. Running one from `scripts/`, or from an editor's
 * run button, or from a subdirectory, silently found no `.env` at all: no
 * error, just a script insisting a variable was unset when it is sitting in
 * the file. There is exactly one `.env` and it is always here, so there is
 * nothing for the shell to be right about.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadDotEnv(file = path.join(REPO_ROOT, '.env')) {
  if (!existsSync(file)) return;

  // `override: false` keeps the old contract: a variable already in the
  // environment beats the file, so CI can supply one without a file on disk.
  loadDotenvFile({ path: file, override: false });
}
