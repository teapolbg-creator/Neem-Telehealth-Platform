import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { getEnv, mockedProviders } from './config/env.ts';
import { getLogger } from './lib/logger.ts';
import { contextPlugin } from './middleware/context.ts';
import { authPlugin } from './middleware/auth.ts';
import { errorHandlerPlugin } from './middleware/error-handler.ts';
import multipart from '@fastify/multipart';
import { authRoutes } from './modules/auth/auth.routes.ts';
import { onboardingRoutes } from './modules/onboarding/onboarding.routes.ts';
import { doctorRoutes } from './modules/doctor/doctor.routes.ts';
import { pharmacyRoutes } from './modules/pharmacy/pharmacy.routes.ts';
import { adminRoutes } from './modules/admin/admin.routes.ts';
import { patientRoutes } from './modules/consultation/patient.routes.ts';
import { pharmacyConsultationRoutes } from './modules/consultation/pharmacy-consultation.routes.ts';
import { webhookRoutes } from './modules/payment/webhook.routes.ts';
import { refundRoutes } from './modules/payment/refund.routes.ts';
import { payoutRoutes } from './modules/payment/payout.routes.ts';
import { queueRoutes } from './modules/queue/queue.routes.ts';
import { mediaRoutes } from './modules/media/media.routes.ts';
import { retentionRoutes } from './modules/retention/retention.routes.ts';
import { clinicalRoutes } from './modules/clinical/clinical.routes.ts';
import { healthRoutes } from './modules/health/health.routes.ts';

/**
 * Fastify application factory.
 *
 * Separated from server.ts so integration tests can build an app and drive it
 * with `app.inject()` — no listening socket, no port collisions, real routing
 * and real middleware.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const env = getEnv();

  const app = Fastify({
    // Supplying a pino instance would otherwise narrow Fastify's logger
    // generic to pino's own Logger type, which then conflicts with the
    // FastifyBaseLogger that plugins are typed against.
    loggerInstance: getLogger() as unknown as FastifyBaseLogger,
    // Only trust proxy headers behind a real proxy. Left false in development
    // so a client cannot spoof its IP past the rate limiter.
    trustProxy: env.NODE_ENV === 'production',
    // Request logging is silenced in tests by LOG_LEVEL=silent on the logger
    // itself, rather than by Fastify's deprecated disableRequestLogging flag.
    bodyLimit: 1024 * 1024,
    ajv: { customOptions: { removeAdditional: false } },
  });

  await app.register(errorHandlerPlugin);
  await app.register(contextPlugin);

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    hsts: env.NODE_ENV === 'production' ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  });

  // Explicit allow-list. Credentials are enabled only for the known web origin,
  // because the session travels as a cookie.
  await app.register(cors, {
    origin: [env.WEB_ORIGIN],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['content-type', 'x-neem-csrf', 'x-correlation-id'],
  });

  await app.register(cookie, { secret: env.SESSION_SECRET });

  await app.register(rateLimit, {
    global: true,
    max: env.RATE_LIMIT_MAX_PER_MINUTE,
    timeWindow: '1 minute',
    /**
     * Keyed by IP in practice, not by principal.
     *
     * This plugin registers its `onRequest` hook here, before `authPlugin`
     * below, so `request.principal` is always undefined when this runs and the
     * fallback is what actually applies. The `??` is kept for the day the
     * ordering changes, but the comment that used to claim per-principal
     * limiting was simply wrong.
     *
     * The ordering is deliberate and stays: limiting before authentication is
     * what keeps a flood of requests from reaching the session lookup at all.
     * The cost is that everyone behind one NAT — a pharmacy's staff, say —
     * shares a budget. Whether that budget is right for a busy pharmacy with
     * several patients polling is a real question, and one for the Phase 10
     * security pass rather than a late change to DoS-relevant ordering.
     */
    keyGenerator: (request) => request.principal?.userId ?? request.ip,
  });

  // Credential document uploads. The size cap is configurable and enforced
  // again in the document service against the decoded buffer.
  await app.register(multipart, {
    limits: { fileSize: env.UPLOAD_MAX_BYTES, files: 1, fields: 10 },
  });

  await app.register(authPlugin);

  await app.register(
    async (api) => {
      await api.register(healthRoutes);
      await api.register(authRoutes);
      await api.register(onboardingRoutes);
      await api.register(doctorRoutes);
      await api.register(pharmacyRoutes);
      await api.register(adminRoutes);
      await api.register(patientRoutes);
      await api.register(pharmacyConsultationRoutes);
      await api.register(queueRoutes);
      await api.register(mediaRoutes);
      await api.register(retentionRoutes);
      await api.register(clinicalRoutes);
      await api.register(refundRoutes);
      await api.register(payoutRoutes);
    },
    { prefix: '/api/v1' },
  );

  // Webhooks live in their own scope: they need the raw body for signature
  // verification, which must not affect JSON parsing for every other route.
  await app.register(
    async (hooks) => {
      await hooks.register(webhookRoutes);
    },
    { prefix: '/api/v1' },
  );

  const mocked = mockedProviders(env);
  if (mocked.length > 0) {
    app.log.warn(
      { mocked },
      'running with MOCK providers — no real payment, call or message will occur',
    );
  }

  return app;
}
