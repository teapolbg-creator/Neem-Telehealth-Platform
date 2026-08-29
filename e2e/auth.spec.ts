import { authenticator } from 'otplib';
import {
  test,
  expect,
  API,
  DEMO,
  gotoHydrated,
  rememberAdminSecret,
  signInThroughUi,
} from './support/fixtures.ts';

/**
 * Authentication through the real UI (spec §9, §59).
 *
 * The security properties are covered exhaustively by the Vitest integration
 * suite; what these add is proof that the *browser journey* honours them —
 * that a user cannot reach a portal the API would refuse.
 */

test.describe('sign-in', () => {
  test('signs a pharmacy in and lands on its own dashboard', async ({ page }) => {
    await signInThroughUi(page, DEMO.pharmacy);

    await expect(page).toHaveURL(/\/pharmacy/);
    await expect(page.getByText('Akosua Pharmacy').first()).toBeVisible();
  });

  test('shows a safe error for a wrong password and issues no session', async ({ page, context }) => {
    await signInThroughUi(page, { email: DEMO.pharmacy.email, password: 'WrongPassword123!' });

    await expect(page.getByRole('alert')).toContainText(/not correct/i);
    await expect(page).toHaveURL(/\/auth\/login/);

    const cookies = await context.cookies();
    expect(cookies.find((cookie) => cookie.name === 'neem_session')).toBeUndefined();
  });

  test('gives the same message for an unknown account, disclosing nothing', async ({ page }) => {
    await signInThroughUi(page, { email: 'nobody@neem.demo', password: 'WrongPassword123!' });

    // Identical wording to the wrong-password case — the UI must not reveal
    // which emails are registered.
    await expect(page.getByRole('alert')).toContainText(/not correct/i);
  });

  test('keeps the session cookie httpOnly, so scripts cannot read it', async ({ page, context }) => {
    await signInThroughUi(page, DEMO.pharmacy);
    await expect(page).toHaveURL(/\/pharmacy/);

    const session = (await context.cookies()).find((cookie) => cookie.name === 'neem_session');
    expect(session?.httpOnly, 'the session cookie must be httpOnly').toBe(true);

    // The CSRF cookie is deliberately readable — that is the double-submit pattern.
    const csrf = (await context.cookies()).find((cookie) => cookie.name === 'neem_csrf');
    expect(csrf?.httpOnly).toBe(false);

    const visibleToScript = await page.evaluate(() => document.cookie.includes('neem_session'));
    expect(visibleToScript).toBe(false);
  });

  test('signs out and refuses the portal afterwards', async ({ page }) => {
    await signInThroughUi(page, DEMO.pharmacy);
    await expect(page).toHaveURL(/\/pharmacy/);

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/auth\/login/);

    await gotoHydrated(page, '/pharmacy');
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
  });

  test('tells the patient they do not sign in', async ({ page }) => {
    // Patients have no account — the sign-in page must not imply otherwise.
    await gotoHydrated(page, '/auth/login');
    await expect(page.getByText(/Patients do not sign in/i)).toBeVisible();
  });
});

test.describe('admin two-factor authentication', () => {
  test('will not admit an administrator on a password alone', async ({ page, context }) => {
    await signInThroughUi(page, DEMO.admin);

    // A 2FA step must appear, and no session may exist yet.
    await expect(
      page.getByRole('heading', { name: /two-factor/i }),
    ).toBeVisible();

    const cookies = await context.cookies();
    expect(
      cookies.find((cookie) => cookie.name === 'neem_session'),
      'no session may be issued before the second factor',
    ).toBeUndefined();
  });

  test('completes enrolment, shows recovery codes, then reaches the admin portal', async ({
    page,
  }) => {
    await signInThroughUi(page, DEMO.admin);

    const heading = page.getByRole('heading', { name: /two-factor/i });
    await expect(heading).toBeVisible();

    const isEnrolment = await page
      .getByRole('heading', { name: /set up two-factor/i })
      .isVisible()
      .catch(() => false);

    test.skip(
      !isEnrolment,
      'The demo admin already has 2FA enrolled; its secret is unrecoverable by design. Re-seed to run this.',
    );

    // Read the setup key the page offers for manual entry and use it to
    // generate a genuine TOTP code — the same thing an authenticator app does.
    const secret = (await page.locator('code').first().innerText()).trim();
    expect(secret.length).toBeGreaterThan(15);

    // Share it with the rest of the run: once enrolled, the secret is
    // unrecoverable, so later specs need the one this test just created.
    rememberAdminSecret(secret);

    await page.getByLabel(/6-digit code/i).fill(authenticator.generate(secret));
    await page.getByRole('button', { name: /confirm and sign in/i }).click();

    await expect(page.getByRole('heading', { name: /recovery codes/i })).toBeVisible();
    // Ten single-use codes, shown exactly once.
    await expect(page.locator('li').filter({ hasText: /^[0-9A-F]{5}-[0-9A-F]{5}$/ })).toHaveCount(10);

    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: /continue to neem/i }).click();

    await expect(page).toHaveURL(/\/admin/);
    await expect(page.getByRole('heading', { name: /executive overview/i })).toBeVisible();

    // And the API agrees. `page.request` shares the browser's cookies; the
    // standalone `request` fixture is a separate context and would see no
    // session at all.
    const me = await page.request.get(`${API}/auth/me`);
    expect((await me.json()).data.role).toBe('ADMIN');
  });
});

test.describe('portal isolation', () => {
  test('warns a pharmacy that wanders into the admin portal', async ({ page }) => {
    await signInThroughUi(page, DEMO.pharmacy);
    await expect(page).toHaveURL(/\/pharmacy/);

    await gotoHydrated(page, '/admin');

    // The shell says the role is wrong, and the API refuses the data behind it.
    await expect(page.getByText(/portal belongs to a different role/i)).toBeVisible();
  });

  test('refuses admin data to a pharmacy session at the API', async ({ page }) => {
    await signInThroughUi(page, DEMO.pharmacy);
    await expect(page).toHaveURL(/\/pharmacy/);

    // `page.request` shares the browser's cookies. The standalone `request`
    // fixture is a separate context and would simply be unauthenticated, which
    // would prove nothing about role separation.
    const response = await page.request.get(`${API}/admin/doctors`);
    expect(response.status(), 'the API is the enforcement point, not the UI').toBe(403);
  });
});
