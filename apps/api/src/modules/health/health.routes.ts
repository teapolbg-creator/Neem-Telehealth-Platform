import type { FastifyInstance } from 'fastify';
import { PERMISSIONS } from '@neem/contracts';
import { guard } from '../../middleware/auth.ts';
import { getEnv, mockedProviders } from '../../config/env.ts';
import { getPrisma } from '../../db/prisma.ts';

/**
 * Health and readiness.
 *
 * `/health` is a liveness probe and stays cheap. `/health/ready` checks the
 * database, because a process that cannot reach the database is not ready to serve.
 * Both are unauthenticated, so both say only whether this instance can serve
 * traffic.
 *
 * Which providers are mocked — the honest demo-mode picture the admin
 * dashboard needs (spec §88, §93) — is at `/admin/system-health` below,
 * because that is configuration and strangers have no business reading it.
 */
/**
 * The commit this process is running, shortened (D62).
 *
 * **Why it is here at all.** A deploy could not be verified from outside: every
 * build answers `/health` identically, so "is the new code live?" could only be
 * inferred from a behaviour change, and when a release added no new route there
 * was nothing to ask. That produced three wrong calls in one afternoon,
 * including reporting a deploy as live while it was returning 502.
 *
 * **Why only seven characters.** This endpoint is unauthenticated, and an exact
 * build identifier is a small piece of information about a system an attacker
 * would otherwise have to guess at. Seven hex characters are enough for an
 * operator to compare against `git rev-parse --short HEAD` and worth nothing to
 * anyone without the repository, which is private. The full SHA stays out of
 * public responses.
 */
function runningCommit(): string {
  const env = getEnv();
  const commit = env.RENDER_GIT_COMMIT ?? env.GIT_COMMIT;

  return commit ? commit.slice(0, 7) : 'unknown';
}

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (request, reply) =>
    reply.send({
      data: { status: 'ok', service: 'neem-api', commit: runningCommit() },
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

    /**
     * A readiness probe, and nothing more.
     *
     * This used to return the environment, the database latency, every
     * configured provider by name, which of them were mocked, and a
     * `demoMode` flag — to any anonymous caller. None of that is needed to
     * decide whether an instance should receive traffic, and all of it is
     * reconnaissance: it tells someone probing exactly which integrations to
     * aim at, and in production `demoMode: true` would advertise that
     * payments were not real.
     *
     * A load balancer needs "can this instance serve requests". The detail
     * moved to `GET /admin/system-health`, behind authentication.
     */
    return reply.status(ready ? 200 : 503).send({
      // The commit here too, so one request answers both 'is it up' and
      // 'is it the build I just pushed' (D62).
      data: { status: ready ? 'ready' : 'degraded', commit: runningCommit() },
      meta: { requestId: request.correlationId },
    });
  });

  /**
   * System health for an administrator (spec §54).
   *
   * The same picture the readiness probe used to give away, now to someone
   * entitled to it. `demoMode` matters most here: an administrator needs to
   * know at a glance whether this deployment can actually take money and send
   * messages, and the answer must not be inferable by strangers.
   */
  app.get(
    '/admin/system-health',
    { preHandler: guard({ roles: ['ADMIN'], permissions: [PERMISSIONS.SYSTEM_HEALTH_READ] }) },
    async (request, reply) => {
      const env = getEnv();
      const started = Date.now();

      let database: { status: 'up' | 'down'; latencyMs?: number };
      try {
        await getPrisma().$queryRaw`SELECT 1`;
        database = { status: 'up', latencyMs: Date.now() - started };
      } catch {
        database = { status: 'down' };
      }

      const mocked = mockedProviders(env);

      return reply.send({
        data: {
          status: database.status === 'up' ? 'ready' : 'degraded',
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
    },
  );
}
