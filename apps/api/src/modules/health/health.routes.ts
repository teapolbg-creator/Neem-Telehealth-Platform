import type { FastifyInstance } from 'fastify';
import { getEnv, mockedProviders } from '../../config/env.ts';
import { getPrisma } from '../../db/prisma.ts';

/**
 * Health and readiness.
 *
 * `/health` is a liveness probe and stays cheap. `/health/ready` checks the
 * database, because a process that cannot reach MySQL is not ready to serve.
 * Both report which providers are mocked, so the admin dashboard can show
 * demo mode honestly rather than implying a live integration (spec §88, §93).
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (request, reply) =>
    reply.send({
      data: { status: 'ok', service: 'neem-api' },
      meta: { requestId: request.correlationId },
    }),
  );

  app.get('/health/ready', async (request, reply) => {
    const env = getEnv();
    const started = Date.now();

    let database: { status: 'up' | 'down'; latencyMs?: number; error?: string };
    try {
      await getPrisma().$queryRaw`SELECT 1`;
      database = { status: 'up', latencyMs: Date.now() - started };
    } catch (error) {
      request.log.error({ err: error }, 'database readiness check failed');
      database = { status: 'down', error: 'unreachable' };
    }

    const mocked = mockedProviders(env);
    const ready = database.status === 'up';

    return reply.status(ready ? 200 : 503).send({
      data: {
        status: ready ? 'ready' : 'degraded',
        environment: env.NODE_ENV,
        database,
        providers: {
          payment: env.PAYMENT_PROVIDER,
          video: env.VIDEO_PROVIDER,
          voice: env.VOICE_PROVIDER,
          sms: env.SMS_PROVIDER,
          email: env.EMAIL_PROVIDER,
          whatsapp: env.WHATSAPP_PROVIDER,
        },
        mockedProviders: mocked,
        demoMode: mocked.length > 0,
      },
      meta: { requestId: request.correlationId },
    });
  });
}
