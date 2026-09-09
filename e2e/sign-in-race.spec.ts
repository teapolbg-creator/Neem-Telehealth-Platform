import { test, expect, API, DEMO, signIn, signInThroughUi } from './support/fixtures.ts';

/**
 * The sign-in race that only showed up on CI.
 *
 * `signInThroughUi` has to know whether the browser already holds a session,
 * because an authenticated visitor is redirected away from /auth/login and has
 * to be signed out before a different role can sign in.
 *
 * It used to answer that by navigating and reading `page.url()`. Measurement
 * showed the app had not yet even *issued* its session query at that moment:
 * the URL still said /auth/login and the form was on screen, and seconds later
 * the redirect fired and took the form away. Waiting for the field first does
 * not help — the field is present the whole time it is doomed.
 *
 * On a laptop everything finished before the redirect landed. On a GitHub
 * runner it landed mid-flow: CI's stack trace shows `fillField` finding the
 * field on one line and timing out filling it on the next, which is the
 * redirect arriving in between.
 *
 * **What this test does and does not prove.** It covers the *condition* —
 * arriving at the sign-in form with a session already in the cookie jar, which
 * is what the media suite does and what the old fixture mishandled. It does
 * not reproduce CI's *timing*: locally the redirect lands either early enough
 * to be caught or late enough not to interfere, and hitting the window in
 * between takes a machine slow in the right way. Attempts to force it with a
 * delayed session query pass against the old fixture too, so this is not a
 * regression test for the race itself, and pretending otherwise would be
 * worse than saying so.
 *
 * The fix it accompanies removes the window by construction rather than by
 * winning it: with a session present, the form is not touched until the
 * redirect has been waited for and the session ended.
 */
test('signs in through the UI when the browser already holds another session', async ({ page }) => {
  // Exactly what the media suite does when it drives the API through
  // `page.request`: the browser ends up holding a session before any UI runs.
  await signIn(page.request, DEMO.doctor);

  const before = await page.context().cookies();
  expect(
    before.some((cookie) => cookie.name === 'neem_session'),
    'the precondition this test exists for: a session is already present',
  ).toBe(true);

  // Slow the session query enough that the redirect certainly resolves after
  // hydration — the ordering CI produces by being slow, made deliberate.
  await page.route(`${API}/auth/me`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });

  await signInThroughUi(page, DEMO.pharmacy);

  // Signed in as the pharmacy, on the pharmacy's side — reachable only if the
  // previous session was ended and the form was actually found and submitted.
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  expect(page.url()).toContain('/pharmacy');
});
