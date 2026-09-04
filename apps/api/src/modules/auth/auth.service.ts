import type { PrismaClient, User } from '@prisma/client';
import type { LoginResponse } from '@neem/contracts';
import { getPrisma, type Db } from '../../db/prisma.ts';
import { getEnv } from '../../config/env.ts';
import { addMinutes, systemClock, type Clock } from '../../lib/clock.ts';
import { errors } from '../../lib/errors.ts';
import {
  dummyPasswordHash,
  generateToken,
  hashIp,
  hashPassword,
  hashToken,
  verifyPassword,
} from '../../lib/crypto.ts';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit.service.ts';
import { createSession, revokeAllSessionsForUser, type IssuedSession } from './session.service.ts';
import {
  MAX_CHALLENGE_ATTEMPTS,
  decryptTotpSecret,
  encryptTotpSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCodes,
  matchesRecoveryCode,
  totpKeyUri,
  verifyTotp,
} from './totp.service.ts';

/**
 * Authentication.
 *
 * Design points worth stating (docs/security.md §2):
 *
 *  - Unknown accounts still perform a password verification against a dummy
 *    hash, so response time does not disclose whether an email is registered.
 *  - Failure messages are identical for "no such account" and "wrong password".
 *  - Admins are never handed a session before TOTP succeeds; the intermediate
 *    state lives in a short-lived challenge row, not a half-privileged cookie.
 *  - Lockout is per-account and time-boxed; the route layer adds per-IP limits.
 */

export interface RequestContext {
  ip?: string;
  userAgent?: string;
  correlationId?: string;
}

export interface LoginOutcome {
  response: LoginResponse;
  /** Present only when authentication fully succeeded. */
  session?: IssuedSession;
}

const GENERIC_LOGIN_FAILURE = 'That email or password is not correct.';

export async function login(
  input: { email: string; password: string },
  ctx: RequestContext,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<LoginOutcome> {
  const env = getEnv();
  const now = clock.now();

  const user = await db.user.findUnique({
    where: { email: input.email },
    include: {
      admin: { select: { fullName: true } },
      doctor: { select: { id: true, fullName: true, status: true } },
      pharmacyMembership: {
        select: { pharmacy: { select: { id: true, name: true, status: true } } },
      },
    },
  });

  if (!user) {
    // Equalise timing against the registered-account path.
    await verifyPassword(await dummyPasswordHash(), input.password);
    await recordAudit(
      {
        action: AUDIT_ACTIONS.LOGIN_FAILED,
        actorType: 'SYSTEM',
        outcome: 'FAILURE',
        ipHash: hashIp(ctx.ip),
        userAgent: ctx.userAgent,
        correlationId: ctx.correlationId,
        metadata: { reason: 'unknown_account' },
      },
      db,
    );
    throw errors.unauthenticated(GENERIC_LOGIN_FAILURE);
  }

  if (user.lockedUntil && user.lockedUntil > now) {
    throw errors.accountLocked(user.lockedUntil);
  }

  const passwordValid = await verifyPassword(user.passwordHash, input.password);

  if (!passwordValid) {
    await registerFailedAttempt(user, ctx, db, clock);
    throw errors.unauthenticated(GENERIC_LOGIN_FAILURE);
  }

  if (user.status !== 'ACTIVE') {
    await recordAudit(
      {
        action: AUDIT_ACTIONS.LOGIN_FAILED,
        actorType: user.role,
        actorId: user.id,
        outcome: 'DENIED',
        ipHash: hashIp(ctx.ip),
        correlationId: ctx.correlationId,
        metadata: { reason: 'account_not_active', status: user.status },
      },
      db,
    );
    throw errors.accountNotActive();
  }

  // Password was correct — clear the failure counter before proceeding.
  await db.user.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, lockedUntil: null },
  });

  const requiresTwoFactor = user.role === 'ADMIN' || user.twoFactorEnabledAt !== null;

  if (requiresTwoFactor) {
    const enrollmentRequired = user.twoFactorEnabledAt === null;
    const challengeId = generateToken(24);

    await db.twoFactorChallenge.create({
      data: {
        challengeId,
        userId: user.id,
        enrollment: enrollmentRequired,
        expiresAt: addMinutes(now, 10),
        ipHash: hashIp(ctx.ip),
      },
    });

    return {
      response: { status: 'TWO_FACTOR_REQUIRED', challengeId, enrollmentRequired },
    };
  }

  const session = await createSession(user, ctx, db, clock);
  await db.user.update({ where: { id: user.id }, data: { lastLoginAt: now } });

  await recordAudit(
    {
      action: AUDIT_ACTIONS.LOGIN_SUCCEEDED,
      actorType: user.role,
      actorId: user.id,
      ipHash: hashIp(ctx.ip),
      userAgent: ctx.userAgent,
      correlationId: ctx.correlationId,
      metadata: { role: user.role, twoFactor: false },
    },
    db,
  );

  return {
    response: {
      status: 'AUTHENTICATED',
      user: {
        publicId: user.publicId,
        email: user.email,
        role: user.role,
        displayName: displayNameFor(user),
        mustEnrollTwoFactor: false,
      },
    },
    session,
  };
}

async function registerFailedAttempt(
  user: User,
  ctx: RequestContext,
  db: Db,
  clock: Clock,
): Promise<void> {
  const env = getEnv();
  const attempts = user.failedLoginCount + 1;
  const shouldLock = attempts >= env.LOGIN_MAX_ATTEMPTS;
  const lockedUntil = shouldLock ? addMinutes(clock.now(), env.LOGIN_LOCKOUT_MINUTES) : null;

  await db.user.update({
    where: { id: user.id },
    data: {
      failedLoginCount: shouldLock ? 0 : attempts,
      lockedUntil,
    },
  });

  await recordAudit(
    {
      action: shouldLock ? AUDIT_ACTIONS.LOGIN_LOCKED : AUDIT_ACTIONS.LOGIN_FAILED,
      actorType: user.role,
      actorId: user.id,
      outcome: 'FAILURE',
      ipHash: hashIp(ctx.ip),
      userAgent: ctx.userAgent,
      correlationId: ctx.correlationId,
      metadata: { attempts, locked: shouldLock },
    },
    db,
  );
}

// ---------------------------------------------------------------------------
// Two-factor
// ---------------------------------------------------------------------------

export interface EnrollmentOffer {
  challengeId: string;
  secret: string;
  keyUri: string;
}

/**
 * Begins TOTP enrolment for an admin whose challenge says they have not
 * enrolled. The secret is held on the challenge row until a valid code proves
 * the authenticator was configured correctly — an unproven secret never
 * becomes the account's second factor.
 */
export async function beginTwoFactorEnrollment(
  challengeId: string,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<EnrollmentOffer> {
  const challenge = await loadChallenge(challengeId, db, clock);

  if (!challenge.enrollment) {
    throw errors.businessRule('Two-factor authentication is already set up for this account.');
  }

  const user = await db.user.findUniqueOrThrow({
    where: { id: challenge.userId },
    select: { email: true },
  });

  const secret = generateTotpSecret();

  await db.twoFactorChallenge.update({
    where: { id: challenge.id },
    data: { pendingSecretEnc: encryptTotpSecret(secret) },
  });

  return { challengeId, secret, keyUri: totpKeyUri(secret, user.email) };
}

export interface TwoFactorResult {
  response: LoginResponse;
  session: IssuedSession;
  /** Returned exactly once, at enrolment. Never retrievable afterwards. */
  recoveryCodes?: string[];
}

export async function verifyTwoFactor(
  input: { challengeId: string; code: string },
  ctx: RequestContext,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<TwoFactorResult> {
  const now = clock.now();
  const challenge = await loadChallenge(input.challengeId, db, clock);

  if (challenge.attempts >= MAX_CHALLENGE_ATTEMPTS) {
    await db.twoFactorChallenge.update({
      where: { id: challenge.id },
      data: { consumedAt: now },
    });
    throw errors.rateLimited('Too many attempts. Sign in again to get a new code prompt.');
  }

  const user = await db.user.findUniqueOrThrow({
    where: { id: challenge.userId },
    include: {
      admin: { select: { fullName: true } },
      doctor: { select: { fullName: true } },
      pharmacyMembership: { select: { pharmacy: { select: { name: true } } } },
      recoveryCodes: { where: { usedAt: null } },
    },
  });

  let recoveryCodes: string[] | undefined;
  let verified = false;

  if (challenge.enrollment) {
    // Enrolment: the code must validate against the pending secret, proving
    // the authenticator app was configured before we commit it.
    if (!challenge.pendingSecretEnc) {
      throw errors.businessRule('Start two-factor setup before submitting a code.');
    }
    verified = verifyTotp(decryptTotpSecret(challenge.pendingSecretEnc), input.code);

    if (verified) {
      const plainCodes = generateRecoveryCodes();
      const hashes = await hashRecoveryCodes(plainCodes);

      await db.user.update({
        where: { id: user.id },
        data: {
          twoFactorSecretEnc: challenge.pendingSecretEnc,
          twoFactorEnabledAt: now,
        },
      });
      await db.twoFactorRecoveryCode.createMany({
        data: hashes.map((codeHash) => ({ userId: user.id, codeHash })),
      });

      recoveryCodes = plainCodes;
      await recordAudit(
        {
          action: AUDIT_ACTIONS.TWO_FACTOR_ENROLLED,
          actorType: user.role,
          actorId: user.id,
          ipHash: hashIp(ctx.ip),
          correlationId: ctx.correlationId,
        },
        db,
      );
    }
  } else {
    if (!user.twoFactorSecretEnc) {
      throw errors.businessRule('Two-factor authentication is not set up for this account.');
    }
    verified = verifyTotp(decryptTotpSecret(user.twoFactorSecretEnc), input.code);

    // A recovery code is accepted in place of a TOTP code, and is single-use.
    if (!verified) {
      for (const stored of user.recoveryCodes) {
        if (await matchesRecoveryCode(stored.codeHash, input.code)) {
          await db.twoFactorRecoveryCode.update({
            where: { id: stored.id },
            data: { usedAt: now },
          });
          verified = true;
          break;
        }
      }
    }
  }

  if (!verified) {
    await db.twoFactorChallenge.update({
      where: { id: challenge.id },
      data: { attempts: { increment: 1 } },
    });
    await recordAudit(
      {
        action: AUDIT_ACTIONS.TWO_FACTOR_FAILED,
        actorType: user.role,
        actorId: user.id,
        outcome: 'FAILURE',
        ipHash: hashIp(ctx.ip),
        correlationId: ctx.correlationId,
        metadata: { attempts: challenge.attempts + 1 },
      },
      db,
    );
    throw errors.twoFactorInvalid();
  }

  await db.twoFactorChallenge.update({
    where: { id: challenge.id },
    data: { consumedAt: now },
  });

  const session = await createSession(user, ctx, db, clock);
  await db.user.update({ where: { id: user.id }, data: { lastLoginAt: now } });

  await recordAudit(
    {
      action: AUDIT_ACTIONS.TWO_FACTOR_SUCCEEDED,
      actorType: user.role,
      actorId: user.id,
      ipHash: hashIp(ctx.ip),
      userAgent: ctx.userAgent,
      correlationId: ctx.correlationId,
    },
    db,
  );
  await recordAudit(
    {
      action: AUDIT_ACTIONS.LOGIN_SUCCEEDED,
      actorType: user.role,
      actorId: user.id,
      ipHash: hashIp(ctx.ip),
      correlationId: ctx.correlationId,
      metadata: { role: user.role, twoFactor: true },
    },
    db,
  );

  return {
    response: {
      status: 'AUTHENTICATED',
      user: {
        publicId: user.publicId,
        email: user.email,
        role: user.role,
        displayName: displayNameFor(user),
        mustEnrollTwoFactor: false,
      },
    },
    session,
    recoveryCodes,
  };
}

async function loadChallenge(challengeId: string, db: Db, clock: Clock) {
  const challenge = await db.twoFactorChallenge.findUnique({ where: { challengeId } });

  if (!challenge || challenge.consumedAt || challenge.expiresAt <= clock.now()) {
    throw errors.unauthenticated('That sign-in attempt has expired. Please sign in again.');
  }
  return challenge;
}

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------

export interface PasswordResetIssue {
  /** Present only when the account exists. The route never reveals which. */
  token?: string;
  email: string;
}

/**
 * Always reports success to the caller. Whether an account exists is not
 * disclosed by the response, the status code, or the timing.
 */
export async function requestPasswordReset(
  email: string,
  ctx: RequestContext,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<PasswordResetIssue> {
  const user = await db.user.findUnique({ where: { email } });

  await recordAudit(
    {
      action: AUDIT_ACTIONS.PASSWORD_RESET_REQUESTED,
      actorType: user?.role ?? 'SYSTEM',
      actorId: user?.id ?? null,
      ipHash: hashIp(ctx.ip),
      correlationId: ctx.correlationId,
      metadata: { accountExists: Boolean(user) },
    },
    db,
  );

  if (!user || user.status === 'DISABLED') {
    return { email };
  }

  const token = generateToken();
  await db.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt: addMinutes(clock.now(), 60),
    },
  });

  return { token, email };
}

export async function confirmPasswordReset(
  input: { token: string; password: string },
  ctx: RequestContext,
  // Requires the full client, not a transaction client: this function OPENS a
  // transaction so the password change and the session revocation are atomic.
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<void> {
  const now = clock.now();

  const record = await db.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(input.token) },
    include: { user: true },
  });

  if (!record || record.usedAt || record.expiresAt <= now) {
    throw errors.unauthenticated('That reset link is no longer valid. Request a new one.');
  }

  const passwordHash = await hashPassword(input.password);

  await db.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: record.userId },
      data: { passwordHash, passwordChangedAt: now, failedLoginCount: 0, lockedUntil: null },
    });
    await tx.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: now } });
    // Every existing session dies with the old password.
    await revokeAllSessionsForUser(record.userId, 'password_reset', tx, clock);
  });

  await recordAudit(
    {
      action: AUDIT_ACTIONS.PASSWORD_RESET_COMPLETED,
      actorType: record.user.role,
      actorId: record.userId,
      ipHash: hashIp(ctx.ip),
      correlationId: ctx.correlationId,
    },
    db,
  );
}

export async function changePassword(
  userId: string,
  input: { currentPassword: string; newPassword: string },
  ctx: RequestContext,
  // Full client — opens a transaction (see confirmPasswordReset).
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<void> {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });

  if (!(await verifyPassword(user.passwordHash, input.currentPassword))) {
    throw errors.unauthenticated('Your current password is not correct.');
  }

  const passwordHash = await hashPassword(input.newPassword);
  const now = clock.now();

  await db.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { passwordHash, passwordChangedAt: now },
    });
    await revokeAllSessionsForUser(userId, 'password_changed', tx, clock);
  });

  await recordAudit(
    {
      action: AUDIT_ACTIONS.PASSWORD_CHANGED,
      actorType: user.role,
      actorId: userId,
      ipHash: hashIp(ctx.ip),
      correlationId: ctx.correlationId,
    },
    db,
  );
}

// ---------------------------------------------------------------------------

type UserWithProfiles = User & {
  admin?: { fullName: string } | null;
  doctor?: { fullName: string } | null;
  pharmacyMembership?: { pharmacy: { name: string } } | null;
};

function displayNameFor(user: UserWithProfiles): string {
  return (
    user.admin?.fullName ??
    user.doctor?.fullName ??
    user.pharmacyMembership?.pharmacy.name ??
    user.email
  );
}
