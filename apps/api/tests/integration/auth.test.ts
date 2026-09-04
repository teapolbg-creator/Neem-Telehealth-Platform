import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import { getPrisma, disconnectPrisma } from '../../src/db/prisma.ts';
import { encryptTotpSecret } from '../../src/modules/auth/totp.service.ts';
import { closeTestApp, request, signIn } from '../helpers/app.ts';
import { createTestUser, resetDatabase } from '../helpers/database.ts';

/**
 * Authentication, exercised end to end against a real database.
 *
 * These verify the security properties the specification actually requires
 * (spec §9, §59, §79), not merely that the happy path returns 200.
 */

const PHARMACY = { email: 'pharmacy@test.local', password: 'PharmacyPassword123!' };
const ADMIN = { email: 'admin@test.local', password: 'AdminPassword123!' };

beforeAll(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeTestApp();
  await disconnectPrisma();
});

beforeEach(async () => {
  await resetDatabase();
});

describe('POST /auth/login', () => {
  it('signs in a pharmacy account and issues session and CSRF cookies', async () => {
    await createTestUser({ ...PHARMACY, role: 'PHARMACY' });

    const response = await request('/auth/login', { method: 'POST', payload: PHARMACY });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      status: 'AUTHENTICATED',
      user: { email: PHARMACY.email, role: 'PHARMACY' },
    });
    expect(response.cookies.neem_session).toBeTruthy();
    expect(response.cookies.neem_csrf).toBeTruthy();
  });

  it('stores only a hash of the session token, never the token itself', async () => {
    await createTestUser({ ...PHARMACY, role: 'PHARMACY' });
    const response = await request('/auth/login', { method: 'POST', payload: PHARMACY });

    const rawToken = response.cookies.neem_session!;
    const sessions = await getPrisma().session.findMany();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.tokenHash).not.toBe(rawToken);
    expect(sessions[0]!.tokenHash).toHaveLength(64);
  });

  it('gives the same response for a wrong password and an unknown account', async () => {
    await createTestUser({ ...PHARMACY, role: 'PHARMACY' });

    const wrongPassword = await request('/auth/login', {
      method: 'POST',
      payload: { email: PHARMACY.email, password: 'WrongPassword123!' },
    });
    const unknownAccount = await request('/auth/login', {
      method: 'POST',
      payload: { email: 'nobody@test.local', password: 'WrongPassword123!' },
    });

    expect(wrongPassword.status).toBe(401);
    expect(unknownAccount.status).toBe(401);
    // Identical code and message — the API must not disclose which accounts exist.
    expect(wrongPassword.body.error?.code).toBe(unknownAccount.body.error?.code);
    expect(wrongPassword.body.error?.message).toBe(unknownAccount.body.error?.message);
    expect(wrongPassword.cookies.neem_session).toBeUndefined();
  });

  it('refuses a suspended account even with the correct password', async () => {
    await createTestUser({ ...PHARMACY, role: 'PHARMACY', status: 'SUSPENDED' });

    const response = await request('/auth/login', { method: 'POST', payload: PHARMACY });

    expect(response.status).toBe(403);
    expect(response.body.error?.code).toBe('ACCOUNT_NOT_ACTIVE');
    expect(response.cookies.neem_session).toBeUndefined();
  });

  it('locks the account after the configured number of failures', async () => {
    await createTestUser({ ...PHARMACY, role: 'PHARMACY' });

    // Default LOGIN_MAX_ATTEMPTS is 5.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await request('/auth/login', {
        method: 'POST',
        payload: { email: PHARMACY.email, password: 'WrongPassword123!' },
      });
    }

    // The correct password must now be refused — lockout is not bypassable.
    const response = await request('/auth/login', { method: 'POST', payload: PHARMACY });

    expect(response.status).toBe(429);
    expect(response.body.error?.code).toBe('ACCOUNT_LOCKED');

    const user = await getPrisma().user.findUniqueOrThrow({ where: { email: PHARMACY.email } });
    expect(user.lockedUntil).not.toBeNull();
  });

  it('clears the failure counter after a successful sign-in', async () => {
    await createTestUser({ ...PHARMACY, role: 'PHARMACY' });

    await request('/auth/login', {
      method: 'POST',
      payload: { email: PHARMACY.email, password: 'WrongPassword123!' },
    });
    await request('/auth/login', { method: 'POST', payload: PHARMACY });

    const user = await getPrisma().user.findUniqueOrThrow({ where: { email: PHARMACY.email } });
    expect(user.failedLoginCount).toBe(0);
  });

  it('rejects a malformed request body', async () => {
    const response = await request('/auth/login', {
      method: 'POST',
      payload: { email: 'not-an-email', password: '' },
    });

    expect(response.status).toBe(400);
    expect(response.body.error?.code).toBe('VALIDATION_FAILED');
  });

  it('writes an audit entry for both success and failure', async () => {
    await createTestUser({ ...PHARMACY, role: 'PHARMACY' });

    await request('/auth/login', { method: 'POST', payload: PHARMACY });
    await request('/auth/login', {
      method: 'POST',
      payload: { email: PHARMACY.email, password: 'WrongPassword123!' },
    });

    const logs = await getPrisma().auditLog.findMany({ orderBy: { occurredAt: 'asc' } });
    const actions = logs.map((entry) => entry.action);

    expect(actions).toContain('auth.login.succeeded');
    expect(actions).toContain('auth.login.failed');
    // The password must never reach the audit log.
    expect(JSON.stringify(logs)).not.toContain(PHARMACY.password);
  });
});

describe('admin two-factor authentication (spec §9)', () => {
  it('does not issue a session on password alone — it returns a challenge', async () => {
    await createTestUser({ ...ADMIN, role: 'ADMIN' });

    const response = await request('/auth/login', { method: 'POST', payload: ADMIN });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      status: 'TWO_FACTOR_REQUIRED',
      enrollmentRequired: true,
    });
    // Critically: no session cookie at this point.
    expect(response.cookies.neem_session).toBeUndefined();
  });

  it('completes enrolment and returns single-use recovery codes', async () => {
    await createTestUser({ ...ADMIN, role: 'ADMIN' });

    const login = await request<{ status: string; challengeId: string }>('/auth/login', {
      method: 'POST',
      payload: ADMIN,
    });
    const challengeId = (login.body.data as { challengeId: string }).challengeId;

    const enroll = await request<{ secret: string; qrDataUrl: string }>('/auth/2fa/enroll', {
      method: 'POST',
      payload: { challengeId },
    });

    expect(enroll.status).toBe(200);
    expect(enroll.body.data?.secret).toBeTruthy();
    expect(enroll.body.data?.qrDataUrl).toMatch(/^data:image\/png;base64,/);

    const code = authenticator.generate(enroll.body.data!.secret);
    const verify = await request<{ status: string; recoveryCodes: string[] }>('/auth/2fa/verify', {
      method: 'POST',
      payload: { challengeId, code },
    });

    expect(verify.status).toBe(200);
    expect(verify.body.data?.status).toBe('AUTHENTICATED');
    expect(verify.body.data?.recoveryCodes).toHaveLength(10);
    expect(verify.cookies.neem_session).toBeTruthy();

    // The secret is committed only once a valid code proved the app was set up.
    const user = await getPrisma().user.findUniqueOrThrow({ where: { email: ADMIN.email } });
    expect(user.twoFactorEnabledAt).not.toBeNull();
    expect(user.twoFactorSecretEnc).toBeTruthy();
    // Encrypted at rest, not stored in the clear.
    expect(user.twoFactorSecretEnc).not.toContain(enroll.body.data!.secret);
  });

  it('rejects an incorrect code and issues no session', async () => {
    const secret = authenticator.generateSecret(20);
    await createTestUser({
      ...ADMIN,
      role: 'ADMIN',
      twoFactorSecretEnc: encryptTotpSecret(secret),
      twoFactorEnabled: true,
    });

    const login = await request('/auth/login', { method: 'POST', payload: ADMIN });
    const challengeId = (login.body.data as { challengeId: string }).challengeId;

    const verify = await request('/auth/2fa/verify', {
      method: 'POST',
      payload: { challengeId, code: '000000' },
    });

    expect(verify.status).toBe(401);
    expect(verify.body.error?.code).toBe('TWO_FACTOR_INVALID');
    expect(verify.cookies.neem_session).toBeUndefined();
  });

  it('accepts a recovery code once and never again', async () => {
    const secret = authenticator.generateSecret(20);
    await createTestUser({
      ...ADMIN,
      role: 'ADMIN',
      twoFactorSecretEnc: encryptTotpSecret(secret),
      twoFactorEnabled: true,
    });

    // Enrol properly to obtain real recovery codes.
    const prisma = getPrisma();
    await prisma.user.update({
      where: { email: ADMIN.email },
      data: { twoFactorEnabledAt: null, twoFactorSecretEnc: null },
    });

    const firstLogin = await request('/auth/login', { method: 'POST', payload: ADMIN });
    const enrollChallenge = (firstLogin.body.data as { challengeId: string }).challengeId;
    const enroll = await request<{ secret: string }>('/auth/2fa/enroll', {
      method: 'POST',
      payload: { challengeId: enrollChallenge },
    });
    const enrolled = await request<{ recoveryCodes: string[] }>('/auth/2fa/verify', {
      method: 'POST',
      payload: {
        challengeId: enrollChallenge,
        code: authenticator.generate(enroll.body.data!.secret),
      },
    });
    const recoveryCode = enrolled.body.data!.recoveryCodes[0]!;

    // First use: accepted.
    const secondLogin = await request('/auth/login', { method: 'POST', payload: ADMIN });
    const firstUse = await request('/auth/2fa/verify', {
      method: 'POST',
      payload: {
        challengeId: (secondLogin.body.data as { challengeId: string }).challengeId,
        code: recoveryCode,
      },
    });
    expect(firstUse.status).toBe(200);

    // Second use of the same code: refused.
    const thirdLogin = await request('/auth/login', { method: 'POST', payload: ADMIN });
    const reuse = await request('/auth/2fa/verify', {
      method: 'POST',
      payload: {
        challengeId: (thirdLogin.body.data as { challengeId: string }).challengeId,
        code: recoveryCode,
      },
    });
    expect(reuse.status).toBe(401);
  });

  it('refuses a consumed challenge, so a challenge id cannot be replayed', async () => {
    const secret = authenticator.generateSecret(20);
    await createTestUser({
      ...ADMIN,
      role: 'ADMIN',
      twoFactorSecretEnc: encryptTotpSecret(secret),
      twoFactorEnabled: true,
    });

    const login = await request('/auth/login', { method: 'POST', payload: ADMIN });
    const challengeId = (login.body.data as { challengeId: string }).challengeId;

    const first = await request('/auth/2fa/verify', {
      method: 'POST',
      payload: { challengeId, code: authenticator.generate(secret) },
    });
    expect(first.status).toBe(200);

    const replay = await request('/auth/2fa/verify', {
      method: 'POST',
      payload: { challengeId, code: authenticator.generate(secret) },
    });
    expect(replay.status).toBe(401);
  });
});

describe('GET /auth/me', () => {
  it('returns null when unauthenticated rather than erroring', async () => {
    const response = await request('/auth/me');

    expect(response.status).toBe(200);
    expect(response.body.data).toBeNull();
  });

  it('returns the principal and its resolved permissions', async () => {
    await createTestUser({ ...PHARMACY, role: 'PHARMACY' });
    const cookies = await signIn(PHARMACY.email, PHARMACY.password);

    const response = await request<{ role: string; permissions: string[] }>('/auth/me', {
      cookies,
    });

    expect(response.status).toBe(200);
    expect(response.body.data?.role).toBe('PHARMACY');
    expect(response.body.data?.permissions).toContain('consultation:create');
    // A pharmacy must never hold prescription-authoring permissions (spec §104).
    expect(response.body.data?.permissions).not.toContain('prescription:create');
    expect(response.body.data?.permissions).not.toContain('audit:read');
  });

  it('rejects a forged session cookie', async () => {
    const response = await request('/auth/me', {
      cookies: { neem_session: 'not-a-real-session-token' },
    });

    expect(response.body.data).toBeNull();
  });
});

describe('session lifecycle', () => {
  it('ends the session on logout', async () => {
    await createTestUser({ ...PHARMACY, role: 'PHARMACY' });
    const cookies = await signIn(PHARMACY.email, PHARMACY.password);

    const logout = await request('/auth/logout', { method: 'POST', cookies });
    expect(logout.status).toBe(200);

    const after = await request('/auth/me', { cookies });
    expect(after.body.data).toBeNull();
  });

  it('invalidates a live session the moment the account is suspended', async () => {
    // The reason opaque server-side sessions were chosen over JWT (decision D4).
    const user = await createTestUser({ ...PHARMACY, role: 'PHARMACY' });
    const cookies = await signIn(PHARMACY.email, PHARMACY.password);

    expect((await request('/auth/me', { cookies })).body.data).not.toBeNull();

    await getPrisma().user.update({ where: { id: user.id }, data: { status: 'SUSPENDED' } });

    expect((await request('/auth/me', { cookies })).body.data).toBeNull();
  });

  it('rejects an expired session', async () => {
    await createTestUser({ ...PHARMACY, role: 'PHARMACY' });
    const cookies = await signIn(PHARMACY.email, PHARMACY.password);

    await getPrisma().session.updateMany({
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    expect((await request('/auth/me', { cookies })).body.data).toBeNull();
  });
});

describe('CSRF protection', () => {
  it('refuses a mutating request that omits the CSRF header', async () => {
    await createTestUser({ ...PHARMACY, role: 'PHARMACY' });
    const cookies = await signIn(PHARMACY.email, PHARMACY.password);

    const response = await request('/auth/logout', {
      method: 'POST',
      cookies,
      withCsrf: false,
    });

    expect(response.status).toBe(403);
    expect(response.body.error?.code).toBe('CSRF_INVALID');
  });

  it('refuses a mismatched CSRF token', async () => {
    await createTestUser({ ...PHARMACY, role: 'PHARMACY' });
    const cookies = await signIn(PHARMACY.email, PHARMACY.password);

    const response = await request('/auth/logout', {
      method: 'POST',
      cookies,
      withCsrf: false,
      headers: { 'x-neem-csrf': 'wrong-token-value' },
    });

    expect(response.status).toBe(403);
  });
});

describe('password reset', () => {
  it('responds identically whether or not the account exists', async () => {
    await createTestUser({ ...PHARMACY, role: 'PHARMACY' });

    const known = await request('/auth/password-reset/request', {
      method: 'POST',
      payload: { email: PHARMACY.email },
    });
    const unknown = await request('/auth/password-reset/request', {
      method: 'POST',
      payload: { email: 'nobody@test.local' },
    });

    expect(known.status).toBe(unknown.status);
    expect(JSON.stringify(known.body.data)).toBe(JSON.stringify(unknown.body.data));
  });

  /**
   * The screen at /auth/forgot renders a different confirmation depending on
   * this flag. Telling someone to check an inbox that will never receive
   * anything is the pretence spec §93 forbids, and it would leave a
   * locked-out pharmacist waiting instead of calling their administrator.
   */
  it('says whether a reset message can actually be delivered', async () => {
    const response = await request<{ deliveryConfigured: boolean }>(
      '/auth/password-reset/request',
      { method: 'POST', payload: { email: 'anyone@test.local' } },
    );

    // False until the Phase 8 email adapter exists.
    expect(response.body.data?.deliveryConfigured).toBe(false);
  });

  it('issues a single-use token that ends every existing session', async () => {
    const user = await createTestUser({ ...PHARMACY, role: 'PHARMACY' });
    const cookies = await signIn(PHARMACY.email, PHARMACY.password);

    await request('/auth/password-reset/request', {
      method: 'POST',
      payload: { email: PHARMACY.email },
    });

    // The raw token is never persisted, so the test reproduces the flow through
    // the service rather than reading it from the database.
    const { requestPasswordReset } = await import('../../src/modules/auth/auth.service.ts');
    const issued = await requestPasswordReset(PHARMACY.email, {});
    expect(issued.token).toBeTruthy();

    const confirm = await request('/auth/password-reset/confirm', {
      method: 'POST',
      payload: { token: issued.token, password: 'BrandNewPassword123!' },
    });
    expect(confirm.status).toBe(200);

    // Old session is dead.
    expect((await request('/auth/me', { cookies })).body.data).toBeNull();

    // Old password no longer works; the new one does.
    const oldPassword = await request('/auth/login', { method: 'POST', payload: PHARMACY });
    expect(oldPassword.status).toBe(401);

    const newPassword = await request('/auth/login', {
      method: 'POST',
      payload: { email: PHARMACY.email, password: 'BrandNewPassword123!' },
    });
    expect(newPassword.status).toBe(200);

    // The token cannot be replayed.
    const replay = await request('/auth/password-reset/confirm', {
      method: 'POST',
      payload: { token: issued.token, password: 'AnotherPassword123!' },
    });
    expect(replay.status).toBe(401);

    expect(user.id).toBeTruthy();
  });
});
