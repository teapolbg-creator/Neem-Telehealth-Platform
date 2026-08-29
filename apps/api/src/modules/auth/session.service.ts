import type { User, UserRole } from '@prisma/client';
import { permissionsForRole, type Permission } from '@neem/contracts';
import { getPrisma, type Db } from '../../db/prisma.ts';
import { generateToken, hashToken, hashIp } from '../../lib/crypto.ts';
import { addHours, addMinutes, systemClock, type Clock } from '../../lib/clock.ts';
import { getEnv } from '../../config/env.ts';

/**
 * Session lifecycle.
 *
 * Opaque server-side sessions rather than JWT, so that suspending a doctor or
 * pharmacy ends their live session immediately (decision D4). Only a SHA-256
 * digest of the token is stored; the raw value lives in an httpOnly cookie.
 */

export const SESSION_COOKIE = 'neem_session';
export const CSRF_COOKIE = 'neem_csrf';
export const CSRF_HEADER = 'x-neem-csrf';

export interface IssuedSession {
  sessionToken: string;
  csrfToken: string;
  expiresAt: Date;
  absoluteExpiresAt: Date;
}

export interface AuthenticatedPrincipal {
  kind: 'ADMIN' | 'DOCTOR' | 'PHARMACY';
  sessionId: string;
  userId: string;
  userPublicId: string;
  email: string;
  role: UserRole;
  permissions: Permission[];
  /** The doctor or pharmacy this account acts for; null for admins. */
  organisationId: string | null;
  twoFactorEnabled: boolean;
}

export async function createSession(
  user: User,
  context: { ip?: string; userAgent?: string },
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<IssuedSession> {
  const env = getEnv();
  const now = clock.now();

  const sessionToken = generateToken();
  const csrfToken = generateToken();

  const expiresAt = addMinutes(now, env.SESSION_IDLE_TIMEOUT_MINUTES);
  const absoluteExpiresAt = addHours(now, env.SESSION_ABSOLUTE_TIMEOUT_HOURS);

  await db.session.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(sessionToken),
      csrfTokenHash: hashToken(csrfToken),
      expiresAt,
      absoluteExpiresAt,
      ipHash: hashIp(context.ip),
      userAgent: context.userAgent?.slice(0, 512) ?? null,
      lastSeenAt: now,
    },
  });

  return { sessionToken, csrfToken, expiresAt, absoluteExpiresAt };
}

/**
 * Resolves a raw session token to a principal.
 *
 * Returns null for anything unusable — unknown, revoked, idle-expired, or past
 * its absolute lifetime. Account status is re-checked on every request rather
 * than trusted from session creation time, so a suspension takes effect on the
 * suspended user's very next request.
 */
export async function resolveSession(
  sessionToken: string | undefined,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<AuthenticatedPrincipal | null> {
  if (!sessionToken) return null;

  const session = await db.session.findUnique({
    where: { tokenHash: hashToken(sessionToken) },
    include: {
      user: {
        include: {
          doctor: { select: { id: true, status: true } },
          pharmacyMembership: { select: { pharmacyId: true } },
        },
      },
    },
  });

  if (!session || session.revokedAt) return null;

  const now = clock.now();
  if (session.expiresAt <= now || session.absoluteExpiresAt <= now) return null;

  const { user } = session;
  if (user.status !== 'ACTIVE') return null;

  // An admin who has not completed TOTP enrolment holds no usable session
  // (spec §9 — 2FA is mandatory for admins).
  if (user.role === 'ADMIN' && !user.twoFactorEnabledAt) return null;

  const organisationId =
    user.role === 'DOCTOR'
      ? (user.doctor?.id ?? null)
      : user.role === 'PHARMACY'
        ? (user.pharmacyMembership?.pharmacyId ?? null)
        : null;

  return {
    kind: user.role,
    sessionId: session.id,
    userId: user.id,
    userPublicId: user.publicId,
    email: user.email,
    role: user.role,
    permissions: permissionsForRole(user.role),
    organisationId,
    twoFactorEnabled: user.twoFactorEnabledAt !== null,
  };
}

/**
 * Slides the idle window forward. Throttled to once a minute so a busy
 * dashboard does not write on every request.
 */
export async function touchSession(
  sessionId: string,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<void> {
  const env = getEnv();
  const now = clock.now();

  await db.session.updateMany({
    where: { id: sessionId, lastSeenAt: { lt: addMinutes(now, -1) } },
    data: { lastSeenAt: now, expiresAt: addMinutes(now, env.SESSION_IDLE_TIMEOUT_MINUTES) },
  });
}

export async function verifyCsrf(
  sessionId: string,
  csrfToken: string | undefined,
  db: Db = getPrisma(),
): Promise<boolean> {
  if (!csrfToken) return false;
  const session = await db.session.findUnique({
    where: { id: sessionId },
    select: { csrfTokenHash: true },
  });
  return session?.csrfTokenHash === hashToken(csrfToken);
}

export async function revokeSession(
  sessionId: string,
  reason: string,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<void> {
  await db.session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: clock.now(), revokedReason: reason.slice(0, 120) },
  });
}

/**
 * Revokes every session for a user. Called on suspension, password change, and
 * 2FA reset — the operations where a stale live session is a real risk.
 */
export async function revokeAllSessionsForUser(
  userId: string,
  reason: string,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<number> {
  const result = await db.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: clock.now(), revokedReason: reason.slice(0, 120) },
  });
  return result.count;
}

/** Housekeeping for the scheduled job — expired rows carry no useful history. */
export async function purgeExpiredSessions(
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<number> {
  const result = await db.session.deleteMany({
    where: { absoluteExpiresAt: { lt: clock.now() } },
  });
  return result.count;
}
