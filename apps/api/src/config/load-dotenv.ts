import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

/**
 * Loads the repository-root `.env`.
 *
 * The monorepo keeps a single `.env` at the root — one file, one place secrets
 * live, no duplication between workspaces. But Node processes in this package
 * run with `apps/api` as their working directory, so plain `dotenv/config`
 * (which reads `./.env`) finds nothing.
 *
 * Import this for its side effect, before anything reads configuration:
 *
 *     import './config/load-dotenv.ts';
 *
 * Existing environment variables always win, so a real deployment that injects
 * configuration through the process environment is never overridden by a stray
 * file on disk.
 */
const here = path.dirname(fileURLToPath(import.meta.url));

// src/config → src → apps/api → apps → repository root
const repoRootEnv = path.resolve(here, '../../../../.env');

if (existsSync(repoRootEnv)) {
  loadDotenv({ path: repoRootEnv, override: false });
}

// Also honour a package-local .env, for the occasional per-workspace override.
const localEnv = path.resolve(here, '../../.env');
if (existsSync(localEnv)) {
  loadDotenv({ path: localEnv, override: false });
}

export {};
