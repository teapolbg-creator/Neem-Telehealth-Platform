import { test as base, expect, type APIRequestContext, type Page } from '@playwright/test';
import { authenticator } from 'otplib';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
 * NOT under `test-results/`: Playwright empties that directory at the start of
 * every run, so the secret would be discarded while the database stayed
 * enrolled — every run after the first would then fail with "already enrolled
 * and this run does not hold its secret". It has to outlive the output
 * directory to survive across runs.
 *
 * This holds a test secret for a demo account on a development machine, and is
 * git-ignored.
 */
const ADMIN_SECRET_FILE = path.join(process.cwd(), '.playwright-admin-totp');

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

  /**
   * A cached secret that no longer matches the account.
   *
   * This happens the moment anyone signs into the demo admin by hand — the
   * browser enrols a fresh secret, and the file here still holds the old one.
   * Every test needing an admin then fails on `expect(false).toBeTruthy()`,
   * eighteen times, saying nothing about why.
   *
   * The stale file is discarded so the next run can enrol cleanly after a
   * reset, and the error names the actual cause.
   */
  if (!verify.ok() && !enrollmentRequired) {
    if (existsSync(ADMIN_SECRET_FILE)) rmSync(ADMIN_SECRET_FILE);

    throw new Error(
      'The demo admin rejected the recorded two-factor code.\n' +
        'Its enrolled secret has changed — most often because someone signed in as the demo\n' +
        'admin through the browser, which enrols a new one. The stale copy has been discarded.\n' +
        'Run `npm run db:reset-2fa` and try again.',
    );
  }

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
 * Signs the page out through the header control.
 *
 * Needed by any test that changes role mid-run. `/auth/login` redirects an
 * already-authenticated visitor to their portal, so a second `signInThroughUi`
 * against a live session finds no form and fails on a missing "Email" field —
 * which reads as a broken sign-in page rather than a session that was never
 * ended.
 */
export async function signOutThroughUi(page: Page): Promise<void> {
  const control = page.getByRole('button', { name: 'Sign out' });
  if ((await control.count()) === 0) return;

  await Promise.all([
    page.waitForResponse(
      (candidate) =>
        candidate.url().includes('/auth/logout') && candidate.request().method() === 'POST',
    ),
    control.first().click(),
  ]);

  await page.waitForURL((url) => url.pathname.startsWith('/auth/login'), { timeout: 20_000 });

  // The URL settling is not the end of it. The sign-in page redirects anyone
  // it still believes is authenticated, so it can bounce away again once the
  // session query resolves. Waiting for the header control to disappear means
  // the app itself agrees the session is over.
  await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
  await page.getByLabel('Email').waitFor({ state: 'visible' });
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

  // An authenticated visitor is redirected away from this page, so a role
  // switch has to end the previous session before it can begin the next.
  if (!page.url().includes('/auth/login')) {
    await signOutThroughUi(page);
    // Deliberately NOT re-navigating: signing out lands here already, and a
    // second goto races the redirect still in flight — the form is torn down
    // and rebuilt under whatever is being typed into it.
    await page.getByLabel('Email').waitFor({ state: 'visible' });
  }

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

  // Wait for the second-factor step to render before deciding which one it is.
  // `isVisible()` does not wait, so on a cold browser context it returned false
  // simply because React had not painted yet — and the run then failed claiming
  // the admin was already enrolled when it was in fact mid-enrolment.
  await page
    .getByLabel(/code/i)
    .waitFor({ state: 'visible', timeout: 20_000 })
    .catch(() => undefined);

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
  //
  // `waitFor`, not `isVisible`: the latter returns immediately and ignores a
  // timeout, so this step was silently skipped whenever the screen had not
  // painted yet, leaving the run stuck on an unchecked acknowledgement box.
  const recovery = page.getByRole('heading', { name: /recovery codes/i });
  const recoveryVisible = await recovery
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false);

  if (recoveryVisible) {
    // The codes are shown once and cannot be retrieved later, so the button
    // stays disabled until the acknowledgement is ticked.
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

/**
 * Opens a second signed-out browser context.
 *
 * Some scenarios need two roles live at once — a doctor and an admin, say.
 * `page.context().newPage()` shares one cookie jar, so the second sign-in
 * would evict the first; `browser.newPage()` avoids that but inherits none of
 * the project's `use` options, leaving the page with no `baseURL` and no
 * camera permission, so relative navigation silently fails. This supplies
 * both explicitly.
 *
 * Close the returned page when done; its context closes with it.
 */
export async function openSecondPage(
  page: Page,
  options: { viewport?: { width: number; height: number } } = {},
): Promise<Page> {
  const context = await page
    .context()
    .browser()!
    .newContext({
      baseURL: process.env.E2E_WEB_URL ?? 'http://localhost:8080',
      permissions: ['camera', 'microphone'],
      // The patient portal is phone-first (spec §69) and its layout differs
      // enough that driving it at desktop width tests a screen no patient sees.
      ...(options.viewport ? { viewport: options.viewport } : {}),
    });

  return context.newPage();
}

/** A 1×1 PNG, real enough to pass the upload's magic-byte check. */
export function minimalPng(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
}

export interface ActiveDoctor {
  email: string;
  password: string;
  publicId: string;
  /** Both are searchable in the admin directory, which is paged. */
  fullName: string;
  mdcNumber: string;
}

/**
 * Doctors this suite has brought online and not yet taken off.
 *
 * The queue picks the best *eligible* doctor, and a doctor from an earlier
 * test is still eligible: online, on shift, and — now that consultations
 * actually end — no longer holding anything. So the engine hands them the next
 * test's consultation, and that test's own doctor is offered nothing. The
 * failures read "the engine offered it to nobody" and "you do not have an open
 * offer", which sound like routing bugs and are not.
 *
 * This was latent for the whole build and was masked by a leak: before Phase
 * 10, each test left its doctor pinned to a consultation that never completed,
 * so the next test's doctor was the only free one. Cleaning that up removed
 * the accidental isolation and exposed the real problem.
 */
const doctorsOnline: Array<{ email: string; password: string }> = [];

/**
 * Brings one doctor online and takes every other fixture doctor off.
 *
 * A test that asserts "this doctor receives the offer" has to be the only
 * candidate, or it is asserting something about the whole database's presence
 * rather than about routing.
 */
export async function goOnlineExclusively(
  playwright: typeof import('@playwright/test').default,
  doctorApi: APIRequestContext,
  doctor: { email: string; password: string },
  csrf: string,
): Promise<void> {
  for (const other of doctorsOnline) {
    if (other.email === doctor.email) continue;

    const context = await playwright.request.newContext();
    try {
      const otherCsrf = await signIn(context, other);
      await context.post(`${API}/doctor/presence/offline`, {
        headers: csrfHeaders(otherCsrf),
        data: {},
      });
    } catch {
      // A doctor this run can no longer sign in as is a doctor who cannot be
      // offered anything either. Nothing to do.
    } finally {
      await context.dispose();
    }
  }

  doctorsOnline.length = 0;

  await doctorApi.post(`${API}/doctor/presence/online`, {
    headers: csrfHeaders(csrf),
    data: {},
  });
  doctorsOnline.push({ email: doctor.email, password: doctor.password });
}

/**
 * The seeded shift that covers this hour.
 *
 * A doctor is only offered consultations during a shift they are on, so a
 * suite that ran at 21:00 and assigned MORNING would watch the queue offer
 * nothing and call it a routing bug.
 *
 * NOTE: `clinical.spec.ts` and `media.spec.ts` each carry their own copy of
 * this function. They are identical; this is the one new code should use, and
 * the other two are worth folding into it next time either is touched.
 */
export function shiftCoveringNow(): string {
  const hour = new Date().getUTCHours();
  if (hour >= 8 && hour < 14) return 'MORNING';
  if (hour >= 14 && hour < 20) return 'AFTERNOON';
  return 'NIGHT';
}

/**
 * Puts a doctor on today's shift and brings them online.
 *
 * Setup rather than subject: every scenario that needs a doctor to receive an
 * offer needs all of this first, and none of them are about rota mechanics.
 * Returns the doctor's own CSRF token so the caller can keep acting as them.
 */
export async function putDoctorOnShiftNow(
  doctorApi: APIRequestContext,
  adminApi: APIRequestContext,
  doctor: ActiveDoctor,
): Promise<{ ok: true; csrf: string } | { ok: false; reason: string }> {
  const shiftCode = shiftCoveringNow();
  const serviceDate = new Date().toISOString().slice(0, 10);
  const adminCsrf = (await signInAdmin(adminApi)).csrf;

  // Idempotent, and only matters for NIGHT, which is seeded inactive.
  await adminApi.patch(`${API}/admin/shifts/definitions/${shiftCode}`, {
    headers: csrfHeaders(adminCsrf),
    data: { isActive: true },
  });

  const assigned = await adminApi.post(`${API}/admin/shifts`, {
    headers: csrfHeaders(adminCsrf),
    data: { doctorPublicId: doctor.publicId, shiftCode, serviceDate },
  });
  if (!assigned.ok()) return { ok: false, reason: `shift: ${await assigned.text()}` };

  const csrf = await signIn(doctorApi, doctor);
  const shifts = await doctorApi.get(`${API}/doctor/shifts`);
  const todays = (
    (await shifts.json()).data.shifts as Array<{ id: string; serviceDate: string }>
  ).find((shift) => shift.serviceDate === serviceDate);
  if (!todays) return { ok: false, reason: `no shift on ${serviceDate}` };

  await doctorApi.post(`${API}/doctor/shifts/${todays.id}/confirm`, {
    headers: csrfHeaders(csrf),
    data: {},
  });

  return { ok: true, csrf };
}

/**
 * Registers a doctor and walks them all the way to ACTIVE.
 *
 * Each run gets its own doctor rather than sharing the seeded demo account,
 * because a doctor's capacity is one consultation at a time and is released
 * only when the consultation reaches a terminal state. Until a doctor can
 * complete a consultation (Phase 6), a spec that borrowed the demo doctor
 * would leave them at capacity and quietly starve every later run.
 *
 * The whole approval path is walked for real — documents uploaded, each one
 * verified, then PENDING → UNDER_REVIEW → APPROVED → ACTIVE. There is no
 * shortcut, by design (spec §83).
 */
export async function createActiveDoctor(
  request: APIRequestContext,
  options: { run: string; languageCodes?: string[]; phone?: string },
): Promise<ActiveDoctor> {
  const email = `e2e.media.${options.run}@doctor.test`;
  const password = 'DoctorPassword2026!';
  const mdcNumber = `MDC-E2E-M-${options.run}`;

  const application = await request.post(`${API}/onboarding/doctor`, {
    data: {
      email,
      password,
      fullName: `Dr. Media ${options.run}`,
      mdcNumber,
      mdcExpiresAt: '2029-12-31',
      qualifiedAt: '2013-01-15',
      yearsExperience: 12,
      phone: options.phone ?? '0244000199',
      languageCodes: options.languageCodes ?? ['en'],
    },
  });
  expect(application.status(), await application.text()).toBe(201);

  const doctorCsrf = await signIn(request, { email, password });
  const png = minimalPng();

  for (const documentType of ['MDC_LICENCE', 'GOVERNMENT_ID', 'PRACTICE_EVIDENCE']) {
    const upload = await request.post(`${API}/doctor/documents`, {
      headers: csrfHeaders(doctorCsrf),
      multipart: {
        documentType,
        file: { name: 'doc.png', mimeType: 'image/png', buffer: png },
      },
    });
    expect(upload.status(), `${documentType} upload`).toBe(201);
  }

  await request.post(`${API}/doctor/signature`, {
    headers: csrfHeaders(doctorCsrf),
    data: { signatureDataUrl: `data:image/png;base64,${png.toString('base64')}` },
  });

  await request.post(`${API}/auth/logout`, { headers: csrfHeaders(doctorCsrf) });

  const { csrf: adminCsrf } = await signInAdmin(request);

  const list = await request.get(`${API}/admin/doctors?search=${mdcNumber}`);
  const applicant = (await list.json()).data.find(
    (entry: { mdcNumber: string }) => entry.mdcNumber === mdcNumber,
  );
  expect(applicant, 'the new applicant should be in the review queue').toBeTruthy();

  const detail = await (await request.get(`${API}/doctors/${applicant.publicId}`)).json();
  for (const document of detail.data.documents) {
    await request.post(`${API}/admin/doctors/documents/${document.id}/verify`, {
      headers: csrfHeaders(adminCsrf),
      data: { verified: true },
    });
  }

  for (const status of ['UNDER_REVIEW', 'APPROVED', 'ACTIVE']) {
    const response = await request.post(`${API}/admin/doctors/${applicant.publicId}/status`, {
      headers: csrfHeaders(adminCsrf),
      data: { status },
    });
    expect(response.ok(), `transition to ${status}: ${await response.text()}`).toBeTruthy();
  }

  await request.post(`${API}/auth/logout`, { headers: csrfHeaders(adminCsrf) });

  return {
    email,
    password,
    publicId: applicant.publicId,
    fullName: `Dr. Media ${options.run}`,
    mdcNumber,
  };
}
