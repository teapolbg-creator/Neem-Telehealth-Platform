import path from 'node:path';
import fs, { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile, unlink, access } from 'node:fs/promises';
import { getEnv } from '../../config/env.ts';
import type { StorageProvider } from './storage.provider.ts';

/**
 * The repository root, found by looking for it rather than by counting.
 *
 * `STORAGE_LOCAL_PATH` is written relative to the repository root, matching how
 * it reads in `.env` and how `.gitignore` refers to it. Resolving it against
 * the process's working directory does not work: Node runs this package with
 * `apps/api` as its cwd, which produced `apps/api/apps/api/uploads` — outside
 * the ignore rule, so uploaded credential documents sat untracked in a
 * directory git would happily have committed.
 *
 * The fix for that counted directory levels up from this file. **That is
 * correct in source and wrong in the production bundle**, which is one
 * directory deep (`apps/api/dist/server.js`) rather than four
 * (`apps/api/src/adapters/storage/…`). The same six `..` therefore landed two
 * levels above the repository root, and a relative path resolved to
 * `/apps/api/uploads` — on a host with a mounted disk, that means prescriptions
 * written outside the volume and destroyed by the next deploy.
 *
 * Exactly the fault D40 found in `load-dotenv`, and it takes the same answer:
 * search upward for a marker instead of counting. `package.json` declaring
 * workspaces is the repository root and nothing else in the tree is.
 */
function findRepoRoot(): string {
  let directory = path.dirname(fileURLToPath(import.meta.url));

  for (let depth = 0; depth < 12; depth += 1) {
    const candidate = path.join(directory, 'package.json');

    if (existsSync(candidate)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(candidate, 'utf8')) as {
          workspaces?: unknown;
        };
        if (manifest.workspaces) return directory;
      } catch {
        // An unreadable package.json is not the root; keep walking.
      }
    }

    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  /*
   * No marker found — which is the normal case for a deployment that copies
   * only the bundle. The cwd is then the best available answer, and an
   * absolute STORAGE_LOCAL_PATH (which production should always use) makes
   * this irrelevant because path.resolve ignores the base for one.
   */
  return process.cwd();
}

const REPO_ROOT = findRepoRoot();

/**
 * Local-disk storage for development.
 *
 * The root is outside the web app's served directories, so no static handler
 * can ever expose it. Reads go through the authorised document endpoint.
 */
export class LocalStorageProvider implements StorageProvider {
  private readonly root: string;

  constructor(root?: string) {
    // An absolute path is honoured as given; a relative one is repository-root
    // relative, which is how it is written in `.env`.
    this.root = path.resolve(REPO_ROOT, root ?? getEnv().STORAGE_LOCAL_PATH);
  }

  /**
   * Resolves a key to an absolute path and refuses anything that escapes the
   * storage root. Keys are generated internally, but path traversal is cheap
   * to prevent and expensive to discover late.
   */
  private resolve(key: string): string {
    const resolved = path.resolve(this.root, key);
    const rootWithSep = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;

    if (!resolved.startsWith(rootWithSep)) {
      throw new Error('Storage key resolves outside the storage root');
    }
    return resolved;
  }

  async put(input: { key: string; body: Buffer; mimeType: string }): Promise<void> {
    const target = this.resolve(input.key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, input.body, { mode: 0o600 });
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.resolve(key));
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.resolve(key));
    } catch (error) {
      // Deleting something already gone is success, not failure.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await access(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }
}

let provider: StorageProvider | undefined;

export function getStorageProvider(): StorageProvider {
  if (!provider) {
    const env = getEnv();
    if (env.STORAGE_DRIVER === 'local') {
      provider = new LocalStorageProvider();
    } else {
      // The interface exists so an S3 adapter is a drop-in; failing loudly is
      // better than silently writing production documents to a container disk.
      throw new Error(
        `STORAGE_DRIVER="${env.STORAGE_DRIVER}" has no adapter yet. Implement it in src/adapters/storage/.`,
      );
    }
  }
  return provider;
}

export function setStorageProviderForTesting(next: StorageProvider | undefined): void {
  provider = next;
}
