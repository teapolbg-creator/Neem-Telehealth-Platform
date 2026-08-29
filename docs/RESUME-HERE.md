# Resume point — paused 2026-08-29, mid Phase 1

Working tree is clean and committed (`43d696c`). Nothing is lost by rebooting.

---

## Before rebooting — WSL is not actually installed yet

Docker Desktop is installed and its processes are running, but its Linux engine cannot start because **the Windows Subsystem for Linux is not installed**. `wsl --status` reports:

> The Windows Subsystem for Linux is not installed.

A reboot on its own will not fix this. Run this first, in an **Administrator** PowerShell:

```bash
wsl --install
```

That enables the required Windows features and installs WSL2. It will ask to restart. After the restart, Docker Desktop should start its engine on its own.

### Verify after rebooting

```bash
docker version --format "{{.Server.Version}}"
```

A version number means the engine is up. If it still errors, open Docker Desktop, wait for "Engine running", and check Settings → General → "Use the WSL 2 based engine".

---

## Then resume with

```bash
npm run docker:up
```

```bash
npm run db:migrate
```

```bash
npm run db:seed
```

```bash
npm run dev
```

Or `npm run setup` to do install + containers + migrate + seed in one step.

---

## What is done

- **Phase 0** — complete and approved. Findings, architecture, ERD, roadmap, decision log, compliance register: `docs/`.
- **Restructure** — monorepo: `apps/web` (the Lovable app, moved intact), `apps/api`, `packages/contracts`. Git initialised with the original snapshot as the baseline commit, so every change is reviewable as a diff.
- **Database** — full Prisma schema, 45 models, validated by `prisma generate`. Not yet migrated (needs MySQL).
- **Auth** — argon2id passwords, opaque revocable sessions, mandatory admin TOTP 2FA with recovery codes, CSRF, rate limiting, account lockout, password reset.
- **Platform** — zod-validated config that refuses unsafe production boots, pino logging with a redaction list, append-only audit log with a metadata sanitiser, Fastify app, health/readiness endpoint.
- **Web** — role-derived navigation, sign-in page with the 2FA enrolment flow, false MDC approval claim removed.
- **Seeds** — reference data and demo accounts written, not yet executed.
- **Verification** — 67 unit tests pass; both workspaces typecheck; the web app builds.

## What remains in Phase 1

1. Run the first migration against MySQL (`db:migrate`) — **blocked on WSL/Docker**.
2. Run the seed and confirm the demo admin can sign in with 2FA.
3. Integration tests for auth against a real database (`apps/api/tests/integration/`) — written after the database exists, since they test constraints and transactions rather than mocks.
4. Playwright harness plus a first smoke test.
5. Demonstrate the Phase 1 exit criteria: app runs, database migrates, seeded admin signs in with 2FA, unauthorised access is refused, tests pass.

---

## Two environment notes worth keeping

**npm downloads were being truncated.** The first install produced a corrupt 3.3 MB `esbuild.exe` (should be ~11.7 MB) and then failed with `ECONNRESET`. Fixed by clearing the npm cache and setting `maxsockets=3` with longer retry timeouts. **360 Total Security** is installed alongside Defender and is the most likely cause. If large installs fail again, that is the first thing to suspect — the settings are already persisted in your npm config.

**Package manager changed from bun to npm.** The project shipped with `bun.lock` and a `bunfig.toml` supply-chain guard (`minimumReleaseAge = 86400`, which skipped packages published in the last 24 hours). bun is not installed on this machine and you installed Node, so the project now uses npm workspaces and `package-lock.json`. The release-age guard has no npm equivalent and is therefore gone — worth restoring if you later install bun. Logged as an open item in `docs/decision-log.md`.
