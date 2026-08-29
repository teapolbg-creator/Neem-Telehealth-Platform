import { test as base, expect, type APIRequestContext, type Page } from '@playwright/test';
import { authenticator } from 'otplib';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Shared E2E fixtures.
 *
 * Two things every spec needs: unique identifiers so runs do not collide, and
 * a way to sign in as the seeded admin, which requires a real TOTP code
 * because admin 2FA is mandatory and cannot be bypassed (spec §9).
 */

export const API_URL = process.env.E2E_API_URL ?? 'http://localhost:4000';
export const API = `${API_URL}/api/v1`;

/** Credentials created by `npm run db:seed`. */
export const DEMO = {
  admin: { email: 'admin@neem.demo', password: 'NeemDemoAdmin!2026' },
  pharmacy: { email: 'akosua@pharmacy.demo', password: 'NeemDemo!2026' },
  secondPharmacy: { email: 'healthfirst@pharmacy.demo', password: 'NeemDemo!2026' },
  doctor: { email: 'ama@doctor.demo', password: 'NeemDemo!2026' },
} as const;

/** A short random suffix, so a run never collides with a previous one. */
export function runId(): string {
  return randomBytes(4).toString('hex');
}

export interface AdminSession {
  /** Authenticated API context, carrying the session and CSRF cookies. */
  api: APIRequestContext;
  csrf: string;
}

/**
 * Where the admin's TOTP secret is kept for the duration of a run.
 *
 * Once an admin enrols, the secret is encrypted at rest and cannot be read
 * back — that is the point of it. So the first test to sign in enrols and
 * records the secret here; every later test reuses it to generate codes, just
 * as a real authenticator app would. A file rather than a module variable,
 * because Playwright may spread spec files across worker processes.
 *
 * This holds a test secret for a demo account on a development machine, and is
 * git-ignored along with the rest of `test-results/`.
 */
const ADMIN_SECRET_FILE = path.join(process.cwd(), 'test-results', '.admin-totp');

export function rememberAdminSecret(secret: string): void {
  mkdirSync(path.dirname(ADMIN_SECRET_FILE), { recursive: true });
  writeFileSync(ADMIN_SECRET_FILE, secret, 'utf8');
}

export function recallAdminSecret(): string | undefined {
  return existsSync(ADMIN_SECRET_FILE) ? readFileSync(ADMIN_SECRET_FILE, 'utf8').trim() : undefined;
}

/**
 * Signs in as the seeded admin, completing the mandatory second factor.
 *
 * Enrols on first use; reuses the recorded secret afterwards. If the account is
 * already enrolled with a secret this run does not hold, the caller is told
 * exactly how to fix it rather than being silently skipped.
 */
export async function signInAdmin(
  request: APIRequestContext,
): Promise<{ csrf: string; secret: string }> {
  const login = await request.post(`${API}/auth/login`, { data: DEMO.admin });
  expect(login.ok(), 'admin password sign-in should succeed').toBeTruthy();

  const body = await login.json();

  if (body.data.status === 'AUTHENTICATED') {
    throw new Error(
      'The demo admin signed in without a second factor, which must be impossible (spec §9).',
    );
  }

  const { challengeId, enrollmentRequired } = body.data;
  let secret = recallAdminSecret();

  if (enrollmentRequired) {
    const enroll = await request.post(`${API}/auth/2fa/enroll`, { data: { challengeId } });
    expect(enroll.ok()).toBeTruthy();
    secret = (await enroll.json()).data.secret as string;
    rememberAdminSecret(secret);
  } else if (!secret) {
    throw new Error(
      'The demo admin is already enrolled in two-factor authentication and its secret is not\n' +
        'recoverable — by design. Run `npm run db:reset-2fa` before the end-to-end suite.',
    );
  }

  const verify = await request.post(`${API}/auth/2fa/verify`, {
    data: { challengeId, code: authenticator.generate(secret!) },
  });
  expect(verify.ok(), 'admin two-factor verification should succeed').toBeTruthy();

  return { csrf: await readCsrf(request), secret: secret! };
}

/** Signs in an account that does not use 2FA (pharmacy, doctor). */
export async function signIn(
  request: APIRequestContext,
  credentials: { email: string; password: string },
): Promise<string> {
  const response = await request.post(`${API}/auth/login`, { data: credentials });
  expect(response.ok(), `sign-in should succeed for ${credentials.email}`).toBeTruthy();

  const body = await response.json();
  expect(body.data.status, 'this account should not require 2FA').toBe('AUTHENTICATED');

  return readCsrf(request);
}

/** The CSRF cookie is readable by design — the client echoes it in a header. */
async function readCsrf(request: APIRequestContext): Promise<string> {
  const state = await request.storageState();
  const cookie = state.cookies.find((entry) => entry.name === 'neem_csrf');

  if (!cookie) throw new Error('No CSRF cookie was issued by sign-in');
  return cookie.value;
}

/** Mutating API calls need the CSRF header, exactly as the browser client does. */
export function csrfHeaders(csrf: string): Record<string, string> {
  return { 'x-neem-csrf': csrf };
}

/**
 * Navigates and waits for React to hydrate before returning.
 *
 * This matters: the app is server-rendered, so inputs exist in the DOM before
 * React attaches to them. Typing into that pre-hydration markup looks like it
 * works — the DOM value is set — but hydration then resets each controlled
 * input to its empty state, and the form silently appears untouched.
 *
 * `page.goto` resolves on `load`, which is too early. Waiting for the React
 * root container property is a direct signal that hydration has happened,
 * rather than a guess based on timing.
 */
export async function gotoHydrated(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.waitForLoadState('domcontentloaded');

  await page.waitForFunction(
    () => {
      // React 19 stamps `__reactFiber$<id>` onto every element it owns once it
      // has attached. Its presence on <body> means hydration has run, so a
      // controlled input will now keep what is typed into it.
      const marked = (element: Element | null) =>
        Boolean(element) &&
        Object.keys(element as object).some((key) => key.startsWith('__reactFiber$'));

      return marked(document.body) || marked(document.querySelector('body > div'));
    },
    undefined,
    { timeout: 20_000 },
  );
}

/**
 * Fills a field and confirms the value survived.
 *
 * Belt and braces alongside `gotoHydrated`: if a late re-render clears the
 * field, this fails loudly at the fill rather than 60 seconds later at a
 * disabled submit button, where the cause is far harder to see.
 */
export async function fillField(page: Page, label: string | RegExp, value: string): Promise<void> {
  const field = page.getByLabel(label);
  await field.waitFor({ state: 'visible' });
  await field.fill(value);
  await expect(field, `"${label}" should retain what was typed into it`).toHaveValue(value);
}

/**
 * Signs a browser page in by driving the real form, so the UI path is what is
 * under test rather than a cookie injected behind its back.
 */
export async function signInThroughUi(
  page: Page,
  credentials: { email: string; password: string },
): Promise<void> {
  await gotoHydrated(page, '/auth/login');
  await fillField(page, 'Email', credentials.email);
  await fillField(page, 'Password', credentials.password);

  // Wait for the request to actually come back. Returning on the click alone
  // leaves the sign-in in flight, and a caller that navigates immediately
  // afterwards cancels it — arriving at the next page unauthenticated, with a
  // failure that points at the wrong place entirely.
  const [response] = await Promise.all([
    page.waitForResponse(
      (candidate) =>
        candidate.url().includes('/auth/login') && candidate.request().method() === 'POST',
    ),
    page.getByRole('button', { name: 'Sign in' }).click(),
  ]);

  if (!response.ok()) return; // A rejected sign-in; the caller asserts the error.

  const body = await response.json();

  // An account requiring a second factor stays on this page by design.
  if (body.data?.status !== 'AUTHENTICATED') return;

  // Otherwise the app redirects once the session query settles. Waiting for it
  // here means callers can navigate straight away.
  await page.waitForURL((url) => !url.pathname.startsWith('/auth/login'), { timeout: 20_000 });
}

/**
 * Signs the browser in as the seeded administrator, completing the mandatory
 * second factor through the real UI.
 *
 * Distinct from `signInAdmin`, which authenticates Playwright's standalone
 * `request` context — a different cookie jar entirely. Tests that render admin
 * pages need this one.
 */
export async function signInAdminOnPage(page: Page): Promise<void> {
  await signInThroughUi(page, DEMO.admin);

  const enrolling = await page
    .getByRole('heading', { name: /set up two-factor/i })
    .isVisible()
    .catch(() => false);

  let secret: string | undefined;

  if (enrolling) {
    secret = (await page.locator('code').first().innerText()).trim();
    rememberAdminSecret(secret);
  } else {
    secret = recallAdminSecret();
    if (!secret) {
      throw new Error(
        'The demo admin is already enrolled and this run does not hold its secret.\n' +
          'Run `npm run db:reset-2fa` before the end-to-end suite.',
      );
    }
  }

  await page.getByLabel(/code/i).fill(authenticator.generate(secret));
  await page.getByRole('button', { name: /confirm and sign in|verify/i }).click();

  // Enrolment interposes the one-time recovery-code screen.
  const recoveryVisible = await page
    .getByRole('heading', { name: /recovery codes/i })
    .isVisible({ timeout: 10_000 })
    .catch(() => false);

  if (recoveryVisible) {
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: /continue to neem/i }).click();
  }

  await page.waitForURL((url) => url.pathname.startsWith('/admin'), { timeout: 20_000 });
}

export const test = base.extend<{ run: string }>({
  run: async ({}, use) => {
    await use(runId());
  },
});

export { expect };
