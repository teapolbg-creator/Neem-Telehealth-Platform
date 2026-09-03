import type { FastifyInstance, FastifyReply } from 'fastify';
import { toDataURL } from 'qrcode';
import {
  changePasswordSchema,
  loginRequestSchema,
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
  twoFactorVerifyRequestSchema,
  type SessionUser,
} from '@neem/contracts';
import { getEnv } from '../../config/env.ts';
import { getNotificationProvider } from '../../adapters/notification/index.ts';
import { requestContext } from '../../middleware/context.ts';
import { requireAuth, requireSession } from '../../middleware/auth.ts';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit.service.ts';
import {
  beginTwoFactorEnrollment,
  changePassword,
  confirmPasswordReset,
  login,
  requestPasswordReset,
  verifyTwoFactor,
} from './auth.service.ts';
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  revokeSession,
  type IssuedSession,
} from './session.service.ts';
import { getPrisma } from '../../db/prisma.ts';
import { hashIp } from '../../lib/crypto.ts';

/**
 * Authentication routes — docs/api.md §2.
 *
 * Login, 2FA and password-reset routes carry their own strict rate limits on
 * top of the global limiter, because they are the endpoints an attacker
 * actually hammers (docs/security.md §6).
 */

function setSessionCookies(reply: FastifyReply, session: IssuedSession) {
  const env = getEnv();
  const secure = env.NODE_ENV === 'production';

  // The session cookie is httpOnly — JavaScript must never be able to read it.
  reply.setCookie(SESSION_COOKIE, session.sessionToken, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    expires: session.absoluteExpiresAt,
  });

  // The CSRF cookie is deliberately readable by JavaScript: the client reads
  // it and echoes it in a header, which is the double-submit pattern.
  reply.setCookie(CSRF_COOKIE, session.csrfToken, {
    httpOnly: false,
    secure,
    sameSite: 'lax',
    path: '/',
    expires: session.absoluteExpiresAt,
  });
}

function clearSessionCookies(reply: FastifyReply) {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
  reply.clearCookie(CSRF_COOKIE, { path: '/' });
}

/**
 * Per-IP limits on the endpoints an attacker hammers. Configurable so a
 * deployment can tighten them, and so tests can exercise both the limiter and
 * the flows it protects (docs/security.md §6).
 */
function authRateLimit() {
  const env = getEnv();
  return { max: env.RATE_LIMIT_AUTH_MAX, timeWindow: env.RATE_LIMIT_AUTH_WINDOW };
}

/**
 * Whether a password-reset message can actually be delivered.
 *
 * Phase 8 built the email adapter, so this is now a real question about the
 * deployment rather than about the code: a mock or a local catcher delivers
 * nothing anyone will read, and the screen must not tell someone to check an
 * inbox in that case (spec §93).
 */
function emailDeliveryConfigured(): boolean {
  return getEnv().EMAIL_PROVIDER === 'smtp';
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/auth/login',
    { config: { rateLimit: authRateLimit() } },
    async (request, reply) => {
      const input = loginRequestSchema.parse(request.body);
      const outcome = await login(input, requestContext(request));

      if (outcome.session) {
        setSessionCookies(reply, outcome.session);
      }

      return reply.send({
        data: outcome.response,
        meta: { requestId: request.correlationId },
      });
    },
  );

  /**
   * Starts TOTP enrolment. Returns the secret and otpauth URI exactly once;
   * nothing is committed to the account until a valid code proves the
   * authenticator was configured.
   */
  app.post(
    '/auth/2fa/enroll',
    { config: { rateLimit: authRateLimit() } },
    async (request, reply) => {
      const { challengeId } = twoFactorVerifyRequestSchema
        .pick({ challengeId: true })
        .parse(request.body);

      const offer = await beginTwoFactorEnrollment(challengeId);

      // The QR is rendered server-side and returned as a data URI, so the web
      // app needs no QR library and the otpauth secret never has to be handled
      // by additional third-party client code.
      const qrDataUrl = await toDataURL(offer.keyUri, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 240,
      });

      return reply.send({
        data: {
          secret: offer.secret,
          keyUri: offer.keyUri,
          qrDataUrl,
          challengeId: offer.challengeId,
        },
        meta: { requestId: request.correlationId },
      });
    },
  );

  app.post(
    '/auth/2fa/verify',
    { config: { rateLimit: authRateLimit() } },
    async (request, reply) => {
      const input = twoFactorVerifyRequestSchema.parse(request.body);
      const result = await verifyTwoFactor(input, requestContext(request));

      setSessionCookies(reply, result.session);

      return reply.send({
        data: {
          ...result.response,
          // Shown once, at enrolment. There is no route to retrieve them later.
          ...(result.recoveryCodes ? { recoveryCodes: result.recoveryCodes } : {}),
        },
        meta: { requestId: request.correlationId },
      });
    },
  );

  app.post('/auth/logout', { preHandler: requireSession }, async (request, reply) => {
    const principal = requireAuth(request);

    await revokeSession(principal.sessionId, 'user_logout');
    await recordAudit({
      action: AUDIT_ACTIONS.LOGOUT,
      actorType: principal.role,
      actorId: principal.userId,
      ipHash: hashIp(request.ip),
      correlationId: request.correlationId,
    });

    clearSessionCookies(reply);
    return reply.send({ data: { status: 'SIGNED_OUT' }, meta: { requestId: request.correlationId } });
  });

  /** The web app calls this on boot to resolve the current principal. */
  app.get('/auth/me', async (request, reply) => {
    const principal = request.principal;

    if (!principal) {
      return reply.send({ data: null, meta: { requestId: request.correlationId } });
    }

    const prisma = getPrisma();
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: principal.userId },
      include: {
        admin: { select: { fullName: true } },
        doctor: { select: { publicId: true, fullName: true, status: true } },
        pharmacyMembership: {
          select: { pharmacy: { select: { publicId: true, name: true, status: true } } },
        },
      },
    });

    const organisation =
      user.doctor
        ? { publicId: user.doctor.publicId, name: user.doctor.fullName, status: user.doctor.status }
        : user.pharmacyMembership
          ? {
              publicId: user.pharmacyMembership.pharmacy.publicId,
              name: user.pharmacyMembership.pharmacy.name,
              status: user.pharmacyMembership.pharmacy.status,
            }
          : null;

    const data: SessionUser = {
      publicId: user.publicId,
      email: user.email,
      role: user.role,
      displayName:
        user.admin?.fullName ??
        user.doctor?.fullName ??
        user.pharmacyMembership?.pharmacy.name ??
        user.email,
      twoFactorEnabled: user.twoFactorEnabledAt !== null,
      mustEnrollTwoFactor: user.role === 'ADMIN' && user.twoFactorEnabledAt === null,
      permissions: principal.permissions,
      organisation,
    };

    return reply.send({ data, meta: { requestId: request.correlationId } });
  });

  app.post(
    '/auth/password-reset/request',
    { config: { rateLimit: authRateLimit() } },
    async (request, reply) => {
      const input = passwordResetRequestSchema.parse(request.body);
      const issued = await requestPasswordReset(input.email, requestContext(request));

      /**
       * The link, by email.
       *
       * Not routed through `notify()`. That path stores a hash of what it
       * sent and retries what failed, both of which are wrong for a
       * credential: a reset link must not be re-sent by a background job
       * minutes later, and there is no version of "notification history" that
       * should be able to reconstruct one. It goes to one address, once,
       * through the adapter directly.
       */
      if (issued.token) {
        const link = `${getEnv().WEB_ORIGIN}/auth/reset?token=${issued.token}`;

        void getNotificationProvider('EMAIL')
          .send({
            to: input.email,
            subject: 'Reset your Neem password',
            body:
              `Someone asked to reset the password for this Neem account.\n\n` +
              `${link}\n\n` +
              `The link expires shortly and can be used once. If this was not you, ` +
              `ignore this message — your password has not changed.`,
            reference: `pwreset_${issued.token.slice(0, 8)}`,
          })
          .catch((error: unknown) => {
            // Never surfaced to the caller: whether an address exists must not
            // be inferable from how this route behaves.
            request.log.error({ err: error }, 'password reset email could not be sent');
          });

        // Development still logs the path, because a local catcher is not
        // always running and a developer needs the link either way.
        if (getEnv().NODE_ENV !== 'production') {
          request.log.warn(
            { resetPath: `/auth/reset?token=${issued.token}` },
            'password reset token issued (development)',
          );
        }
      }

      /**
       * Identical response whether or not the account exists — except for one
       * fact that has nothing to do with the account: whether Neem can deliver
       * a message at all.
       *
       * The screen needs it. Telling someone "check your email" when no email
       * will ever arrive is exactly the pretence spec §93 forbids, and it
       * would leave a locked-out pharmacist refreshing an inbox instead of
       * calling their administrator.
       */
      return reply.send({
        data: { status: 'REQUESTED', deliveryConfigured: emailDeliveryConfigured() },
        meta: { requestId: request.correlationId },
      });
    },
  );

  app.post(
    '/auth/password-reset/confirm',
    { config: { rateLimit: authRateLimit() } },
    async (request, reply) => {
      const input = passwordResetConfirmSchema.parse(request.body);
      await confirmPasswordReset(input, requestContext(request));

      clearSessionCookies(reply);
      return reply.send({ data: { status: 'RESET' }, meta: { requestId: request.correlationId } });
    },
  );

  app.post('/auth/password', { preHandler: requireSession }, async (request, reply) => {
    const principal = requireAuth(request);
    const input = changePasswordSchema.parse(request.body);

    await changePassword(principal.userId, input, requestContext(request));

    clearSessionCookies(reply);
    return reply.send({
      data: { status: 'CHANGED', reauthenticationRequired: true },
      meta: { requestId: request.correlationId },
    });
  });
}
