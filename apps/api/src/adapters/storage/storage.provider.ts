import { randomBytes } from 'node:crypto';

/**
 * File storage abstraction (spec §91).
 *
 * Local disk in development, object storage in the cloud — business logic
 * never knows which. Uploaded credential documents are stored OUTSIDE any
 * web-served directory and are readable only through an authorised, audited
 * endpoint (docs/security.md §6). There is deliberately no `getPublicUrl`:
 * a doctor's government ID must never be reachable by URL alone.
 */

export interface StoredFile {
  /** Opaque key. Contains no user-supplied text — see `buildStorageKey`. */
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
}

export interface StorageProvider {
  put(input: { key: string; body: Buffer; mimeType: string }): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

/**
 * Accepted upload types.
 *
 * An allow-list, not a deny-list, and every entry is matched against the
 * file's magic bytes as well as its declared type — a browser-supplied
 * Content-Type is attacker-controlled.
 */
export const ALLOWED_UPLOAD_TYPES: Record<string, { extension: string; magic: Buffer[] }> = {
  'application/pdf': { extension: 'pdf', magic: [Buffer.from('%PDF-')] },
  'image/jpeg': { extension: 'jpg', magic: [Buffer.from([0xff, 0xd8, 0xff])] },
  'image/png': {
    extension: 'png',
    magic: [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  },
  'image/webp': { extension: 'webp', magic: [Buffer.from('RIFF')] },
};

/**
 * Verifies the file's leading bytes match its declared MIME type.
 *
 * Prevents an executable or script being stored under an image content type.
 * Storage never executes anything, but a file that later reaches a viewer or
 * a PDF pipeline should be what it claims to be.
 */
export function detectedTypeMatches(declaredMimeType: string, body: Buffer): boolean {
  const spec = ALLOWED_UPLOAD_TYPES[declaredMimeType];
  if (!spec) return false;

  return spec.magic.some((signature) => body.subarray(0, signature.length).equals(signature));
}

/**
 * Builds a storage key from a random identifier only.
 *
 * The original filename is never used: it is user-supplied, may contain path
 * traversal or unicode tricks, and may itself carry personal information
 * ("kwame-owusu-passport.pdf"). It is not retained anywhere.
 */
export function buildStorageKey(scope: string, mimeType: string): string {
  const spec = ALLOWED_UPLOAD_TYPES[mimeType];
  if (!spec) {
    throw new Error(`Unsupported upload type: ${mimeType}`);
  }

  const safeScope = scope.replace(/[^a-z0-9-]/gi, '').slice(0, 40);
  const id = randomBytes(16).toString('hex');
  return `${safeScope}/${id}.${spec.extension}`;
}
