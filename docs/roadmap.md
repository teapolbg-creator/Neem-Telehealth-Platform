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
  _act_, so the phone got a 401 the moment the doctor completed. The
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
reachable _after_ payment and a consultation that took money and delivered
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

**Completed 2026-09-03.**

- **The authentication boundary is now a written list that the build
  enforces.** `security.test.ts` reads the live Fastify route tree and calls
  every route anonymously; anything that answers without appearing in
  `INTENTIONALLY_PUBLIC` — fifteen routes, each with its reason — fails. The
  sweep runs again with a real pharmacy session, a real doctor session and a
  real patient cookie, because "is signed in" and "is allowed" fail
  differently and the likelier attacker already holds an account. A route
  added next month is in scope next month without anyone remembering.
- **The four §102 demonstrations** are executable: cross-pharmacy,
  cross-doctor, cross-patient and privilege escalation, each attacked with a
  complete legitimate account on the other side of the boundary. The
  cross-patient one has a structural half worth naming — **no patient route
  accepts an identifier at all**, asserted against the route tree, so there is
  nothing to enumerate.
- **`/health/ready` was disclosing configuration to anonymous callers**: the
  environment, database latency, every provider by name, which were mocked,
  and `demoMode`. That names the integrations worth attacking, and in
  production `demoMode: true` would have advertised that payments were not
  real. Narrowed to a readiness answer; the detail moved to
  `GET /admin/system-health` and onto the admin dashboard — which had carried
  a comment claiming it showed demo mode honestly while **nothing consumed the
  field**. Another route with no caller, found the same way as Phase 6.5's
  four.
- **`POST /patient/session/leave` revoked nothing.** It cleared the cookie,
  which protects only whoever already has the phone; a token copied off a
  shared handset at a pharmacy counter kept working until its own expiry.
  Staff logout has revoked server-side since Phase 2. The test steals the
  token before leaving, which is the only version of this test that means
  anything.
- **Patient-authored free text was plaintext.** `feedback.comment`,
  `complaints.description` and `complaints.resolutionNote` — while every other
  patient field was encrypted. A patient explaining why they were unhappy
  writes about their own care. Moved under field encryption in two migrations
  with a backfill between them, because SQL cannot encrypt; the backfill
  verifies no row is left half-migrated before it reports success, since the
  second migration is destructive.
- **The whole shadcn/ui directory was dead code** — 46 files, nothing outside
  it importing any of them, and `chart.tsx` carrying a
  `dangerouslySetInnerHTML` sink that interpolated `id` and `color` into a
  `<style>` tag. Deleted rather than audited: an XSS sink no code reaches is
  still a sink the next person will reach for.
- **A skipped test was sheltering a broken one.** Resetting the demo
  administrator’s two-factor enrolment made the enrolment walkthrough runnable
  again, and it failed at once: it asserted a heading "Executive overview"
  that Phase 9 renamed to "Overview". The assertion broke that day and nobody
  saw it, because enrolling the demo admin through a browser — done while
  verifying Phase 9 — made the test skip permanently, the TOTP secret being
  unrecoverable by design. Nothing in "44 passed, 5 skipped" distinguishes it
  from "45 passed", which is the whole reason the five were worth opening.
- **`docs/api.md` named 31 routes that do not exist**, and now names none.
  It was written in Phase 0 as a design and never checked against what
  shipped. Most entries were provisional names the implementation moved past;
  eight were capabilities never built. Every listing now matches the router,
  and the eight sit under `NOT BUILT` markers where they stood — including two
  worth being able to point at: `/admin/consultations` is refused by design,
  because an administrator who can list consultations can assemble the
  longitudinal history D24 exists to prevent, while `/admin/reconciliation`
  is a genuine gap (the sweep runs hourly into the audit log, but no screen
  shows payment drift to a human).

  `docs-drift.test.ts` keeps it reconciled: every path the document names must
  exist or be marked absent, and a renamed route now fails a test instead of
  quietly widening the gap again. The same argument as D33, applied to prose.

  It also settled a contradiction in `data-retention.md` §8, which claimed
  doctors see a consultation history. They have no such route — the true
  position is stricter than the document claimed, but it was true by omission
  rather than by decision.

- **The patient had no way to end their session.** Found by sweeping all 131
  routes for callers after the phase was otherwise done. `POST
/patient/session/leave` existed from Phase 3 and nothing invoked it — the
  portal's only "Leave" is the call's, which ends the video and lets
  the patient rejoin. So a handset going back over a pharmacy counter kept a
  live session until it expired. Worth saying plainly: D34 fixed that route's
  revocation semantics earlier **in the same phase**, and I fixed the
  mechanism without noticing there was no door to it.

  `Finish and clear this phone` now appears on the completion and closed
  screens. It confirms first, and the confirmation asks about the consultation
  reference rather than about sessions and cookies — losing the reference is
  the consequence a patient can actually act on (D24), and this screen is the
  last place it is shown. Afterwards the portal renders a screen holding
  nothing: no reference, no name, no pharmacy, because one still saying
  "Consultation complete" would tell the next person in the queue that someone
  had just been seen.

  Verified in a browser and then pinned in Scenario 1: the cookie is gone, the
  session probe returns 401, and a token copied off the device beforehand is
  refused as well — the half a cleared cookie does nothing about.

- **The notification catalogue had no screen either.** Phase 8 built 21
  templates, the allowed-variable list for each and the validation that stops
  one carrying clinical content; `useNotificationTemplates` did not exist and
  no component imported the routes. The wording of every message Neem sends
  could be changed only by editing the database. `/admin/notifications` closes
  it.

  The refusal is the feature, so the screen shows exactly which rule was
  broken rather than a generic failure — the API returns one entry per broken
  rule, and a body can name a dose _and_ use a variable the notification
  cannot fill. Verified against the live API and then in the browser: saving
  "Take 500mg twice daily for your diagnosis" is refused with both reasons
  named, an unknown `{{placeholder}}` is refused separately, and a valid edit
  saves and round-trips.

  The route was then made to match how the system actually works. It listed
  the _table_, so a template with no row was invisible and its first edit
  impossible — `update` on a row that does not exist fails, and every template
  starts without one. It now lists the **catalogue** and treats rows as the
  overrides they are, upserts on write, builds a created row from the
  catalogue so editing a body does not blank the subject, and refuses a
  channel the notification is never sent on. Absence of a row now reads as
  "untouched", never "disabled". Three tests pin it.

  Building it surfaced that the dev database held **zero** template rows: the
  seed writes them, and this database predates Phase 8. Not a product defect —
  `notify()` reads the code catalogue and treats the rows as overrides, so
  messages were always sent correctly — but it did mean the screen opened
  empty, and it is the second time this phase that a thing existed only in
  code.

- **The last two uncalled routes, resolved differently.**
  `GET /admin/analytics/coverage` is **deleted**: it returned exactly the
  `clinicalCoverage(period)` value that `/outcomes` already carries, with none
  of the context that makes it meaningful, and nothing called it. Two
  endpoints for one figure is two places for the figure to disagree — and this
  figure exists precisely so a period whose records were destroyed cannot be
  read as a whole one. It travels with the mix it qualifies. A comment stands
  where the route was, so the next person does not add it back.

  `POST /admin/doctors/:publicId/subscription` **stays, with no screen.** The
  paid path does not need it — `settleMembershipPayment` creates the period
  itself — so what it uniquely offers is granting a period nobody paid for.
  That is a revenue decision, absent from the backlog's admin capabilities, and
  not worth a button that makes it a click. Its response did need fixing: it
  told administrators that payment "is integrated in Phase 7" three phases
  after Phase 7 shipped. It now says plainly that the doctor was not charged.

- **Backup and restore, rehearsed rather than documented.** `npm run
backup:rehearse` backs up the live database, restores it into a scratch
  database, and compares row counts table by table — 60 tables, 17,229 audit
  rows, all matching. Comparing is the point: a restore that runs cleanly and
  produces an empty table is the failure worth catching, and it looks exactly
  like success if all you check is the exit code. It caught two things on its
  first run, both in `data-retention.md` §7.
- **The audit log could not be read past its first page.** `/admin/audit-logs`
  accepted a cursor from the shared pagination schema and ignored it, so the
  newest hundred entries were the only ones reachable — in the one record that
  exists to answer "who saw this, and when". Written correctly, unreadable
  beyond page one. Now pages like every other list, keyed on `id` rather than
  `occurredAt` because a consultation transition writes several entries in the
  same millisecond and a cursor on a tied column drops rows. The screen gained
  a "Show older entries" control, which it had never had.
- **Four of the sixteen required §80 scenarios had never run.** They were
  `test.fixme` placeholders, which is the honest way to carry a gap — but
  every blocker named in their notes had already shipped. Scenario 14 had been
  waiting nine phases behind "needs an admin scheduling UI, which arrives with
  the Phase 9 admin console".
- **That scheduling screen never arrived, and its absence was a real gap.**
  `POST /admin/shifts` existed from Phase 2 and `useAssignShift` was written
  in the feature layer, but no component imported either. The 40-hour weekly
  ceiling — a fatigue rule — was enforced on a route no administrator could
  reach through the product. `/admin/scheduling` closes it, and Scenario 14
  now drives the refusal through the screen: an API that says no is worth
  nothing if the rota page swallows it.
- **Writing that test found a defect in the screen it was written against.**
  The doctor list is paged, so a doctor created seconds earlier was not
  selectable at all. It gained a search — and a guard so that narrowing the
  search past the current selection disables the button rather than assigning
  the shift to someone the administrator can no longer see.
- **Scenarios 1 and 2 now run through the screens**: 2 proves a failed payment
  leaves the consultation recoverable rather than dead, and 1 joins the
  counter, the patient's phone at 390×844, the clinical workspace and the
  completion screen carrying the D24 reference, across three browser contexts.
- **Scenario 15 stays pending, with an accurate reason for the first time.**
  Its note claimed it needed Phase 7 payment; Phase 7 shipped three phases
  earlier. The real obstacle is that suspension happens in an hourly job with
  no trigger route, and this suite drives a real server over HTTP so it cannot
  move the clock. Adding a "run maintenance now" endpoint that exists only for
  a test would be inventing product surface to make a test pass. It is covered
  with an injected clock in `membership.test.ts`.
- **The stale queue was cleared, through the state machine rather than with
  a DELETE.** 133 demo consultations stranded in `WAITING_FOR_DOCTOR` and
  `REASSIGNING` were moved to `ABANDONED` by `close-stale-demo-queue.ts`. 131
  of them carried a successful payment with revenue allocations behind it, so
  deleting them would have taken the money records too and left the demo
  analytics describing a world that never existed. Every move goes through
  `transition()`, so illegal moves are refused, state events are written and
  the sweep appears in the audit log; `REASSIGNING` has no legal edge to a
  terminal state, so those took two real steps rather than one convenient
  fiction. Verified afterwards: 0 stranded, 438 consultations still present,
  421 successful payments still present, no negative capacity.

  It also surfaced a second and larger pile: **208 consultations stuck in
  `IN_PROGRESS` and `DOCTOR_ACCEPTED`**, each pinning a doctor at capacity.
  Only a doctor completes a consultation (spec §15, §16) and there is
  deliberately no job that does, so in a demo database they never end. Not a
  defect — the design meeting five days of abandoned runs — but the other half
  of why the queue was hard to exercise, and closing them took doctors at
  capacity from **206 to 0**.

  Closing them also **sealed 208 clinical records that had been sitting
  unsealed**, because every terminal transition seals and schedules
  destruction (D23). 341 retention jobs now exist that should have existed all
  along. That is the more interesting consequence: an unfinished consultation
  was not only holding a doctor, it was holding a clinical record outside the
  retention machinery entirely.

  The script now guards on `updatedAt` rather than `createdAt` and leaves
  anything touched in the last fifteen minutes alone — a long consultation is
  old and busy at the same time, and a sweep that ended a live call would be a
  far worse bug than the one it was cleaning up.

- **A queue-testing obstacle worth writing down.** Scenario 1 first completed
  somebody else's consultation and then waited for a patient who never heard
  anything. The development database holds 124 stale queued consultations
  (99 `REASSIGNING`, 25 `WAITING_FOR_DOCTOR`, the oldest five days old, all
  demo rows), and because **a doctor cannot decline an offer** (spec §30), a
  doctor coming online is committed to whichever one `process-waiting-queue`
  hands them. 97 of the 124 are English, so no language isolates a test
  either. Scenario 1 therefore routes and accepts over the API and says why;
  being shown an undeclinable offer is what queue.spec.ts scenario 4 covers,
  through the screen, with the countdown.

- **Pagination and the indexes the request path depends on** are asserted in
  `performance.test.ts`, against `information_schema` rather than by timing —
  a timing test on a small database passes whatever the plan is, and would
  then go on passing with the index dropped.

Two carried-forward items from earlier phases were checked and closed here.
The rate limiter already keys by principal and falls back to IP
(`app.ts:100`), so the note about it keying only by IP was stale. The
`Feedback.comment` plaintext concern was real and is the encryption work above.

One thing worth stating plainly: **the four §102 demonstrations are my
grouping, not a quotation.** The master specification's §102 list is not in
this repository — only references to it are. The four boundaries above are
what every `§102` code comment in the codebase points at, and they are named
as such in `security.md` §8 so that the inference is visible rather than
buried.

---

## Phase 11 — Demo readiness

Seeded demo environment clearly marked DEMO and isolated from production config · demo admin, pharmacies, doctors, consultations, payments, prescriptions, referrals, feedback, analytics · UI polish across empty, loading, error, and success states · accessibility pass · complete README and setup instructions · a written demonstration script covering pharmacy → patient → doctor → prescription → admin.

**Exit:** you can run the full business cycle end to end on this machine from a clean checkout.

**Met, and executed rather than reasoned about.** The MySQL volume was
destroyed, the repository cloned to a scratch directory, and the README
followed literally. `npm run setup` completed, both schemas migrated, the
audit grants applied, and the seed produced its history and today's shifts.
The end-to-end suite then ran against that checkout: **48 passed, 1 skipped**
(scenario 15's documented `fixme`), **0 failed**, with no `P2034` anywhere in
the API log.

Getting there took four fixes, because the first three attempts did not work
— `setup` aborted on an un-migrated test database, the suite could not
authenticate against the shipped rate limits, and the queue lost offers to a
deadlock. Each is described below. None of them would have been found by
reading the instructions.

- **Running the suites found three tests that had been passing for the wrong
  reason.** The demo seed left one consultation `WAITING_FOR_DOCTOR` so the
  queue screen would not be empty; because a doctor cannot decline (spec §30),
  that single row committed every test doctor to somebody else's consultation
  and nine tests skipped. Removing it was necessary and not sufficient.

  The real defect was older and larger: **each test left its doctor online**,
  so the next test's `reallocate` offered its consultation to a previous
  test's idle doctor. That had been latent for the whole build, masked by a
  leak — before Phase 10, every test left its doctor pinned to a consultation
  that never completed, so the next test's doctor was the only free
  candidate. Cleaning up the stuck consultations removed the accidental
  isolation and exposed it. `goOnlineExclusively` now takes every other
  fixture doctor offline before bringing one online, because a test asserting
  "this doctor receives the offer" has to be the only candidate.

  Then two selector failures, both instructive. Scenario 1 clicked the sex
  button by the name "F" — which the accessibility fix in this same phase
  renamed to "Female". The right kind of breakage: the test was selecting by a
  label that should not have existed. And Scenario 16 asserted a refund's
  decision note on a screen that defaults to "awaiting a decision", so it was
  catching the card in the instant between the mutation settling and the list
  refetching it away. Seeding a second refund changed the timing and the race
  started losing, which is the only reason anyone looked.

  Final: **E2E 48 passed, 1 skipped** (scenario 15's documented `fixme`).

- **A written demonstration script** (`docs/demonstration.md`) walks the full
  cycle in fifteen minutes, with a five-minute cut. It names what to point at
  rather than only what to click — the absent decline button, the URL carrying
  no patient data, the verification page that confirms a prescription without
  disclosing it — and ends with a table of things that look like bugs and are
  not, because a demonstration where the presenter is surprised is worse than
  one that is shorter.

- **The accessibility pass found one real class of defect.** The patient
  portal chose sex, language and consultation mode with buttons that showed
  selection **through colour alone**: no `aria-pressed`, and the sex buttons
  read "F" and "M" to a screen reader. The doctor's workspace already used
  `aria-pressed`; the patient portal — the one interface used by someone who
  did not choose this software, on their own phone — did not. Fixed and
  verified in a browser: the buttons now announce "Female", and the pressed
  state flips in the accessibility tree.

  The rest of the pass came back clean, and two things I suspected were
  defects were not: every form control has a real label (a tool that does not
  print names for textboxes made it look otherwise), and every image has alt
  text (a grep that could not see across lines made it look otherwise).

- **Shift patterns can be turned on and off.** Night cover ships inactive —
  24-hour operation is a business decision — and `PATCH
/admin/shifts/definitions/:code` had existed since Phase 2 with no caller, so
  the decision could only be made in the database. Found while writing the
  demonstration script, whose 40-hour walkthrough could not be performed as
  written.

- **One empty state was missing**, on the scheduling screen built in Phase 10:
  a search matching nobody left a select holding its placeholder, which reads
  as "there are no doctors" rather than "your search found none".

- **The demo history is produced, not fabricated.** The Phase 1 seed created
  accounts and stopped, with a note saying why: "seeding a prescription before
  the prescription engine exists would be fabricating data the system cannot
  yet produce." Those engines exist now, so `demo-consultations.ts` **drives
  them** — `createConsultation`, `initiatePayment`, `exchangeAccessToken`,
  `saveClinicalNotes`, `issuePrescription`, `completeConsultation`,
  `submitFeedback` — rather than inserting rows. The result carries the state
  events, audit entries, revenue allocations, sealed records and retention
  jobs a real consultation carries, so the analytics, payouts and audit log
  describe something that actually happened.

  From an empty database: 15 consultations (12 completed, one unpaid at the
  counter, one waiting for a doctor, one refunded), 9 prescriptions across
  ACTIVE, DISPENSED, REVOKED and PENDING_SUBSTITUTION, 8 pieces of feedback
  including one complaint, 14 payments with 14 matching revenue rows, 106
  audit entries and 158 state events. The admin dashboard reads 85.7%
  completion, GHS 560.00 gross, a mean doctor rating of 4.375 and an outcome
  mix of 9 prescriptions to 3 advice-only.

  **Nothing is left stuck**: 0 doctors at capacity, 13 sealed records with 13
  matching retention jobs. A demo database full of consultations that can
  never end is what Phase 10 spent an afternoon clearing.

  **The engines refused the seed twice, which is the point of writing it this
  way.** Completing an advice-only consultation without a summary was rejected
  by D25, and revoking a prescription as the wrong doctor was rejected as a
  404 by the §102 ownership check. Row inserts would have accepted both and
  produced a demonstration that contradicted the product.

- **The README described a different product.** It said Phase 1 was in
  progress and phases 2–11 were unbuilt; it told the reader that clinical
  notes, diagnosis, vitals and test results are **hard-deleted the moment the
  doctor completes**. That has been false since D23, which established that
  deletion was never lawful and replaced it with sealing. A README is the one
  document a stranger reads first, and this one made a promise about patient
  data that the system deliberately does not keep. Rewritten against what the
  code does, with the retention position stated as it actually is.

  Other corrections in the same pass: the web URL was wrong (3000, not 8080),
  shadcn/ui was still listed in the stack after Phase 10 deleted it, the
  integrations table said Paystack and the notification providers were future
  work, and mock mode was said to be reported by `/health/ready` — which Phase
  10 narrowed precisely so it would not be.

- **Adminer and the web server both defaulted to port 8080.** The README told
  the reader to start Adminer while developing, which could not work. Adminer
  moved to 8081.

- **`.env.example` claimed to document every variable and documented all but
  two.** `PAYSTACK_TIMEOUT_MS` and `PAYSTACK_RECEIPT_DOMAIN` have defaults, so
  nothing was broken — but the file makes a completeness claim, and a
  completeness claim that is nearly true is worse than none. Checked
  programmatically against the zod schema: 58 variables, 0 undocumented.

- **Walking the demonstration script by hand is what found the next defect.**
  Reading it proves nothing; the queue stalled at step 3 because **no demo
  doctor had a shift**, and a doctor without one cannot be offered anything.
  The seed had built fourteen consultations through the real engines and left
  an environment that could not conduct a fifteenth. `seedDemoShifts` now puts
  both active doctors on today's morning and afternoon, confirmed —
  assignments only. Nobody is seeded **online**: presence is something a doctor
  does, and a seeded online doctor would be offered the end-to-end suite's
  consultations out from under it, which is the Phase 10 bug again from the
  other direction.

  Night cover stays off. Whether Neem runs at night is a business decision,
  not a seed's to make, and turning it on at Admin → Scheduling is a better
  thing to demonstrate than a shift that was already there.

  My first version credited the **pharmacy user** with each assignment, because
  that was the id already in scope. `assignedByAdminId` is written into the row
  and into the audit entry, so the seeded environment would have claimed a
  pharmacy assigned a doctor's shift — a thing the product does not permit. The
  demo administrator is threaded through instead.

- **`npm run setup` could fail on a clean machine, which is the exit criterion
  verbatim.** `docker compose up -d` returns when the container starts, not
  when MySQL is accepting connections — and the compose file gives MySQL a
  30-second start period. On a first run, where there is no initialised data
  directory, `db:migrate` raced it. The healthcheck was already there and
  nothing waited on it; `--wait` does.

- **Four of twenty-one notifications are actually sent.** Checking the job
  table against the scheduler led to a setting with no reader, which led to a
  template with no sender, which led to counting them: `notify()` is called
  from four places, and the other seventeen templates have a subject, a body,
  channels, a variable list and an admin screen to reword them on, and nothing
  anywhere that sends them.

  Nothing is unsafe, which is why it survived three phases — every rule that
  matters is enforced server-side at the point of use, so a revoked
  prescription is still refused at the counter and an expired licence still
  blocks a prescription. What is lost is that people are not told. An approved
  doctor discovers it by signing in and looking. A pharmacy blocked on a
  substitution decision has to keep checking for the answer, because the
  doctor is told there is a question and the pharmacy is never told the reply.

  **Wiring seventeen producers is a phase, not a Phase 11 item**, so I have
  not done it. What I have done is make it impossible to lose again:
  `TEMPLATES_WITHOUT_PRODUCER` names all seventeen, the admin screen marks
  them "not sent yet" and says in a sentence that wording them changes nothing
  today, and `notification-producers.test.ts` checks the set against the real
  source in both directions — an unlisted silent template fails, and a listed
  one fails once something sends it. The register cannot overstate or
  understate the debt.

  The test caught me while I was writing it: I had listed
  `doctor.substitution.requested` as unwired and it is one of the four.

- **`docs/security.md` still carried the pre-D23 deletion promise**, in §5,
  the paragraph a security reviewer reads first: "Nobody but the doctor sees
  clinical notes, and those are deleted at completion." The README pass
  earlier in this phase corrected exactly this sentence in the README and
  stopped there. It was also in `database.md` ("Hard-deleted the instant the
  doctor completes"), in `consultation-flow.md` (the completion transaction
  "purging temporary data", and a retention table whose only column was "fate
  at completion"), and in `architecture.md`. Corrected in all four, each
  noting what the sentence used to say, because a document that silently
  changes its mind about patient data teaches the reader nothing.

- **`architecture.md`'s job table listed three jobs that do not exist** —
  `purge-temporary-data`, `check-licence-expiry`, `check-subscription-expiry`
  — and omitted five that do. Rewritten from the scheduler. `check-licence-expiry`
  was the thread that led to the notification finding above.

- **`npm run db:grants` did not exist.** `docker/mysql-init` tells the reader
  that the append-only audit account's grants are "applied by `npm run
db:grants`", and there was no such script; the `.sql` file it named sat
  unreferenced. So on any installation following this repository's own
  instructions, `neem_audit` existed with no privileges at all. The script now
  exists, runs as part of `setup`, and derives the database and account names
  from the environment rather than hard-coding them, so an installation that
  renamed its schema still grants against the right one. Verified rather than
  asserted: the account is refused `DELETE` on `audit_logs` and refused
  `SELECT` on `patient_sessions`.

  **And the docs overstated what it buys.** `security.md` §6 and `database.md`
  both said the append-only guarantee rests on that account. It does not —
  nothing connects as it. Audit rows are written on the same connection and
  inside the same transaction as the business change they record, which is the
  better property and the reason a second connection cannot be used, so the
  guarantee in the running system rests on the service surface: no update or
  delete method, no route, asserted by test. Both documents now say that, and
  a new `security.md` §10 lists the controls that are a deployment's
  obligation rather than the code's — narrowing the application account,
  TLS, encryption at rest, key rotation — so that reading §1–§9 does not leave
  the impression they are already in force.

- **The clean-checkout test found a real defect in the queue, which is the
  point of running it rather than reasoning about it.** A deadlock:
  `offerNextDoctor` writes four rows across three tables, and the ten-second
  `process-waiting-queue` sweep can be offering the same consultation as an
  administrator's manual reallocation. InnoDB breaks the tie by rolling one
  transaction back with `P2034`, whose own message ends "Please retry your
  transaction". **Nothing retried.** The offer was lost — a paid patient
  waiting in the queue was offered to nobody — and on the request path
  `POST /admin/queue/:publicId/reallocate` returned an unhandled 500.

  That contradicts the rule the queue is built around: patients are never
  abandoned (`consultation-flow.md` §4). `withWriteConflictRetry` now retries a
  rolled-back transaction three times with jittered backoff — jittered because
  two transactions that deadlock and retry in lockstep deadlock again — and
  still throws when the attempts are spent, because a bounded retry makes a
  lost offer unlikely rather than impossible and pretending otherwise would be
  the same mistake in a new place.

  **It had been invisible because the end-to-end suite skipped on it.** The
  helpers that bring a consultation live treated anything that was not an
  offer as a reason to skip — including a 500. So an unhandled deadlock
  presented as four quietly skipped tests, and a run reporting "44 passed, 5
  skipped" looked like a run reporting no failures. Both helpers now check the
  status first: "nobody was eligible" is a legitimate state of the world, "the
  server fell over" is not, and a suite that renders them identically is worse
  than one that has no such helper.

- **`npm run setup` had never been run on a clean machine, and did not work.**
  Two faults, both of which only exist on the first run. `neem_test` is created
  empty by `docker/mysql-init` and nothing filled it, so `npm test` met a
  schema with no tables — while the README said it runs against `neem_test`.
  It worked here because this machine's test database had been migrated by
  hand months earlier, which is the definition of a setup step that does not
  exist. And `db:grants` then aborted the whole chain on the missing table, so
  `setup` never reached the seed. `db:migrate:test` is new; granting now
  reports a not-yet-migrated schema and carries on rather than failing.

- **Every "48 passed" on this machine depended on an undocumented `.env`
  edit.** A clean checkout could not run the end-to-end suite at all: the
  values in `.env.example` are production-shaped, and the suite signs in as
  several roles dozens of times from one address, so it is refused with 429
  part-way through and everything after that fails for an unrelated reason.
  My own `.env` has `RATE_LIMIT_AUTH_MAX=500` against the shipped `10`, raised
  at some point and never written down.

  The design was already right — production refuses loose limits, and
  `env.ts` has held those ceilings since Phase 10 — but `.env.example` is
  doing two jobs, as the deployment template and as the file the README tells
  you to copy. It now carries the four development values in a commented
  block, with the safe numbers still the ones that ship, and `signIn` in the
  fixtures recognises a 429 and says which block to read instead of failing
  twenty tests silently.

- **The seventeen silent notifications are wired.** Every event they hang off
  already existed; each needed the line that sends. Two needed more: the MDC
  licence warning had a threshold in settings, a query, an audit action and a
  written message, and no job to run any of it — `warn-expiring-licences` is
  new, daily, and deduplicated over half the warning window so one licence
  produces roughly two warnings rather than sixty. The membership warning
  needed a threshold of its own, so `doctor.membershipExpiryWarningDays` is a
  new setting rather than a number in the code.

  `notifyOnce` is the piece that made the periodic ones safe to send at all.
  Three of the seventeen are raised by a job rather than an event, and each
  condition stays true for weeks — a licence expiring, a membership expiring,
  a destruction overdue. Without a window the job that notices would send the
  same message on every run, and a doctor warned sixty times about one licence
  learns to ignore the sender, which costs more than the warning was worth.
  Event-driven producers deliberately do not use it: they fire once because
  the event happens once, and a window there would silently drop the second of
  two legitimate messages.

  **A source scan could not have finished this job.** The producers test greps
  for call sites, so it proves a producer exists and nothing about whether it
  works — and the likeliest defect is a producer passing `reference` where the
  template declares `consultationReference`. `render` throws on a variable it
  was not given, `notify` catches it, the row is written FAILED, and the
  prescription is issued exactly as intended. Nothing goes red. So
  `notification-delivery.test.ts` drives the real services and asserts the row
  that came out — right template, right recipient, **never FAILED**.

  Two of those twelve tests failed on first run, and both faults were in my
  test rather than the product: `settled()` returned as soon as the rows it
  had seen were terminal, which is before the SMS row has been created at all,
  so an assertion about what was actually sent read an empty outbox. It now
  waits for the channel count the catalogue declares.

  `TEMPLATES_WITHOUT_PRODUCER` became a map from code to consequence rather
  than a list of codes. It is empty, and it stays because it is what keeps the
  gap from reopening — but a map means declaring a future gap requires writing
  who does not learn what. A code on its own is a to-do; a consequence is
  something a reviewer can weigh.

- **The substitution test's intermittent skip, and what I could not prove.**
  It skipped once, in the run that also failed Scenario 1, and I could not
  reproduce it afterwards. Worth recording how that went, because the first
  explanation was wrong and only a counterfactual showed it.

  My hypothesis was that Playwright tears the worker down after a failure,
  which would empty the in-memory list of online doctors while those doctors
  were still online in the database — a bug that only appears once something
  else has already gone wrong, which is the most misleading shape available. I
  reproduced the condition with a deliberately failing probe test placed early
  in the alphabet, and the skip did not appear. **Then I ran the same probe
  with the fix reverted, and it did not appear either.** The hypothesis was
  wrong, and one run in its favour would have looked like proof.

  What did change: the accept now waits for the offer rather than assuming it
  exists the instant reallocation returns. The offer is written asynchronously
  by whichever of the reallocation and the ten-second sweep gets there first,
  and neither has necessarily finished — the identical assumption that made
  Scenario 1 fail. That is a real defect in the test whether or not it was
  this particular skip's cause.

  The online-doctor registry is also on disk now rather than in a module
  variable. That is defensible on its own — doctors left online by a
  **previous** run were invisible to a list that starts empty, and were only
  ever cleaned up by the 90-second presence reaper happening to run between
  suites — but I am not claiming it as the fix, because I never reproduced
  what it would be fixing.

  And all three skip sites in `clinical.spec.ts` now print their reason. That
  file's other seven tests always did; these three did not, which is why the
  original skip told me nothing. Four full runs since, including two back to
  back with no pause for the reaper, show no recurrence — **which is evidence,
  not proof, and is stated that way deliberately.**

- **One claim I wrote and had to correct before committing.** The new
  integrations table said the Twilio video and voice adapters were built. They
  are not: selecting `twilio` throws at boot saying so. The table now says
  interface-and-mock, and notes that a demonstration therefore runs on
  simulated media — which the screens already state.
