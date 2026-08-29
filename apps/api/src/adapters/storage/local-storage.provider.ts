import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile, unlink, access } from 'node:fs/promises';
import { getEnv } from '../../config/env.ts';
import type { StorageProvider } from './storage.provider.ts';

/**
 * The repository root, derived from this file rather than the process's
 * working directory.
 *
 * `STORAGE_LOCAL_PATH` is written relative to the repository root, matching
 * how it reads in `.env` and how `.gitignore` refers to it — but Node runs
 * this package with `apps/api` as its working directory, so resolving against
 * the cwd produced `apps/api/apps/api/uploads`. That path is outside the
 * ignore rule, so uploaded credential documents were sitting untracked in a
 * directory git would happily have committed.
 */
// adapters/storage → adapters → src → apps/api → apps → repository root
const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../../../../..');

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
