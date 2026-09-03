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

## Phase 5.5 — Retention rebuild ✅ complete 2026-09-01

The G7 answer reversed the deletion model, so this lands before the clinical workflow that depends on it.

Clinical records reclassified from delete-at-completion to retain-then-expire · `retention.clinicalRecordYears` setting, defaulting to 3 · field encryption for vitals and point-of-care results, which were plaintext because they were about to be destroyed · encryption key rotation path · scheduled destruction job · the consultation reference surfaced to the patient at completion · patient-facing notice replacing the deletion promise · Archived Consultation Retrieval, two-person authorised and fully logged (D27).

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

**Retrieval landed after counsel answered G7c** (D27). Renamed from break-glass
to Archived Consultation Retrieval on counsel's instruction — the old name
implies emergency clinical access, which this is not. Admin only, one
consultation reference at a time, two different administrators required, a
stated purpose from a closed list, and an append-only log written before the
record is returned.

**Research access is deliberately unbuilt** although counsel permits it, for
the reason in `data-retention.md` §4.

---

## Phase 6 — Clinical workflow ✅ complete 2026-09-02

Vitals and point-of-care test entry by the pharmacy · the doctor's clinical workspace · outcome capture · prescription creation, items, and the prescription state machine · digital signature binding to the verified doctor · prescription PDF · public QR verification page · revocation before dispensing · dispensing and immutability · the pharmacy substitution workflow with doctor approval · referral creation and PDF · **the consultation summary** — doctor-authored, mandatory for advice-only outcomes, permanent, with its own verification page (D25) · **the completion transaction, which now seals and schedules rather than purges** (D23).

~~Also folded in: pharmacy document upload and the activation check.~~ **Done ahead of Phase 6** on 2026-08-29, while the G7 follow-up questions sit with counsel — see the Phase 2 note below.

**Exit — met at the API layer.** Scenarios 6, 7, 8, 9, 10, 11, 12 and 13 pass
end to end through the real HTTP surface (`e2e/clinical.spec.ts`), taking the
required set from 3 of 16 to 11 of 16. The revised §101 test is scenario 11:
after completion the clinical record still exists, no role can read it, and it
is destroyed when its retention period elapses.

**The front end is built.** The pharmacy's vitals and point-of-care entry
(`ClinicalIntake`), the doctor's clinical workspace (`ClinicalWorkspace`), the
pharmacy prescription and dispensing screen, the doctor's substitution inbox,
and the public verification page.

Building the screens surfaced work that the API-layer tests could not have
caught, because in each case the route was right and nothing reached it:

- **A pharmacy could propose a substitution that no doctor could ever see.**
  `POST /doctor/substitutions/:id/decide` existed; nothing listed what was
  awaiting a decision. A proposal blocks dispensing, so every unanswered one
  was a patient at a counter with nothing in their hand.
  `GET /doctor/substitutions` and `/doctor/substitutions` close that loop.
- **A pharmacy had no way to record vitals at all.** The routes existed and
  were tested; no screen called them. Since the pharmacy's measurements are
  the only clinical data a remote doctor gets beyond a name and an age, this
  was the largest hole in the phase.
- **The doctor's screen 403'd on its own completed consultations.** The route
  read the clinical record unconditionally, so sealing took the whole endpoint
  down with it. Only the clinical part is sealed; the operational record is
  not, and a doctor looking back at a consultation they finished should see it.
- **`activeOnly=false` meant true.** `z.coerce.boolean()` applies
  JavaScript's `Boolean()`, under which the string `"false"` is truthy — so
  the pharmacy's "All" toggle silently returned the to-dispense list and a
  dispensed prescription could not be found again. Replaced everywhere by
  `queryBoolean` in `src/lib/query.ts`.

**Carried forward, not fixed here.** Phase 4 lists "Socket.IO wiring for
queue, waiting room, and dashboards". The server half exists and emits —
`prescription.issued`, `substitution.requested`, `substitution.decided` and
the queue events — but no client anywhere opens a socket: `socket.io-client`
is a declared dependency with no import. Every screen, including the ones
added here, refreshes by polling instead. That is adequate for a counter
workflow measured in minutes and wrong for the 90-second offer window, so it
belongs with the queue rather than the clinical workflow.

Two more surfaced while building this and were fixed here:

- **The NIGHT shift could never be activated.** The backlog claimed 24-hour
  operation was "accommodated" by seeding the definition inactive, but no route
  could turn it on. `PATCH /admin/shifts/definitions/:code` is that switch. It
  also stopped the end-to-end suite skipping itself outside 08:00–20:00 UTC,
  which was giving false confidence overnight.
- **The global rate limiter keys by IP, not by principal.** Its hook is
  registered before the auth plugin, so `request.principal` is always
  undefined and the fallback applied. The ordering is correct — limiting before
  authentication is what stops a flood reaching the session lookup — but the
  comment claiming per-principal limiting was wrong and is corrected. Whether
  one budget per NAT suits a busy pharmacy is a Phase 10 question.

---

## Phase 6.5 — closing what nothing called

**Completed 2026-09-02.** A sweep for API routes with no caller, and tables
with no writer, after Phase 6 turned up four such gaps. Three were closed here;
the fourth (the admin console over archived-consultation retrieval, the audit
log and retention health) belongs with Phase 9.

- **Patient feedback had no write path.** The `feedback` table had no writer
  anywhere, while the queue weights a doctor's mean rating at 0.3 and their
  complaint count at 0.2 — so half of every doctor's quality score sat at its
  neutral default and the routing fairness it exists to provide was not
  happening. Now captured on the patient's completion screen, with a
  `COMPLAINT` opening a complaints row for Phase 9's console.
- **The patient's session died at completion.** Found while building the
  above: `resolvePatientSession` gated on the states in which a patient may
  *act*, so the phone got a 401 the moment the doctor completed. The
  completion screen — carrying the consultation reference that D24 makes the
  patient's only route back to their own record — was unreachable, and had
  been since D24 was implemented. Reading and acting are now separate rights.
- **The step ladder outranked the outcome.** Exposed by the fix above: a
  consultation that ended before the patient finished a step reported that
  step, so a cancelled consultation would have shown a language picker. Only
  reachable once the session survived, and fixed with it.
- **Password reset was unreachable from both ends.** Two API routes live since
  Phase 1 with nothing linking to them: no "Forgot your password?" on the
  sign-in page and no screen to consume a token. Both now exist. Delivery
  still waits on the Phase 8 email adapter, and the screen says so rather than
  promising an email that will not arrive (spec §93).
- **`/pharmacy/capabilities` had no caller.** The point-of-care entry added in
  Phase 6 asked every pharmacy to type a test name and derived a code from the
  text, so one test recorded three ways became three codes. The pharmacy's
  declared tests are now offered as one tap each, carrying their real codes;
  free text stays for anything else.

---

## Phase 7 — Financial system

Real Paystack integration · server-side verification · signature-verified webhooks · the four idempotency constraints · refund request and admin approval · revenue allocation · pharmacy payout tracking and manual settlement · reconciliation job · doctor membership payments and expiry → suspension · promotions and discounts with server-side validation.

**Exit:** the §103 critical financial test is demonstrated — duplicate webhook creates no duplicate revenue; splits are exact and reproducible.

**Part one landed 2026-09-02.** The exit criterion is met and asserted against
a real database: three webhooks for one charge produce exactly one revenue
allocation, the split reconstitutes the total exactly in integers, and the rate
in force is stored so a later configuration change cannot rewrite history.

- **The Paystack adapter.** Signature verified against the raw body with HMAC
  SHA-512 before the body is parsed, constant-time; unrecognised provider
  statuses map to PENDING so nothing unanticipated can settle a consultation.
  `PAYSTACK_WEBHOOK_SECRET` is no longer required — Paystack signs with the
  secret key, and demanding a second value invited an operator to invent one,
  which would have failed every real webhook's signature check.
- **Refunds**, end to end: patient and pharmacy request surfaces, an admin
  decision queue, provider call before any local write, revenue reversal, and
  `refund.processed` closing the loop. §80 scenario 16 is covered.
- **Payouts**: period calculation, an admin settlement record with a required
  reference, and a pharmacy earnings screen showing real figures.
- **Two jobs that existed and never ran.** `runSubscriptionExpirySweep` had
  been written in Phase 2 and never scheduled, so a doctor whose six-month
  membership lapsed stayed ACTIVE and kept taking consultations. Reconciliation
  is new: it finds payments where Neem and the provider disagree — usually a
  webhook that never arrived — and records the drift without correcting it.

Two state-machine changes were needed and are worth naming. `EXPIRED`,
`CANCELLED` and `ABANDONED` became re-enterable, because all three are
reachable *after* payment and a consultation that took money and delivered
nothing had no route by which the money could go back. `COMPLETED` was
deliberately left terminal: a consultation that happened was delivered, and a
patient unhappy with it has a complaint, not an automatic claim on the fee.
That in turn required the capacity release in `transition()` to fire only on a
consultation's first ending, or a refunded consultation would have handed its
doctor a slot they were not free for.

**Part two landed 2026-09-02**, closing the phase.

- **Membership payment.** The lifecycle had existed since Phase 2 with nothing
  able to pay for it. It now runs through the same settlement path a
  consultation fee takes — same verification, same idempotency — while
  activating no consultation and creating no revenue allocation, because no
  pharmacy has a share in a doctor's membership fee. Paying lifts a suspension
  only when the doctor was suspended for non-payment; an administrator's
  suspension for any other reason survives it, and the membership is still
  recorded as paid so the money is not lost.
- **Payroll.** `domain/compensation.ts` implemented D28's formula and had no
  caller, so nothing computed a doctor's pay. There is now an admin run and a
  doctor's own view of their figure. Neem calculates and does not transfer
  (spec §26) — no route marks a salary sent. A doctor with no contracted hours
  is omitted and counted rather than assumed full-time.
- **Promotions.** Redemption was already validated server-side inside
  consultation creation. What was missing was the other half:
  `PROMOTION_MANAGE` was a permission with no route, so running a campaign
  meant writing rows by hand. Codes are now created and withdrawn from an admin
  screen, and the list reports what each campaign has actually given away —
  `usedCount` alone does not say it.

A promotion whose value does not match its type is refused at creation: a
PERCENT code carrying only `valueMinor` would have stored cleanly and then
discounted nothing, because `computeDiscount` reads the field its type names.

---

## Phase 8 — Notifications

Notification abstraction and template rendering · browser and in-app notifications with sound for doctor offers · SMS, email, and WhatsApp adapters with mock implementations · push architecture · delivery tracking and bounded retry · admin template configuration.

**Exit:** every notification in spec §58 fires on its trigger; no notification payload contains clinical content.

---

## Phase 9 — Admin and analytics

Real-time operational dashboard · financial dashboard · analytics over retained data only, with explicit labelling of what is unavailable because it was deleted · doctor and pharmacy performance · satisfaction and complaints · quality score management · settings console with confirmation and impact description on sensitive changes · audit log viewer · system health.

**Exit:** the admin can perform every §100 admin capability; analytics never manufacture deleted clinical data.

**Completed 2026-09-03.** The exit criterion holds by construction rather than
by discipline: the analytics module contains no query against a clinical
record, and where a figure could be affected by destruction its coverage is
reported beside it.

- **The three placeholder dashboards are gone.** Admin, pharmacy and doctor all
  showed figures invented for the design prototype — GH₵ 68,420 of revenue,
  GH₵ 1,420, GH₵ 420 — behind a notice saying not to believe them. A dashboard
  that has to warn you off its own numbers is not a dashboard.
  `PrototypeDataNotice` and `neem-data.ts` are deleted, because nothing needs
  them any more.
- **The settings console** closes §96. `listSettings` and `updateSetting` had
  existed since Phase 2 with no routes, so changing a price or a revenue split
  meant editing the database by hand.
- **Archived consultation retrieval** has existed since Phase 5.5 with no
  caller, which meant Neem carried a legal obligation — made explicitly to
  counsel in the G7c answer — that it could not discharge. Exercising it
  surfaced that a single-administrator deployment cannot retrieve a record at
  all, because self-authorisation is refused. That is the four-eyes control
  working, and a deployment constraint worth knowing before a court order
  arrives rather than after.
- **Complaints and quality review**, closing the loop that began with patient
  feedback in Phase 6.5: a patient marks feedback as a complaint, it opens
  against a category, and an administrator resolves or dismisses it with a
  written outcome. Verified end to end on real data.
- **The audit log viewer**, read-only, with no edit or delete route behind it.

One defect introduced and caught here: the admin navigation reached ten items
and overflowed its container, 1063px into 885px, silently clipping the last
entries. `min-w-0` is the part that matters — a flex child will not shrink
below its content without it, so the bar grew and pushed items off the end
instead of scrolling.

---

## Phase 10 — Security and QA

Full authorization audit · every §79 security test automated · retention verification · payment integrity · QR security · role isolation · cross-tenant prescription access · performance and pagination checks · the complete E2E suite · backup and restore rehearsal.

**Exit:** the four §102 critical security demonstrations pass as tests; all critical and high findings fixed.

---

## Phase 11 — Demo readiness

Seeded demo environment clearly marked DEMO and isolated from production config · demo admin, pharmacies, doctors, consultations, payments, prescriptions, referrals, feedback, analytics · UI polish across empty, loading, error, and success states · accessibility pass · complete README and setup instructions · a written demonstration script covering pharmacy → patient → doctor → prescription → admin.

**Exit:** you can run the full business cycle end to end on this machine from a clean checkout.
