import { ERROR_CODES, type ErrorCode } from "@neem/contracts";

/**
 * API client.
 *
 * One place that knows how to talk to the Neem API: it always sends the
 * session cookie, always attaches the CSRF header on mutating requests, and
 * always unwraps the `{ data, meta }` / `{ error, meta }` envelope
 * (docs/api.md §1).
 *
 * The client is a convenience layer, never an enforcement layer. Every rule it
 * appears to apply is independently enforced server-side (spec §92).
 */

const CSRF_COOKIE = "neem_csrf";
const CSRF_HEADER = "x-neem-csrf";

export const API_BASE_URL =
  (import.meta.env.VITE_API_URL as string | undefined) ?? "http://localhost:4000";

export class ApiError extends Error {
  readonly code: ErrorCode | string;
  readonly status: number;
  readonly details?: Array<{ field?: string; issue: string }>;
  readonly requestId?: string;

  constructor(params: {
    code: string;
    message: string;
    status: number;
    details?: Array<{ field?: string; issue: string }>;
    requestId?: string;
  }) {
    super(params.message);
    this.name = "ApiError";
    this.code = params.code;
    this.status = params.status;
    this.details = params.details;
    this.requestId = params.requestId;
  }

  /** True when signing in again would plausibly resolve it. */
  get isAuthError(): boolean {
    return this.code === ERROR_CODES.UNAUTHENTICATED || this.status === 401;
  }

  /** Maps validation details onto react-hook-form's field errors. */
  get fieldErrors(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const detail of this.details ?? []) {
      if (detail.field) result[detail.field] = detail.issue;
    }
    return result;
  }
}

function readCookie(name: string): string | undefined {
  if (typeof document === "undefined") return undefined;
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = { accept: "application/json" };

  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }

  // Double-submit CSRF token. The cookie is readable by design; the server
  // compares it against the hash stored on the session (docs/security.md §6).
  if (method !== "GET") {
    const csrf = readCookie(CSRF_COOKIE);
    if (csrf) headers[CSRF_HEADER] = csrf;
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/api/v1${path}`, {
      method,
      headers,
      // Sends the httpOnly session cookie cross-origin in development, where
      // the web app and API are on different ports.
      credentials: "include",
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (cause) {
    // A network failure must surface as a definite state, never as a silent
    // hang or an ambiguous success (spec §67).
    throw new ApiError({
      code: "NETWORK_ERROR",
      message: "Could not reach Neem. Check your connection and try again.",
      status: 0,
    });
  }

  if (response.status === 204) {
    return undefined as T;
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError({
      code: ERROR_CODES.INTERNAL_ERROR,
      message: "Neem returned an unexpected response.",
      status: response.status,
    });
  }

  const envelope = payload as {
    data?: T;
    error?: { code: string; message: string; details?: Array<{ field?: string; issue: string }> };
    meta?: { requestId?: string };
  };

  if (!response.ok || envelope.error) {
    throw new ApiError({
      code: envelope.error?.code ?? ERROR_CODES.INTERNAL_ERROR,
      message: envelope.error?.message ?? "That request could not be completed.",
      status: response.status,
      details: envelope.error?.details,
      requestId: envelope.meta?.requestId,
    });
  }

  return envelope.data as T;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => apiRequest<T>(path, { method: "GET", signal }),
  post: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: "POST", body }),
  patch: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: "PATCH", body }),
  put: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: "PUT", body }),
  delete: <T>(path: string) => apiRequest<T>(path, { method: "DELETE" }),
};
