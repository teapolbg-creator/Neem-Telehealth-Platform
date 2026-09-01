import { afterEach, describe, expect, it } from 'vitest';
import {
  decryptField,
  decryptNullable,
  encryptField,
  encryptNullable,
  generatePublicId,
  generateToken,
  generateVerificationCode,
  hashPassword,
  hashToken,
  safeEqual,
  verifyPassword,
} from '../../src/lib/crypto.ts';
import { loadEnv, setEnvForTesting } from '../../src/config/env.ts';

describe('password hashing', () => {
  it('verifies a correct password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword(hash, 'Correct horse battery staple')).toBe(false);
    expect(await verifyPassword(hash, '')).toBe(false);
  });

  it('salts, so identical passwords produce different hashes', async () => {
    const a = await hashPassword('same-password-value');
    const b = await hashPassword('same-password-value');
    expect(a).not.toBe(b);
    expect(await verifyPassword(a, 'same-password-value')).toBe(true);
    expect(await verifyPassword(b, 'same-password-value')).toBe(true);
  });

  it('never stores the plaintext', async () => {
    const hash = await hashPassword('SuperSecret123!');
    expect(hash).not.toContain('SuperSecret123!');
    expect(hash.startsWith('$argon2id$')).toBe(true);
  });

  it('treats a malformed stored hash as a wrong password, not an error', async () => {
    // A corrupt row must read as "authentication failed" — never as a crash
    // that could distinguish one account from another.
    expect(await verifyPassword('not-a-real-hash', 'anything')).toBe(false);
  });
});

describe('tokens', () => {
  it('generates 256 bits of entropy by default', () => {
    const token = generateToken();
    // 32 bytes base64url-encoded, unpadded.
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('never repeats across a large sample', () => {
    const seen = new Set(Array.from({ length: 5000 }, () => generateToken()));
    expect(seen.size).toBe(5000);
  });

  it('hashes deterministically, so only the digest need be stored', () => {
    const token = generateToken();
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).toHaveLength(64);
    expect(hashToken(token)).not.toContain(token);
  });

  it('produces different digests for different tokens', () => {
    expect(hashToken('a')).not.toBe(hashToken('b'));
  });
});

describe('safeEqual', () => {
  it('matches identical strings and rejects differing ones', () => {
    expect(safeEqual('abc123', 'abc123')).toBe(true);
    expect(safeEqual('abc123', 'abc124')).toBe(false);
  });

  it('rejects differing lengths without throwing', () => {
    expect(safeEqual('short', 'a-much-longer-value')).toBe(false);
    expect(safeEqual('', 'x')).toBe(false);
  });
});

describe('public identifiers', () => {
  it('are prefixed, opaque, and URL-safe', () => {
    const id = generatePublicId('cons');
    expect(id).toMatch(/^cons_[A-Za-z0-9_-]+$/);
  });

  it('are not sequential — consecutive ids share no ordering', () => {
    const ids = Array.from({ length: 1000 }, () => generatePublicId('doc'));
    expect(new Set(ids).size).toBe(1000);
  });

  it('produce high-entropy verification codes for the public page', () => {
    const codes = Array.from({ length: 1000 }, () => generateVerificationCode());
    expect(new Set(codes).size).toBe(1000);
    expect(codes[0]!.length).toBeGreaterThanOrEqual(22);
  });
});

describe('field encryption', () => {
  it('round-trips a value', () => {
    const plaintext = 'Efua Mensah';
    expect(decryptField(encryptField(plaintext))).toBe(plaintext);
  });

  it('produces different ciphertext each time, so equal values are not linkable', () => {
    const a = encryptField('0240000000');
    const b = encryptField('0240000000');
    expect(a).not.toBe(b);
    expect(decryptField(a)).toBe(decryptField(b));
  });

  it('does not leak the plaintext into the ciphertext', () => {
    const encrypted = encryptField('Kwame Owusu');
    expect(encrypted).not.toContain('Kwame');
    expect(encrypted).not.toContain('Owusu');
  });

  it('carries a version prefix so keys and algorithms can be rotated', () => {
    expect(encryptField('x').startsWith('v1.')).toBe(true);
  });

  it('rejects tampered ciphertext — GCM authenticates as well as encrypts', () => {
    const encrypted = encryptField('sensitive value');
    const parts = encrypted.split('.');
    // Flip a character in the ciphertext segment.
    const data = parts[3]!;
    parts[3] = (data[0] === 'A' ? 'B' : 'A') + data.slice(1);
    expect(() => decryptField(parts.join('.'))).toThrow();
  });

  it('rejects a malformed or unversioned payload', () => {
    expect(() => decryptField('garbage')).toThrow(/malformed|unsupported/i);
    expect(() => decryptField('v2.a.b.c')).toThrow(/malformed|unsupported/i);
  });

  it('handles unicode and long values', () => {
    const value = 'Nana Ama Ɔbenewaa — ' + 'x'.repeat(4000);
    expect(decryptField(encryptField(value))).toBe(value);
  });

  it('passes null and empty values through unchanged', () => {
    expect(encryptNullable(null)).toBeNull();
    expect(encryptNullable(undefined)).toBeNull();
    expect(encryptNullable('')).toBeNull();
    expect(decryptNullable(null)).toBeNull();
  });
});

/**
 * Key rotation (decision D23).
 *
 * Clinical records are now held for years, so the key that wrote them will
 * outlive its own sensible lifetime. Rotation must be possible without a flag
 * day, and an untested rotation path is a data-loss incident waiting to
 * happen.
 */
describe('encryption key rotation', () => {
  const OLD_KEY = 'the-retired-encryption-key-value-00000001';
  const NEW_KEY = 'the-current-encryption-key-value-00000001';

  function useKeys(current: string, previous?: string): void {
    setEnvForTesting(
      loadEnv({
        ...process.env,
        ENCRYPTION_KEY: current,
        ...(previous ? { ENCRYPTION_KEY_PREVIOUS: previous } : {}),
      }),
    );
  }

  afterEach(() => setEnvForTesting(undefined));

  it('still reads a field written by a retired key', () => {
    useKeys(OLD_KEY);
    const written = encryptField('Fever for three days.');

    // Rotate: the old key moves to the retired list, a new key takes over.
    useKeys(NEW_KEY, OLD_KEY);

    expect(decryptField(written)).toBe('Fever for three days.');
  });

  it('writes new fields with the current key only', () => {
    useKeys(NEW_KEY, OLD_KEY);
    const written = encryptField('written after rotation');

    // Drop the retired key, as an operator does once re-encryption finishes.
    useKeys(NEW_KEY);

    expect(decryptField(written)).toBe('written after rotation');
  });

  it('reads through several rotations, so a key can be retired each year', () => {
    useKeys('key-one-value-000000000000000000000000001');
    const first = encryptField('oldest');

    useKeys('key-two-value-000000000000000000000000001', 'key-one-value-000000000000000000000000001');
    const second = encryptField('middle');

    useKeys(
      'key-three-value-00000000000000000000000001',
      'key-two-value-000000000000000000000000001,key-one-value-000000000000000000000000001',
    );

    expect(decryptField(first)).toBe('oldest');
    expect(decryptField(second)).toBe('middle');
    expect(decryptField(encryptField('newest'))).toBe('newest');
  });

  it('fails loudly when the key that wrote a field is gone', () => {
    useKeys(OLD_KEY);
    const written = encryptField('unreachable once the key is dropped');

    // The retired key was removed before re-encryption finished — the mistake
    // this message exists to name.
    useKeys(NEW_KEY);

    expect(() => decryptField(written)).toThrow(/ENCRYPTION_KEY_PREVIOUS/);
  });

  it('does not treat a wrong key as a successful decryption', () => {
    useKeys(OLD_KEY);
    const written = encryptField('authentic');

    useKeys(NEW_KEY);

    // GCM authentication is what makes trying each key in turn safe: a wrong
    // key throws rather than returning plausible rubbish.
    expect(() => decryptField(written)).toThrow();
  });
});
