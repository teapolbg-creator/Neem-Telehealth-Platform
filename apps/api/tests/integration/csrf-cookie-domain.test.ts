import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setEnvForTesting } from '../../src/config/env.ts';
import { disconnectPrisma } from '../../src/db/prisma.ts';
import { closeTestApp, request, type ApiResponse } from '../helpers/app.ts';
import { createTestUser, resetDatabase } from '../helpers/database.ts';

/**
 * The CSRF cookie on a deployment where the app and the API are sibling hosts
 * (D47).
 *
 * The browser client reads `neem_csrf` with `document.cookie` and echoes it in
 * a header. In production the API is on `api.` and the app on `app.`, and a
 * cookie set without a domain was invisible to the app — so every signed-in
 * change, sign-out included, was refused with CSRF_INVALID while the session
 * stayed live. The auth tests could not notice: the test client copies cookies
 * out of the response, which no browser on another host can do.
 */

const USER = { email: 'doctor@sibling-hosts.test', password: 'SiblingHosts123!' };

const SIBLING_HOSTS = {
  WEB_ORIGIN: 'https://app.neem.example',
  API_PUBLIC_URL: 'https://api.neem.example',
  CSRF_COOKIE_DOMAIN: 'neem.example',
};

interface SetCookie {
  name: string;
  value: string;
  domain?: string;
  httpOnly?: boolean;
}

function setCookies(response: ApiResponse, name: string): SetCookie[] {
  return (response.raw.cookies as SetCookie[]).filter((cookie) => cookie.name === name);
}

let previous: Record<string, string | undefined> = {};

beforeEach(async () => {
  await resetDatabase();
  previous = Object.fromEntries(Object.keys(SIBLING_HOSTS).map((key) => [key, process.env[key]]));
  Object.assign(process.env, SIBLING_HOSTS);
  setEnvForTesting(undefined); // drop the cached configuration
});

afterEach(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  setEnvForTesting(undefined);
});

afterAll(async () => {
  await closeTestApp();
  await disconnectPrisma();
});

async function signInResponse(): Promise<ApiResponse> {
  await createTestUser({ ...USER, role: 'DOCTOR' });
  const response = await request('/auth/login', { method: 'POST', payload: USER });
  expect(response.status).toBe(200);
  return response;
}

describe('with the app and the API on sibling hosts', () => {
  it('shares the CSRF cookie across the parent domain, so the app can read it', async () => {
    const [csrf] = setCookies(await signInResponse(), 'neem_csrf');

    expect(csrf?.domain).toBe('neem.example');
    expect(csrf?.httpOnly).toBeFalsy();
  });

  it('keeps the session cookie httpOnly and on the API host alone', async () => {
    const [session] = setCookies(await signInResponse(), 'neem_session');

    expect(session?.domain).toBeUndefined();
    expect(session?.httpOnly).toBe(true);
  });

  it('signs out, clearing the shared CSRF cookie and any host-only one set before it', async () => {
    const login = await signInResponse();

    const logout = await request('/auth/logout', { method: 'POST', cookies: login.cookies });
    expect(logout.status).toBe(200);

    const cleared = setCookies(logout, 'neem_csrf');
    // `sort` places undefined last.
    expect(cleared.map((cookie) => cookie.domain).sort()).toEqual(['neem.example', undefined]);
    expect(cleared.every((cookie) => cookie.value === '')).toBe(true);

    expect((await request('/auth/me', { cookies: login.cookies })).body.data).toBeNull();
  });
});
