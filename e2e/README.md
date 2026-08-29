# End-to-end tests

Playwright, driving the real web app against the real API and a real MySQL
database. Nothing is stubbed — an end-to-end test that mocks the API proves
only that the mock behaves.

## Running

```bash
npm run db:reset-2fa
```

```bash
npm run test:e2e
```

`db:reset-2fa` clears the demo administrator's TOTP enrolment. It is needed
because once an admin enrols, the secret is encrypted at rest and cannot be
read back — by design — so an automated run has no way to produce a valid code
for an already-enrolled account. The script refuses to run in production and
only touches accounts flagged `isDemo`.

The suite reuses an already-running `npm run dev`; otherwise Playwright starts
the stack itself.

| Command | |
| --- | --- |
| `npm run test:e2e` | Run everything |
| `npm run test:e2e:ui` | Interactive runner |
| `npm run test:e2e:report` | Open the last HTML report |

## Isolation

Runs are **non-destructive**. Rather than truncating the database, each run
gives its fixtures a unique suffix (emails, MDC numbers, Pharmacy Council
numbers), so the seeded demo data survives and a test run never wipes a demo
you were about to give.

The trade-off is that the suite does not start from a pristine database. The
Vitest integration suite already covers pristine-state behaviour against
`neem_test`, so the two layers complement each other: Vitest proves the rules,
Playwright proves the journey honours them.

## Two things that will bite you

**Server-side rendering.** Inputs exist in the DOM before React hydrates.
Typing into that pre-hydration markup appears to work — the DOM value is set —
and then hydration resets every controlled input, leaving the form apparently
untouched. Use `gotoHydrated()` rather than `page.goto()`, and `fillField()`
rather than `.fill()`; the latter asserts the value survived, so a regression
fails at the fill with an obvious message instead of 60 seconds later at a
disabled submit button.

**Two cookie jars.** Playwright's `request` fixture is a separate context from
the browser. `signIn(request, …)` authenticates the API context;
`signInThroughUi(page, …)` and `signInAdminOnPage(page)` authenticate the
browser. Use `page.request` when a call must carry the browser's session.

## Rate limiting

The auth and onboarding limiters are deliberately strict — 10 sign-ins per 15
minutes is right for production. A suite that signs in dozens of times in a
minute would be throttled, so the local `.env` raises
`RATE_LIMIT_AUTH_MAX` / `RATE_LIMIT_ONBOARDING_MAX`. `.env.example` keeps the
production-appropriate defaults. This is the limit being *configured per
environment*, not disabled: `tests/integration/rate-limit.test.ts` builds an
app with a low limit and proves the limiter still engages.

## The 16 required scenarios

`required-scenarios.spec.ts` declares every scenario from specification §80
and marks each `fixme` until the phase that makes it possible has landed. A
missing test looks like coverage nobody considered; a pending one is a visible,
countable gap. Running the suite reports exactly how many remain.

**Currently 0 of 16 implemented** — they exercise consultation, queue,
telemedicine, clinical and payment flows built in Phases 3–7. As each lands,
the placeholder is replaced by a real test in its own spec file.
