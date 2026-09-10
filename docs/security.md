# Security Model

**Status:** Proposed (Phase 0). Security is a first-class MVP requirement, not a later hardening pass (spec §59).

---

## 1. Principals

| Principal | Authentication                                                                 | Notes                                  |
| --------- | ------------------------------------------------------------------------------ | -------------------------------------- |
| Patient   | No account. Single-use consultation token exchanged for a device-bound session | Scoped to exactly one consultation     |
| Pharmacy  | Email + password                                                               | One account per pharmacy; no sub-roles |
| Doctor    | Email + password                                                               | Must be `ACTIVE` to work               |
| Admin     | Email + password + **mandatory TOTP 2FA**                                      |                                        |

---

## 2. Authentication

**Passwords:** argon2id (memory-hard), per-user salt, tuned parameters, never logged. Minimum length and a breach-list check on set. Reset via single-use, expiring, hashed tokens; the reset response is identical whether or not the email exists.

**Sessions:** opaque 256-bit random tokens. Only a SHA-256 hash is stored; the raw value lives in an `HttpOnly; Secure; SameSite=Lax` cookie. Server-side sessions were chosen over JWT specifically because **revocation must be instant** — suspending a doctor or pharmacy has to end their live session, which a stateless JWT cannot do without a blocklist that reintroduces the same state. Idle timeout plus a hard absolute expiry; rotation on privilege change.

**Admin 2FA:** TOTP (RFC 6238) with a 30s step and ±1 window, secret encrypted at rest, one-time recovery codes stored hashed. Enrolment is mandatory before an admin session becomes privileged.

**Brute force:** per-account and per-IP rate limiting, exponential backoff, and temporary lockout after a configurable failure count. Login timing is equalised so response time does not disclose account existence. Every attempt, success or failure, is audited.

---

## 3. Patient session and QR tokens

This is the most security-sensitive part of the product because it grants access with no password.

**Token generation.** 256 bits from a CSPRNG, base64url encoded. Only `SHA-256(token)` is stored (`consultation_access_tokens.tokenHash`). The raw token exists in exactly one place — the QR image — and is never logged, never returned by a list endpoint, and never re-displayed.

**QR contents.** `https://<host>/s/<token>` and nothing else. No name, age, sex, phone, consultation id, pharmacy, price, or clinical data (spec §60).

**Exchange.** First `GET /s/:token` swaps the token for a device-bound patient session cookie and marks it `consumedAt`. Subsequent presentations of the same token are rejected. The patient can refresh, background the browser, and return, because they hold the session cookie — reuse protection applies to the _token_, not the _session_.

**Lost device.** The pharmacy can issue a replacement token, which increments `sequence`, revokes the previous one, and writes an audit entry. This is the only re-entry path, and it is deliberately visible.

**Invalidation.** Tokens expire on a timer, on consultation completion, on cancellation, and on expiry — all four are enforced server-side and tested.

**Scope.** A patient session authorises exactly one `consultationId`. There is no patient-facing endpoint that accepts an arbitrary consultation identifier.

---

## 4. Authorization

RBAC evaluated in middleware on **every** protected route — never in the client (spec §92). Beyond the role check, each resource carries an ownership predicate:

| Resource                          | Rule                                                                                                                        |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Consultation                      | Owning pharmacy, currently-assigned doctor, that patient's session, or admin                                                |
| Prescription                      | Issuing doctor, the consultation's pharmacy, that patient's session, or admin. **No other pharmacy, ever** (spec §45, §102) |
| Substitution request              | Requesting pharmacy or the prescribing doctor                                                                               |
| Patient temporary data            | Owning pharmacy and assigned doctor, **only while the consultation is active**                                              |
| Doctor documents                  | Owning doctor and admin                                                                                                     |
| Feedback and ratings              | Admin only. Doctors have no read path (spec §51)                                                                            |
| Quality score                     | Admin only                                                                                                                  |
| Settings, payouts, refunds, audit | Admin only                                                                                                                  |

Object references are always `publicId`, so enumeration yields nothing. Failed authorization returns `404` where existence itself is sensitive, and `403` otherwise.

---

## 5. Data protection

**In transit:** TLS everywhere; HSTS in production; secure cookies.

**At rest:** application-level AES-256-GCM for patient name and phone, doctor signatures, pharmacy payout details, and TOTP secrets. Keys come from the environment and are never committed. Database-level encryption is a deployment concern documented for the cloud phase.

**Minimisation:** the pharmacy sees four patient fields and only during the active consultation. The doctor sees demographics, vitals, and tests — not any history. Nobody but the doctor sees clinical notes, and at completion they are **sealed**: unreachable by the doctor who wrote them, by the pharmacy, and by any administrator browsing the console. Retrieval takes a known consultation reference, a stated purpose, and a second administrator (D27), and is itself logged as a disclosure. They are destroyed when the retention period expires (D23).

> This paragraph said "deleted at completion" until D23, which established that Ghanaian law does not permit that deletion. The sentence is the one a security reviewer reads first, so it is worth being explicit that the guarantee changed rather than leaving the old wording standing.

**Never stored:** raw card data, CVV, consultation audio or video (no recording capability exists — see `architecture.md` §4).

**Never in URLs, query strings, logs, QR codes, or public pages:** names, phone numbers, clinical content, tokens (spec §60).

**Logging:** pino with an explicit redaction list covering `password`, `token`, `authorization`, `cookie`, `phone`, `patientName`, `notes`, `diagnosis`, `signature`, and payment credentials. Correlation ids on every request tie logs together without carrying content.

---

## 6. Application controls

- **Input validation:** zod at every boundary, shared with the frontend via `packages/contracts`. Unknown keys rejected, not stripped silently.
- **Injection:** Prisma parameterises everything. Raw SQL is prohibited outside reviewed analytics queries, which take bound parameters only.
- **XSS:** React escapes by default; `dangerouslySetInnerHTML` is banned by lint rule. A strict CSP is set.
- **CSRF:** `SameSite=Lax` cookies plus a double-submit token on state-changing requests. Webhook endpoints are exempt and instead authenticated by signature.
- **Headers:** helmet — HSTS, `X-Content-Type-Options`, `X-Frame-Options: DENY`, referrer policy, CSP.
- **CORS:** explicit allow-list, credentials enabled only for the known web origin.
- **Rate limiting:** global, per-IP, and stricter per-route on login, token exchange, password reset, and payment initiation.
- **File uploads:** type and magic-byte validation, size caps, stored outside the web root with generated names, served only through an authorised endpoint, never executed.
- **PDF generation:** server-side PDFKit from structured data — no template injection surface, no headless browser.
- **Least privilege:** a separate `neem_audit` account holds `INSERT`/`SELECT` on `audit_logs` and nothing else — verified: it is refused `DELETE` on that table and refused `SELECT` on `patient_sessions`. It is created by `docker/postgres-init` and granted by `npm run db:grants`, because a grant names a table and migrations have to create it first. **It is not the application's writer**: audit rows commit in the same transaction as the change they record, and a second connection cannot join that transaction, so transactional audit was kept and the append-only guarantee rests on the service surface (no update or delete method, no route, asserted by test). The application role itself owns its schema in the development compose, `DROP` included, because Prisma Migrate needs DDL. **Narrowing it is a deployment task and is not done here** — see §10.

---

## 7. Audit logging

Append-only, covering login/logout, doctor and pharmacy approval and suspension, consultation creation and every state transition, payment confirmation, refund request and decision, doctor assignment and missed response, prescription issue/modify/revoke/dispense, substitution request and decision, referral generation, configuration changes, and access to sensitive records (spec §61).

`metadata` is schema-restricted to non-clinical fields. **The audit log must not become a back-door medical history** — this is asserted by test, not just by convention.

---

## 8. Security test plan (Phase 10)

Every item in spec §79 gets an automated test, not a manual check: unauthorized role access, patient-session takeover, QR token reuse, expired QR access, ID enumeration, IDOR across all resource types, broken authorization, SQL injection, XSS, CSRF, brute force, rate-limit bypass, payment manipulation, webhook spoofing, duplicate webhook, cross-pharmacy prescription access, cross-doctor access, cross-patient access, and admin privilege escalation.

The four critical demonstrations in spec §102 are written as executable tests so they can be run in front of you rather than described.

**Done, 2026-09-03.** `apps/api/tests/integration/security.test.ts` — one file,
deliberately, so §79 can be read in one place rather than reassembled from
fifteen feature files. Every test is written from the attacker's side; where a
feature file already covers the same mechanism, it appears here again in that
form, because "the QR exchange is single-use" and "a photographed QR code
cannot be replayed" are the same property read from opposite ends, and only the
second fails loudly when the mechanism is relaxed for a good-looking reason.

### The authentication boundary is a list, and the list is enforced

The strongest test in the file is not about any one route. `INTENTIONALLY_PUBLIC`
names all fifteen unauthenticated routes with the reason each one is public,
and a sweep reads the **live Fastify route tree** and calls every route
anonymously. Anything that answers without being on the list fails the build.

Three consequences worth stating:

- A route added tomorrow is in scope tomorrow, with nobody remembering to add
  it to a test.
- Making a route public becomes an argument someone has to make in review,
  rather than a line of middleware nobody notices is missing.
- The sweep runs again with a real pharmacy session, a real doctor session and
  a real patient cookie, because "is signed in" and "is allowed" fail
  differently — and the likelier attacker already holds a legitimate account.

A 404 counts as a leak here, not a pass: it means the handler ran and looked
the record up, which is one schema change away from returning it.

### The §102 demonstrations

The master specification names four. The repository cites §102 at the ownership
check of every resource, and these are those four boundaries, each attacked
with a complete legitimate account on the other side:

1. **Cross-pharmacy** — every route that takes a consultation, a prescription
   or a document, called by a second pharmacy. Answers are 404, never 403,
   because confirming the record exists is itself a disclosure.
2. **Cross-doctor** — the clinical workspace above all, which is the whole
   record and would be the most damaging IDOR the product could have.
3. **Cross-patient** — including the structural half: **no patient route
   accepts an identifier at all**, asserted against the route tree. The cookie
   _is_ the scope, so there is nothing to enumerate.
4. **Privilege escalation** — no route writes a role, no non-admin reaches any
   of the 30-odd admin routes, and a password alone does not produce a session
   that can act before the second factor.

### Two findings fixed here

- **`/health/ready` disclosed configuration to anonymous callers**: the
  environment, database latency, every provider by name, which were mocked, and
  `demoMode`. That is reconnaissance — it names the integrations to aim at, and
  in production `demoMode: true` would advertise that payments were not real.
  The probe now answers only whether traffic can be served; the detail moved to
  `GET /admin/system-health`, behind authentication, and onto the admin
  dashboard, which had been claiming to show demo mode while nothing consumed
  the field.
- **`POST /patient/session/leave` revoked nothing.** It cleared the cookie,
  which protects only the person already holding the phone. A session token
  copied off a shared handset at the counter kept working until its own
  expiry. Staff logout has always revoked server-side; the patient now does
  too, and the test steals the token before leaving to prove it.

### Patient-authored free text is encrypted

`feedback.comment`, `complaints.description` and `complaints.resolutionNote`
were plaintext while every other patient field was encrypted. A patient
explaining why they were unhappy writes about their own care, so all three
carry health information whatever the form asked for.

They are encrypted, and now they are encrypted **from the first migration**.
The move originally took two MySQL migrations with a backfill in between —
SQL cannot encrypt, so the middle step was a script. The move to PostgreSQL
(decision D43) rebuilt the migration history as a single initial migration
against an empty database, so there is no plaintext column for a backfill to
read and no half-migrated state to recover from. The script is kept for the
record at `docs/archive/encrypt-free-text.mysql.ts`; it is MySQL-flavoured and
is not runnable against this schema.

### The §80 scenarios

15 of the 16 required end-to-end scenarios now run; the count was 12 when the
phase began. Scenarios 1, 2 and 14 were `test.fixme` placeholders whose stated
blockers had all shipped — 14 had been waiting nine phases behind "needs an
admin scheduling UI", and that screen had never been built, leaving the 40-hour
fatigue ceiling enforced on a route no administrator could reach.

Scenario 15 remains pending and now says why honestly: suspension happens in an
hourly job with no trigger route, and this suite drives a real server over HTTP
so it cannot move the clock. Adding an endpoint that exists only for a test
would be inventing product surface to make a test pass. It is covered with an
injected clock in `membership.test.ts`.

**A skip is not a pass.** Three of the four skips found here were stale
placeholders, and the fourth was hiding an assertion that Phase 9 had broken.
Nothing in the reporting distinguished them from successes.

### What is deliberately not tested

There is no test that a recording cannot be retrieved, because there is no
recording API to attack. That guarantee is structural (spec §64) and is
asserted against the media adapter's configuration, which is where it could
regress.

---

## 9. Backup and recovery

Documented in Phase 1, exercised in Phase 10, and re-proved against PostgreSQL in D43: automated backups, retention period, restore procedure with a rehearsed restore, and an explicit statement of the window during which purged temporary data still exists in backups (see `data-retention.md` §5). Pretending backups do not retain deleted rows would be dishonest; stating the window and bounding it is the correct engineering answer.

**Exercised, 2026-09-03.** `scripts/backup.mjs`, `scripts/restore.mjs` and
`scripts/rehearse-restore.mjs`. The rehearsal backs up the live database,
restores it into a scratch database under a different name, compares row counts
table by table, and drops the scratch database. See `data-retention.md` §7 for
the result and what it caught.

---

## 10. What this repository does not enforce

Controls that are real obligations of a deployment rather than properties of the code, listed here so that reading §1–§9 does not leave the impression they are already in force.

| Obligation                                                                               | Why it is not enforced here                                                                                                                                                                                   | What a deployment must do                                                                                                                                              |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The application account should not hold `DROP`, or `UPDATE`/`DELETE` on `audit_logs`** | The development compose makes the app role the owner of its schema, because Prisma Migrate needs DDL and an owner cannot be denied a privilege on a table it owns                                             | Run migrations as a separate migration account, and grant the runtime account per-table privileges that omit `audit_logs` write access beyond `INSERT`                 |
| **TLS, HSTS, secure cookies**                                                            | §5 describes the production posture; the development server is plain HTTP on localhost                                                                                                                        | Terminate TLS in front of the API and set `NODE_ENV=production`, which the config loader already requires before it will accept a deployment                           |
| **Database-level encryption at rest**                                                    | Application-level AES-256-GCM covers the identified fields; whole-disk and tablespace encryption is a hosting concern                                                                                         | Enable it on the managed instance, and encrypt backups — `BACKUP_ENCRYPTION_KEY` is required and refuses to equal `ENCRYPTION_KEY`                                     |
| **Key rotation**                                                                         | `ENCRYPTION_KEY_PREVIOUS` exists and decryption falls back to it, so rotation is possible; nothing schedules or audits a rotation                                                                             | Own a rotation schedule, and re-encrypt rather than relying on the fallback indefinitely                                                                               |
| **Recording must be off in the Whereby account**                                         | The adapter never asks Whereby to record and `VideoProvider` has no method that could — but Whereby's dashboard can enable recording independently of this repository, and no code here can read that setting | Confirm recording is disabled at the account level before the first real consultation, and treat the setting as a change that needs review. See [D35](decision-log.md) |

**The recording row is the one that changed character.** Until [D35](decision-log.md) it was not on this list at all: consultations could not be recorded because no adapter carried media and the interface had no method to ask. Moving video to Whereby kept the architectural half — the capability is still absent from the contract, and `whereby-adapter.test.ts` asserts the request body has no `recording` key — but added an account setting outside the code's reach. A guarantee that used to be structural is now structural **and** operational, which is weaker, and is listed here rather than left to be discovered.

Run `npm run check:production-config` against the environment file a deployment will use. It applies the production rules to it and reports what would refuse to boot, which catches a development configuration copied to a server before the server does.
