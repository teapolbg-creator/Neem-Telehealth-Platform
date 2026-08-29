# Security Model

**Status:** Proposed (Phase 0). Security is a first-class MVP requirement, not a later hardening pass (spec §59).

---

## 1. Principals

| Principal | Authentication | Notes |
| --- | --- | --- |
| Patient | No account. Single-use consultation token exchanged for a device-bound session | Scoped to exactly one consultation |
| Pharmacy | Email + password | One account per pharmacy; no sub-roles |
| Doctor | Email + password | Must be `ACTIVE` to work |
| Admin | Email + password + **mandatory TOTP 2FA** | |

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

**Exchange.** First `GET /s/:token` swaps the token for a device-bound patient session cookie and marks it `consumedAt`. Subsequent presentations of the same token are rejected. The patient can refresh, background the browser, and return, because they hold the session cookie — reuse protection applies to the *token*, not the *session*.

**Lost device.** The pharmacy can issue a replacement token, which increments `sequence`, revokes the previous one, and writes an audit entry. This is the only re-entry path, and it is deliberately visible.

**Invalidation.** Tokens expire on a timer, on consultation completion, on cancellation, and on expiry — all four are enforced server-side and tested.

**Scope.** A patient session authorises exactly one `consultationId`. There is no patient-facing endpoint that accepts an arbitrary consultation identifier.

---

## 4. Authorization

RBAC evaluated in middleware on **every** protected route — never in the client (spec §92). Beyond the role check, each resource carries an ownership predicate:

| Resource | Rule |
| --- | --- |
| Consultation | Owning pharmacy, currently-assigned doctor, that patient's session, or admin |
| Prescription | Issuing doctor, the consultation's pharmacy, that patient's session, or admin. **No other pharmacy, ever** (spec §45, §102) |
| Substitution request | Requesting pharmacy or the prescribing doctor |
| Patient temporary data | Owning pharmacy and assigned doctor, **only while the consultation is active** |
| Doctor documents | Owning doctor and admin |
| Feedback and ratings | Admin only. Doctors have no read path (spec §51) |
| Quality score | Admin only |
| Settings, payouts, refunds, audit | Admin only |

Object references are always `publicId`, so enumeration yields nothing. Failed authorization returns `404` where existence itself is sensitive, and `403` otherwise.

---

## 5. Data protection

**In transit:** TLS everywhere; HSTS in production; secure cookies.

**At rest:** application-level AES-256-GCM for patient name and phone, doctor signatures, pharmacy payout details, and TOTP secrets. Keys come from the environment and are never committed. Database-level encryption is a deployment concern documented for the cloud phase.

**Minimisation:** the pharmacy sees four patient fields and only during the active consultation. The doctor sees demographics, vitals, and tests — not any history. Nobody but the doctor sees clinical notes, and those are deleted at completion.

**Never stored:** raw card data, CVV, patient clinical notes past completion, consultation audio or video (no recording capability exists — see `architecture.md` §4).

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
- **Least privilege:** the application database user has no `DROP`; the audit writer is a separate user with `INSERT`/`SELECT` on `audit_logs` only.

---

## 7. Audit logging

Append-only, covering login/logout, doctor and pharmacy approval and suspension, consultation creation and every state transition, payment confirmation, refund request and decision, doctor assignment and missed response, prescription issue/modify/revoke/dispense, substitution request and decision, referral generation, configuration changes, and access to sensitive records (spec §61).

`metadata` is schema-restricted to non-clinical fields. **The audit log must not become a back-door medical history** — this is asserted by test, not just by convention.

---

## 8. Security test plan (Phase 10)

Every item in spec §79 gets an automated test, not a manual check: unauthorized role access, patient-session takeover, QR token reuse, expired QR access, ID enumeration, IDOR across all resource types, broken authorization, SQL injection, XSS, CSRF, brute force, rate-limit bypass, payment manipulation, webhook spoofing, duplicate webhook, cross-pharmacy prescription access, cross-doctor access, cross-patient access, and admin privilege escalation.

The four critical demonstrations in spec §102 are written as executable tests so they can be run in front of you rather than described.

---

## 9. Backup and recovery

Documented in Phase 1, exercised in Phase 10: automated MySQL backups, retention period, restore procedure with a rehearsed restore, and an explicit statement of the window during which purged temporary data still exists in backups (see `data-retention.md` §5). Pretending backups do not retain deleted rows would be dishonest; stating the window and bounding it is the correct engineering answer.
