import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

/**
 * Loads the nearest `.env`, searching upward from this file.
 *
 * The monorepo keeps a single `.env` at the root — one file, one place secrets
 * live, no duplication between workspaces. Node processes in this package run
 * with `apps/api` as their working directory, so plain `dotenv/config` (which
 * reads `./.env`) finds nothing.
 *
 * Import this for its side effect, before anything reads configuration:
 *
 *     import './config/load-dotenv.ts';
 *
 * **It searches rather than counting directories, and that is the point.** It
 * used to resolve `../../../../.env` — four levels up from `src/config`, which
 * is exactly the repository root when this file is run as source. The bundled
 * build puts the same code in `apps/api/dist/server.js`, where four levels up
 * is a directory *outside* the repository. So the built API found no
 * configuration at all and refused to boot with "DATABASE_URL: Required",
 * which reads like a missing variable rather than a build that moved the file.
 * Nothing caught it, because development never runs the build.
 *
 * Searching upward is correct in both, and correct again for a deployment that
 * puts a `.env` beside the bundle: the nearest one wins, which is the one a
 * deployment intended.
 *
 * Existing environment variables always win over the file, so a real
 * deployment injecting configuration through the process environment is never
 * overridden by a stray file on disk.
 */
const here = path.dirname(fileURLToPath(import.meta.url));

/** The first `.env` at or above `from`. Null when there is none. */
function findEnvFile(from: string): string | null {
  let directory = from;

  // Bounded by the filesystem root: `path.dirname('/')` is `'/'`, and on
  // Windows `path.dirname('C:\\')` is `'C:\\'`, so the walk terminates.
  for (;;) {
    const candidate = path.join(directory, '.env');
    if (existsSync(candidate)) return candidate;

    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

const envFile = findEnvFile(here);
if (envFile) {
  loadDotenv({ path: envFile, override: false });
}

export {};
