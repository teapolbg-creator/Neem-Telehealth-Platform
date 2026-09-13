import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setEnvForTesting } from '../../src/config/env.ts';
import { disconnectPrisma } from '../../src/db/prisma.ts';
import { closeTestApp, getTestApp } from '../helpers/app.ts';

/**
 * Credentials are allowed for the app's origin and no other (D47).
 *
 * The CSRF cookie is shared across the parent domain so the app can read it,
 * which makes it readable on the marketing site too. That is harmless only
 * while the marketing site cannot also send the session cookie — so the one
 * thing this file protects is `Access-Control-Allow-Credentials` being absent
 * for that origin, while the origin itself stays allowed for the pilot form.
 */

const APP = 'https://app.neem.example';
const MARKETING = 'https://neem.example';
const ORIGINS = { WEB_ORIGIN: APP, MARKETING_ORIGIN: MARKETING };

let previous: Record<string, string | undefined> = {};

beforeAll(() => {
  // Before the first request, because the CORS allow-list is read when the
  // application is built.
  previous = Object.fromEntries(Object.keys(ORIGINS).map((key) => [key, process.env[key]]));
  Object.assign(process.env, ORIGINS);
  setEnvForTesting(undefined);
});

afterAll(async () => {
  await closeTestApp();
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  setEnvForTesting(undefined);
  await disconnectPrisma();
});

async function preflight(origin: string) {
  const app = await getTestApp();
  const response = await app.inject({
    method: 'OPTIONS',
    url: '/api/v1/auth/logout',
    headers: {
      origin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type,x-neem-csrf',
    },
  });
  return response.headers;
}

describe('CORS credentials', () => {
  it('are allowed for the app', async () => {
    const headers = await preflight(APP);

    expect(headers['access-control-allow-origin']).toBe(APP);
    expect(headers['access-control-allow-credentials']).toBe('true');
  });

  it('are not allowed for the marketing site, which is still allowed to reach the API', async () => {
    const headers = await preflight(MARKETING);

    expect(headers['access-control-allow-origin']).toBe(MARKETING);
    expect(headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('are not allowed for an origin on neither list', async () => {
    const headers = await preflight('https://elsewhere.example');

    expect(headers['access-control-allow-origin']).toBeUndefined();
    expect(headers['access-control-allow-credentials']).toBeUndefined();
  });
});
