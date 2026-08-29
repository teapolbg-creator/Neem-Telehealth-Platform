import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { hash as argonHash, verify as argonVerify, Algorithm } from '@node-rs/argon2';
import { getEnv } from '../config/env.ts';

/**
 * Cryptographic primitives.
 *
 * Everything security-sensitive routes through here so the choices are made
 * once, reviewed once, and tested once. See docs/security.md §2 and §5.
 */

// ---------------------------------------------------------------------------
// Passwords — argon2id (memory-hard, resists GPU cracking)
// ---------------------------------------------------------------------------

/**
 * OWASP-aligned parameters: 19 MiB memory, 2 iterations, parallelism 1.
 * @node-rs/argon2 ships prebuilt binaries, so there is no node-gyp build step
 * on Windows — which matters for this project's local development story.
 */
const ARGON_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plaintext: string): Promise<string> {
  return argonHash(plaintext, ARGON_OPTIONS);
}

export async function verifyPassword(hash: string, plaintext: string): Promise<boolean> {
  try {
    return await argonVerify(hash, plaintext, ARGON_OPTIONS);
  } catch {
    // A malformed stored hash must read as "wrong password", never as an error
    // that could distinguish one account from another.
    return false;
  }
}

/**
 * A pre-computed hash used to equalise login timing for unknown accounts, so
 * response time does not disclose whether an email is registered
 * (docs/security.md §2). Computed lazily, once.
 */
let dummyHashPromise: Promise<string> | undefined;
export function dummyPasswordHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(randomBytes(32).toString('base64url'));
  return dummyHashPromise;
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/** 256 bits from a CSPRNG. Used for sessions, QR access tokens, resets. */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Tokens are stored only as a SHA-256 digest. The raw value lives in a cookie
 * or a QR image and is never persisted, logged, or returned twice.
 *
 * SHA-256 without a work factor is correct here (unlike for passwords): the
 * input is already 256 bits of uniform randomness, so there is nothing to
 * brute-force.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time comparison for anything an attacker can probe repeatedly. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still burn a comparison so length alone is not a timing oracle.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/** IP addresses are personal data; store a keyed digest, never the address. */
export function hashIp(ip: string | undefined): string | null {
  if (!ip) return null;
  return createHmac('sha256', getEnv().SESSION_SECRET).update(ip).digest('hex');
}

/**
 * Public-facing identifier. Non-sequential and non-enumerable, so exposing it
 * in a URL discloses nothing and cannot be walked (spec §65).
 */
export function generatePublicId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString('base64url')}`;
}

/**
 * Prescription verification code. Longer than a public id because it is the
 * sole guard on a public, unauthenticated page (spec §44).
 */
export function generateVerificationCode(): string {
  return randomBytes(16).toString('base64url');
}

// ---------------------------------------------------------------------------
// Field encryption — AES-256-GCM
// ---------------------------------------------------------------------------

const ENCRYPTION_VERSION = 'v1';

function encryptionKey(): Buffer {
  const raw = getEnv().ENCRYPTION_KEY;
  // Derive a fixed 32-byte key from the configured secret so operators are not
  // required to supply exactly 32 raw bytes.
  return createHash('sha256').update(raw).digest();
}

/**
 * Encrypts a sensitive field at rest: patient name and phone, doctor
 * signatures, pharmacy payout details, TOTP secrets (docs/security.md §5).
 *
 * Output: `v1.<iv>.<authTag>.<ciphertext>`, all base64url. The version prefix
 * makes key rotation and algorithm change possible without ambiguity.
 */
export function encryptField(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    ENCRYPTION_VERSION,
    iv.toString('base64url'),
    authTag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

export function decryptField(payload: string): string {
  const [version, ivPart, tagPart, dataPart] = payload.split('.');

  if (version !== ENCRYPTION_VERSION || !ivPart || !tagPart || !dataPart) {
    throw new Error('Encrypted field is malformed or uses an unsupported version');
  }

  const decipher = createDecipheriv(
    'aes-256-gcm',
    encryptionKey(),
    Buffer.from(ivPart, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));

  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/** Convenience for nullable columns. */
export function encryptNullable(value: string | null | undefined): string | null {
  return value == null || value === '' ? null : encryptField(value);
}

export function decryptNullable(value: string | null | undefined): string | null {
  return value == null || value === '' ? null : decryptField(value);
}
