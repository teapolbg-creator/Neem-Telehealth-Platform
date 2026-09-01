# Implementation Roadmap

Phases follow spec §99. Each ends with tests run, a change summary, a demonstration, and a stop for your approval.

---

## Phase 0 — Discovery ✅ complete, awaiting approval

Repository inspected, business document and both clarification rounds reconciled, ten conflicts identified, architecture and database proposed, documentation structure created. **Five Category A questions outstanding** — see `phase-0-findings.md` §6.

---

## Phase 1 — Foundation

Repository restructure per the D1 decision · fresh git baseline · `.env.example` and validated config loading · Docker compose (MySQL, MailHog, Adminer) or native MySQL setup · Prisma schema and first migration for the full ERD · argon2id auth, opaque sessions, RBAC middleware, admin TOTP 2FA · rate limiting, lockout, CSRF, security headers · pino structured logging with redaction · audit-log writer · Vitest + Playwright harnesses · design-system extraction from the Lovable CSS into shared components · `AppShell` wired to real auth.

**Exit:** the app runs, the database migrates, a seeded admin can log in with 2FA, unauthorised access is refused, and the test suite passes.

---

## Phase 2 — User management

Pharmacy onboarding with document upload and the pharmacy state machine · doctor onboarding, credentials, drawn signature capture, licence tracking, doctor state machine · admin verification queues and approval workflow · doctor subscriptions with Paystack (mock adapter at this stage) · shift definitions, assignment, confirmation · the 40-hour weekly ceiling enforced inside the assignment transaction · admin user management.

**Exit:** a doctor and a pharmacy can be onboarded end to end and approved by an admin; the 40-hour rule refuses an over-assignment; suspension ends a live session.

**Completed late, 2026-08-29.** The pharmacy half of this phase shipped without its verification path: no registration screen, no document upload route, and no check on activation — so `verifiedDocumentCount` was structurally always zero, and every pharmacy that reached ACTIVE did so without a document being looked at. Now closed: `/onboarding/pharmacy` (apply), `/pharmacy/onboarding` (upload and track), `POST /pharmacy/documents`, `GET /admin/pharmacies/documents/:id` so the reviewer can open the file, and the same activation check doctors have always had.

---

## Phase 3 — Patient consultation engine

Consultation creation and the full state machine · payment orchestration behind `PaymentProvider` (mock) · the 5-minute payment window and expiry job · cryptographic access tokens and real QR generation · token exchange and device-bound patient sessions · patient identity, language, and mode capture · waiting room · session expiry and invalidation.

**Exit:** pharmacy → payment → QR → scan → identity → waiting room works on a phone-sized viewport; an expired or reused QR is refused.

---

## Phase 4 — Smart queue

Doctor presence and availability · eligibility filter with language as a hard gate · the six-factor weighted scoring engine · the 90-second offer window with server-side enforcement · missed-response recording and automatic reassignment · no-language-match and queue-delay admin alerts · admin manual intervention · Socket.IO wiring for queue, waiting room, and dashboards.

**Exit:** scenarios 3, 4, and 5 from spec §80 pass as automated tests.

---

## Phase 5 — Telemedicine

`VideoProvider` / `VoiceProvider` interfaces with Twilio and mock adapters (contingent on the Twilio Video roadmap check, C9) · audio and video sessions · Call Me via bridged voice with neither party's number exposed · consultation timer with warnings and no auto-termination · connection loss and reconnection handling · completion flow.

**Exit:** all three consultation modes work; a test asserts no recording can be created.

---

## Phase 5.5 — Retention rebuild ✅ built 2026-09-01, except break-glass

The G7 answer reversed the deletion model, so this lands before the clinical workflow that depends on it.

Clinical records reclassified from delete-at-completion to retain-then-expire · `retention.clinicalRecordYears` setting, defaulting to 3 · field encryption for vitals and point-of-care results, which were plaintext because they were about to be destroyed · encryption key rotation path · scheduled destruction job · the consultation reference surfaced to the patient at completion · patient-facing notice replacing the deletion promise · ~~reference-scoped break-glass access~~ **deferred pending counsel on G7c**.

**No patient index and no profile** (D24). Records are located by consultation reference, so subject access is serviced by reference rather than by a person-scoped search. That is smaller than first scoped.

**Exit — met, with one part deliberately unbuilt.**

Done: clinical records survive the end of a consultation; sealing happens
inside `transition()` on any terminal state so no completion path can forget
it; vitals and point-of-care results are encrypted where they were plaintext;
`readClinicalRecord` refuses a sealed record and an integration test greps
`src/` to prove no other module can route around it; destruction runs hourly
and is a real DELETE with provable counts; the encryption key can be rotated
without a flag day; and the patient is given their consultation reference at
completion.

**Not done, deliberately: break-glass access.** The `clinical_record_access_log`
table exists so that adding it is routes-only, but no route writes to it and
nothing can open a sealed record. Held pending counsel on G7c — whether a
sealed archive counts as complying when continuity of care is declined. If the
answer is no, the read path changes shape, and building it twice would be
worse than waiting. Until then the correct contents of that table is zero rows.

---

## Phase 6 — Clinical workflow

Vitals and point-of-care test entry by the pharmacy · the doctor's clinical workspace · outcome capture · prescription creation, items, and the prescription state machine · digital signature binding to the verified doctor · prescription PDF · public QR verification page · revocation before dispensing · dispensing and immutability · the pharmacy substitution workflow with doctor approval · referral creation and PDF · **the consultation summary** — doctor-authored, mandatory for advice-only outcomes, permanent, with its own verification page (D25) · **the completion transaction, which now seals and schedules rather than purges** (D23).

~~Also folded in: pharmacy document upload and the activation check.~~ **Done ahead of Phase 6** on 2026-08-29, while the G7 follow-up questions sit with counsel — see the Phase 2 note below.

**Exit:** scenarios 6–13 pass; the §101 critical test is demonstrated in its revised form — clinical data present during, present but unreadable after, gone after expiry.

---

## Phase 7 — Financial system

Real Paystack integration · server-side verification · signature-verified webhooks · the four idempotency constraints · refund request and admin approval · revenue allocation · pharmacy payout tracking and manual settlement · reconciliation job · doctor membership payments and expiry → suspension · promotions and discounts with server-side validation.

**Exit:** the §103 critical financial test is demonstrated — duplicate webhook creates no duplicate revenue; splits are exact and reproducible.

---

## Phase 8 — Notifications

Notification abstraction and template rendering · browser and in-app notifications with sound for doctor offers · SMS, email, and WhatsApp adapters with mock implementations · push architecture · delivery tracking and bounded retry · admin template configuration.

**Exit:** every notification in spec §58 fires on its trigger; no notification payload contains clinical content.

---

## Phase 9 — Admin and analytics

Real-time operational dashboard · financial dashboard · analytics over retained data only, with explicit labelling of what is unavailable because it was deleted · doctor and pharmacy performance · satisfaction and complaints · quality score management · settings console with confirmation and impact description on sensitive changes · audit log viewer · system health.

**Exit:** the admin can perform every §100 admin capability; analytics never manufacture deleted clinical data.

---

## Phase 10 — Security and QA

Full authorization audit · every §79 security test automated · retention verification · payment integrity · QR security · role isolation · cross-tenant prescription access · performance and pagination checks · the complete E2E suite · backup and restore rehearsal.

**Exit:** the four §102 critical security demonstrations pass as tests; all critical and high findings fixed.

---

## Phase 11 — Demo readiness

Seeded demo environment clearly marked DEMO and isolated from production config · demo admin, pharmacies, doctors, consultations, payments, prescriptions, referrals, feedback, analytics · UI polish across empty, loading, error, and success states · accessibility pass · complete README and setup instructions · a written demonstration script covering pharmacy → patient → doctor → prescription → admin.

**Exit:** you can run the full business cycle end to end on this machine from a clean checkout.
