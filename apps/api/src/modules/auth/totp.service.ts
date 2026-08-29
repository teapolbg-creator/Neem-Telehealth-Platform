import { authenticator } from 'otplib';
import { randomBytes } from 'node:crypto';
import { encryptField, decryptField, hashPassword, verifyPassword } from '../../lib/crypto.ts';

/**
 * TOTP two-factor authentication (RFC 6238). Mandatory for admins (spec §9).
 *
 * A ±1 step window tolerates ordinary clock drift between the server and the
 * user's phone without meaningfully widening the attack surface: a code is
 * valid for at most 90 seconds, and challenges are rate-limited and consumed
 * on use.
 */
authenticator.options = { step: 30, window: 1, digits: 6 };

export const TOTP_ISSUER = 'Neem';
export const RECOVERY_CODE_COUNT = 10;
export const MAX_CHALLENGE_ATTEMPTS = 5;

export function generateTotpSecret(): string {
  return authenticator.generateSecret(20);
}

/** The otpauth:// URI the authenticator app scans. Rendered as a QR client-side. */
export function totpKeyUri(secret: string, accountEmail: string): string {
  return authenticator.keyuri(accountEmail, TOTP_ISSUER, secret);
}

export function verifyTotp(secret: string, token: string): boolean {
  try {
    return authenticator.verify({ token: token.trim(), secret });
  } catch {
    return false;
  }
}

export function encryptTotpSecret(secret: string): string {
  return encryptField(secret);
}

export function decryptTotpSecret(encrypted: string): string {
  return decryptField(encrypted);
}

/**
 * Recovery codes for a lost authenticator. Returned to the admin exactly once,
 * at enrolment, and stored only as hashes.
 *
 * Hashed with argon2id rather than SHA-256 because these are human-transcribed
 * secrets with far less entropy than a session token.
 */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => {
    const raw = randomBytes(5).toString('hex').toUpperCase();
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

export async function hashRecoveryCodes(codes: string[]): Promise<string[]> {
  return Promise.all(codes.map((code) => hashPassword(normaliseRecoveryCode(code))));
}

export function normaliseRecoveryCode(code: string): string {
  return code.trim().toUpperCase().replace(/\s+/g, '');
}

export async function matchesRecoveryCode(hash: string, candidate: string): Promise<boolean> {
  return verifyPassword(hash, normaliseRecoveryCode(candidate));
}
