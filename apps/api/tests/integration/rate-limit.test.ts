import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.ts';
import { loadEnv, setEnvForTesting } from '../../src/config/env.ts';
import { disconnectPrisma } from '../../src/db/prisma.ts';
import { createTestUser, resetDatabase } from '../helpers/database.ts';

/**
 * Auth rate limiting (spec §59, §79).
 *
 * The rest of the suite runs with a high limit so that exercising sign-in
 * repeatedly does not throttle unrelated tests. That would leave the limiter
 * untested, so this file builds a *separate* application with a deliberately
 * low limit and proves it engages.
 *
 * This is distinct from account lockout, which is verified in auth.test.ts:
 * lockout protects one account; this protects against one source spraying many
 * accounts.
 */

const LIMIT = 3;
let strictApp: FastifyInstance;

beforeAll(async () => {
  await resetDatabase();
  await createTestUser({
    email: 'ratelimit@test.local',
    password: 'RateLimitPassword123!',
    role: 'PHARMACY',
  });

  // Install a configuration with a low auth limit, build an app against it,
  // then restore the suite-wide configuration.
  const strictEnv = loadEnv({ ...process.env, RATE_LIMIT_AUTH_MAX: String(LIMIT) });
  setEnvForTesting(strictEnv);
  strictApp = await buildApp();
  await strictApp.ready();
  setEnvForTesting(undefined);
});

afterAll(async () => {
  await strictApp.close();
  await disconnectPrisma();
});

async function attemptLogin(email: string) {
  return strictApp.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: 'DefinitelyWrongPassword123!' },
  });
}

describe('auth endpoint rate limiting', () => {
  it('refuses further attempts from one source once the limit is reached', async () => {
    const statuses: number[] = [];

    for (let attempt = 0; attempt < LIMIT + 2; attempt += 1) {
      const response = await attemptLogin('ratelimit@test.local');
      statuses.push(response.statusCode);
    }

    // The first LIMIT attempts are processed (401 — wrong password).
    expect(statuses.slice(0, LIMIT)).toEqual(Array(LIMIT).fill(401));
    // Everything beyond the limit is refused before reaching the handler.
    expect(statuses.slice(LIMIT)).toEqual([429, 429]);
  });

  it('limits by source, not by account — spraying many accounts does not evade it', async () => {
    // A fresh app so this test starts with an empty limiter bucket.
    const strictEnv = loadEnv({ ...process.env, RATE_LIMIT_AUTH_MAX: String(LIMIT) });
    setEnvForTesting(strictEnv);
    const app = await buildApp();
    await app.ready();
    setEnvForTesting(undefined);

    try {
      const statuses: number[] = [];
      for (let attempt = 0; attempt < LIMIT + 1; attempt += 1) {
        // A different email every time — per-account lockout would not fire.
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { email: `sprayed-${attempt}@test.local`, password: 'Whatever123456!' },
        });
        statuses.push(response.statusCode);
      }

      expect(statuses.at(-1)).toBe(429);
    } finally {
      await app.close();
    }
  });

  it('returns a machine-readable code the client can branch on', async () => {
    const response = await attemptLogin('ratelimit@test.local');

    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({
      error: { code: 'RATE_LIMITED' },
      meta: { requestId: expect.any(String) },
    });
  });
});
