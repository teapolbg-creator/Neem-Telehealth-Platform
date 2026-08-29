import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.ts';

/**
 * Drives the real Fastify application with `inject()` — real routing, real
 * middleware, real database — without binding a socket. No port collisions,
 * and nothing is stubbed that a production request would exercise.
 */

let app: FastifyInstance | undefined;

export async function getTestApp(): Promise<FastifyInstance> {
  if (!app) {
    app = await buildApp();
    await app.ready();
  }
  return app;
}

export async function closeTestApp(): Promise<void> {
  await app?.close();
  app = undefined;
}

export interface ApiResponse<T = unknown> {
  status: number;
  body: {
    data?: T;
    error?: {
      code: string;
      message: string;
      // Present on validation failures; tests assert against specific fields.
      details?: Array<{ field?: string; issue: string }>;
    };
    meta?: { requestId: string };
  };
  cookies: Record<string, string>;
  raw: Awaited<ReturnType<FastifyInstance['inject']>>;
}

/** Parses Set-Cookie headers into a name → value map. */
function parseCookies(response: Awaited<ReturnType<FastifyInstance['inject']>>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const cookie of response.cookies as Array<{ name: string; value: string }>) {
    result[cookie.name] = cookie.value;
  }
  return result;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  payload?: unknown;
  /** Session and CSRF cookies from a previous response. */
  cookies?: Record<string, string>;
  /** Set false to deliberately omit the CSRF header and prove it is enforced. */
  withCsrf?: boolean;
  headers?: Record<string, string>;
}

export async function request<T = unknown>(
  path: string,
  options: RequestOptions = {},
): Promise<ApiResponse<T>> {
  const instance = await getTestApp();
  const method = options.method ?? 'GET';

  const headers: Record<string, string> = { ...options.headers };

  // Mirror what the browser client does: echo the CSRF cookie in a header on
  // mutating requests (docs/security.md §6).
  if (method !== 'GET' && options.withCsrf !== false && options.cookies?.neem_csrf) {
    headers['x-neem-csrf'] = options.cookies.neem_csrf;
  }

  const response = await instance.inject({
    method,
    url: `/api/v1${path}`,
    payload: options.payload as never,
    cookies: options.cookies,
    headers,
  });

  let body: ApiResponse<T>['body'] = {};
  try {
    body = response.json();
  } catch {
    // Some responses legitimately have no JSON body.
  }

  return { status: response.statusCode, body, cookies: parseCookies(response), raw: response };
}

/**
 * Signs in and returns the resulting cookies, for tests that need an
 * authenticated principal. Only works for accounts without 2FA — admin
 * sign-in is exercised explicitly in the two-factor tests.
 */
export async function signIn(
  email: string,
  password: string,
): Promise<Record<string, string>> {
  const response = await request('/auth/login', {
    method: 'POST',
    payload: { email, password },
  });

  if (response.status !== 200 || !response.cookies.neem_session) {
    throw new Error(
      `signIn failed for ${email}: ${response.status} ${JSON.stringify(response.body)}`,
    );
  }

  return response.cookies;
}

/** A 1×1 PNG, real enough to pass the upload's magic-byte check. */
export function minimalPng(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
}

export interface UploadOptions {
  cookies?: Record<string, string>;
  fields?: Record<string, string>;
  file: { name: string; mimeType: string; body: Buffer };
}

/**
 * Posts a `multipart/form-data` upload.
 *
 * Built by hand rather than with a form library: the upload path validates
 * magic bytes and the declared content type, so the test has to produce a
 * genuinely well-formed multipart body for that check to mean anything.
 */
export async function upload<T = unknown>(
  path: string,
  options: UploadOptions,
): Promise<ApiResponse<T>> {
  const instance = await getTestApp();
  const boundary = `----neemtest${Math.random().toString(16).slice(2)}`;
  const parts: Buffer[] = [];

  for (const [name, value] of Object.entries(options.fields ?? {})) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }

  parts.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${options.file.name}"\r\n` +
        `Content-Type: ${options.file.mimeType}\r\n\r\n`,
    ),
    options.file.body,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );

  const headers: Record<string, string> = {
    'content-type': `multipart/form-data; boundary=${boundary}`,
  };
  if (options.cookies?.neem_csrf) headers['x-neem-csrf'] = options.cookies.neem_csrf;

  const response = await instance.inject({
    method: 'POST',
    url: `/api/v1${path}`,
    payload: Buffer.concat(parts),
    cookies: options.cookies,
    headers,
  });

  let body: ApiResponse<T>['body'] = {};
  try {
    body = response.json();
  } catch {
    // Some responses legitimately have no JSON body.
  }

  return { status: response.statusCode, body, cookies: parseCookies(response), raw: response };
}
