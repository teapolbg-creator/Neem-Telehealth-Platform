# Neem V2 — patient-direct consultations and the weight-loss clinic

**Status: proposal. Nothing in §5–§9 is built.** 2026-09-17.

Every claim under "Verified" was read from the code at the path given, not from documentation or
memory. Everything under "Proposed" is a design that has not been implemented and, where marked,
depends on a business decision that has not been made.

---

## 1. Scope

V2 lets a patient anywhere book and pay for a consultation themselves, with no pharmacy initiating or
mediating it, and adds a weight-loss clinic offering doctors, dietitians and personal trainers as
separately bookable professionals.

V2 does **not** handle medication inventory, dispensing, delivery or pharmacy logistics. A patient
takes their prescription to a pharmacy of their choosing, outside the platform.

The pharmacy-counter service and its records stay exactly as they are until their retirement is
authorised separately. No pharmacy participates in the v2 journey.

---

## 2. What exists today (verified)

### Shape

- npm workspaces monorepo: `apps/api` (Fastify 5, Prisma, PostgreSQL), `apps/web` (TanStack Start),
  `packages/contracts` (zod schemas, permissions).
- 60 models and 31 enums in `apps/api/prisma/schema.prisma`, on a single migration
  (`20260910120348_init_postgres`). Migrations run with `prisma migrate dev` locally and
  `prisma migrate deploy` in `render.yaml`'s pre-deploy step.
- Tests: 28 API integration suites, 22 unit suites, 11 Playwright specs.
  `apps/api/tests/integration/docs-drift.test.ts` compares the live router against `docs/api.md`, so
  **every new route must be documented or the suite fails**.

### The consultation is owned by a pharmacy

- `Consultation.pharmacyId` is a required column (`schema.prisma:796`). So is
  `Prescription.pharmacyId` (`:1065`), `Referral.pharmacyId` (`:1186`) and
  `ConsultationSummary.pharmacyId` (`:1659`).
- 20 modules under `apps/api/src/modules` read `pharmacyId`, including queue allocation, payments,
  payouts, refunds, documents, notifications, analytics and realtime.
- A consultation begins at the counter: the pharmacy creates it, takes payment, and the patient
  exchanges a one-time QR token for a device-bound session
  (`modules/consultation/pharmacy-consultation.routes.ts`, `access-token.service.ts`).

### Professionals

- One professional type exists: `Doctor`, with `mdcNumber` required and unique, credential documents,
  signature, languages, quality scores, and a status machine (PENDING → … → ACTIVE).
- `UserRole` is `ADMIN | DOCTOR | PHARMACY` (`schema.prisma:51`). Permissions are granted per role in
  `packages/contracts/src/permissions.ts` (`ROLE_PERMISSIONS`), and prescribing is the permission
  `prescription:create`, held by DOCTOR.
- Availability is shift-level, not slot-level: three `ShiftDefinition` rows (MORNING 08:00–14:00,
  AFTERNOON 14:00–20:00, NIGHT 20:00–08:00 UTC), `DoctorShiftAssignment` per day with a doctor's
  confirmation, and a weekly hours ceiling in `DoctorServiceHours`. **There is no appointment or slot
  model anywhere in the schema.**
- Routing is a live queue: `collectCandidates` and `checkEligibility`
  (`domain/queue-scoring.ts`) gate on active status, membership, licence, confirmed shift, presence
  (a heartbeat within 90s), language and capacity, then score and offer with a response window.

### Money

- The patient pays Neem through Paystack. `RevenueAllocation` records one split per payment, storing
  `pharmacySharePctBp` as a snapshot, and is reversed rather than deleted on refund.
- Payouts exist **only for pharmacies**: `PharmacyPayout`, `PharmacyPayoutDetail`,
  `payout.service.ts` sums unreversed allocations per pharmacy and an admin marks them paid.
- Professionals are salaried, not revenue-shared: `Doctor.employmentType`,
  `contractedHoursPerWeek`, `monthlySalaryMinor`, `domain/compensation.ts`
  (`computeMonthlyCompensation`) and `/admin/payroll` by ISO week. `/doctor/earnings` reports that
  salary position. **No per-consultation professional earning, and no professional payout table,
  exists.**
- The Paystack adapter implements `initialize`, `verify`, `refund` and webhook parsing only
  (`adapters/payment/paystack-payment.provider.ts`). **There is no subaccount, split or transfer
  support**, so "let Paystack split the money" is new adapter work, not configuration.
- Settlement was hardened in D49: `abandoned` is not final, the expiry sweep verifies with the
  provider first, and a payment confirmed after a consultation closes raises a refund request.

### The patient

- `PatientSession` is per consultation, device-bound by a cookie, and holds an encrypted name and
  phone. **There is no patient account, and no patient email field anywhere.**
- Patient notifications resolve a phone number only; `EMAIL` returns `null`
  (`notification.service.ts:117`). With SMS switched off for the pilot (D46), **patients currently
  receive no notifications at all**.
- Documents (prescription, referral, summary) carry verification codes and PDFs, and a patient can
  list and download their own through `/patient/documents` while their session resolves.
- The clinical record is sealed when a consultation reaches a terminal state and later purged by
  retention jobs (`modules/retention/clinical-record.service.ts`). Documents are separate from the
  sealed notes.
- `Consent` and `DisclosureLog` models exist in the schema. Their use by application code was not
  verified in this pass.

### Infrastructure

- API on Render (`render.yaml`, one always-on service, disk at `/var/data`, migrations in
  pre-deploy), web on Netlify (`netlify.toml`, Nitro netlify preset), database on Supabase
  (transaction pooler for runtime, session pooler for migrations).
- Cookies: session cookie httpOnly and host-only; CSRF cookie shared across `neemtelehealth.com`
  (D47). Any second environment needs its own cookie domain and origins.

---

## 3. Reuse, change, build (proposed)

| Area                                                          | V2                            | Why                                                          |
| ------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------ |
| Queue, eligibility, offers, response window, wait limit       | Reuse unchanged               | A v2 consultation is just another consultation in the queue  |
| Video, timer, media sessions                                  | Reuse unchanged               | Patient already joins by session cookie                      |
| Clinical notes, sealing, retention, audit                     | Reuse unchanged               | Same obligations                                             |
| Prescriptions, referrals, summaries, PDFs, verification       | Reuse, pharmacy made optional | Documents must exist without a pharmacy                      |
| Paystack initialise/verify/refund, settlement, reconciliation | Reuse unchanged               | Already hardened                                             |
| Settings, feature switches, audit, notifications plumbing     | Reuse                         | New keys only                                                |
| Consultation ownership                                        | **Change**                    | Channel added; pharmacy optional on 4 tables                 |
| Professional model                                            | **Change**                    | Discipline added; credentials generalised; prescribing gated |
| Patient identity                                              | **Build**                     | Accounts with verified contact                               |
| Appointments and availability                                 | **Build**                     | No slot model exists                                         |
| Professional earnings and payouts                             | **Build**                     | Only pharmacy payouts exist                                  |
| Patient-facing booking interface                              | **Build**                     | Only the consultation screen exists                          |

---

## 4. Journeys (proposed)

### Patient — immediate consultation

1. Chooses a service (general consultation, or a weight-loss clinic service) and sees its price and
   whether a suitable professional is available now.
2. Emergency screening. Red flags end the journey with guidance, before any payment.
3. Minimum details: name, age, sex, contact, language, reason for visit; service-specific intake;
   consent recorded against the consultation.
4. Pays through Paystack. Payment is verified server-side; nothing is queued until it is.
5. Enters the existing queue, restricted to professionals qualified for that service, and sees
   waiting, connecting and in-consultation states.
6. If no professional is found within the wait limit, the consultation is cancelled and a refund
   request raised automatically (the D50 mechanism, reused).
7. If the patient disconnects, the consultation stays open and they rejoin from their account; the
   professional decides when it ends.

### Patient — scheduled consultation

1. Chooses service, then a professional or the first suitable one, then a date and time from
   published availability.
2. The slot is reserved for a short, configurable window while payment is attempted.
3. On verified payment, the appointment is confirmed; on expiry, the slot is released, and a payment
   arriving after expiry is refunded automatically rather than silently kept.
4. Double booking is prevented by a unique constraint on professional and start time, not by
   application checks alone.
5. Confirmation and reminders; a secure link back into the account to join.
6. Cancellation, rescheduling, refund and no-show rules are configured, not implicit.

### Professional

Applies, uploads credentials, is verified by an administrator, sets services and availability, works
the queue or scheduled appointments, issues role-appropriate outputs, and sees consultation history
and earnings.

### Administrator

Verifies credentials by discipline, configures services, prices and splits, watches the queue,
reconciles payments against earnings, approves refunds, and runs payouts.

---

## 5. Data model and migrations (proposed)

Five additive migrations. No column is renamed or dropped, so each is reversible by deploying the
previous build.

**M1 — pharmacy-independent consultations.** `ConsultationChannel` enum (`COUNTER`, `DIRECT`);
`Consultation.channel` (default `COUNTER`); `Consultation.pharmacyId`, `Prescription.pharmacyId`,
`Referral.pharmacyId` and `ConsultationSummary.pharmacyId` made nullable. Existing rows are
unaffected and remain `COUNTER` with their pharmacy.

**M2 — services and pricing.** `Service` (code, name, discipline, clinic, price, currency, duration,
active) and `Consultation.serviceId`. Price continues to be snapshotted on the consultation as it is
today.

**M3 — professionals.** `Discipline` enum (`DOCTOR`, `DIETITIAN`, `TRAINER`); `Doctor.discipline`
(default `DOCTOR`); `mdcNumber` made nullable with credential type and number columns for other
disciplines; `ProfessionalService` linking a professional to the services they may take.

> **Built, phase 5.** One deviation, recorded here rather than left to be discovered: the queue
> narrows candidates by **discipline** only. `ProfessionalService` is written and administered, but
> is not yet an eligibility condition — every professional already on the platform has no roster
> row, so enforcing it now would empty the pool. Phase 8 turns it on with the clinic it was built
> for. A non-doctor's registration is recorded in `credentialType`/`credentialNumber` and printed
> on documents in place of an MDC number, which is now nullable.

**M4 — patient accounts and appointments.** `PatientAccount` (verified phone or email, encrypted),
`PatientAuthToken` (one-time codes), `Consultation.patientAccountId`;
`ProfessionalAvailability` (recurring windows per professional) and `Appointment`
(professional, service, start, end, state, reservation expiry, payment), with a unique constraint on
professional and start time.

> **Built, phase 6.** Three decisions worth recording. A slot is held by a unique `slotKey` that is
> nulled when the appointment stops holding it, so the database refuses a double booking rather than
> a check-then-write. Reservation expiry rides on the existing payment window and its sweep, so a
> payment that lands late is verified and honoured exactly as D49 already provides. And a booked
> appointment counts as the professional's duty for that minute — requiring a rota shift as well
> would let a consultation booked a week earlier go to nobody; presence is still required, and the
> wait limit still protects the patient if they do not appear.
>
> **Not built:** cancellation, rescheduling and no-show handling, which depend on business decision
> §7.7. There is deliberately no route by which an appointment can be cancelled until that is
> answered, because the refund rule is the decision.

**M5 — earnings and payouts.** `ProfessionalEarning` (one per consultation: gross, split basis
points snapshot, professional share, Neem share, reversal), `ProfessionalPayout` and
`ProfessionalPayoutDetail` mirroring the pharmacy payout tables, and `ProfessionalPayoutDetail`
bank/mobile-money details encrypted as the pharmacy's are.

Per-consultation earnings are written beside the existing `RevenueAllocation`, so patient payment,
earned revenue and actual payout stay three separate records.

> **Built, phase 7, and inert.** Four things worth recording.
>
> **Earnings are written at completion, not at settlement** — the plan said settlement, which is
> wrong: when the money clears, an immediate consultation has no professional yet. Whoever completed
> it is who earned it.
>
> **Nothing is recorded until the split is agreed.** `revenue.professionalEarningsEnabled` is off and
> `revenue.professionalSharePctBp` is 0, and the settings service refuses to switch the first on
> while the second is unset. No number has been invented anywhere in the code.
>
> **Counter consultations earn nothing.** They are worked by salaried doctors and paid through
> payroll; recording a share as well would pay for the same hour twice. Whether that should change is
> §7.6 below and is not assumed here.
>
> **Fees come off before the split**, per the operator's answer of 2026-09-17. That needed the work
> this plan flagged as missing: `VerifiedPayment` now carries `feeMinor`, the Paystack adapter reads
> `fees` from the verify response, `Payment.feeMinor` records it, and each earning stores the fee and
> the net it was actually split on. A payment the provider reported no fee for is split on the gross
> and says `feeMinor: 0`, which the reconciliation shows rather than hiding.
>
> **Answers recorded (2026-09-17):** 50% to the professional, of the amount after provider fees;
> monthly manual transfer, as pharmacies are paid today. The share is now the seeded default; the
> switch that makes any of it happen is still off, because agreeing a rate and running it in
> production are two decisions and only the first has been made.

---

## 6. Phased implementation (proposed)

Each phase ships behind a switch, leaves the counter service untouched, and is verified by the
existing suites plus the new tests named.

| Phase | Work                                                          | Acceptance                                                                          | Tests                                                                                                       |
| ----- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 0     | Staging environment; feature switches added, default off      | Staging API, database and site reachable; production unchanged                      | Existing suites green against staging                                                                       |
| 1     | M1 migration and the `pharmacyId` ripple                      | Counter journey identical; a consultation can exist with no pharmacy                | All current suites green; new: counter consultation unchanged, direct consultation created without pharmacy |
| 2     | M2, service catalogue, prices (GHS 50 / GHS 100) as settings  | Price shown before payment comes from the service, snapshotted per consultation     | Service pricing, snapshot survives a later price change                                                     |
| 3     | M4 patient accounts, verified contact, document access        | A patient returns days later and sees only their own documents                      | Access control: another patient's documents refused; sealed notes never exposed                             |
| 4     | Immediate consultation: intake, consent, payment, queue entry | Paid patients reach the queue; unpaid never do; no professional → refund request    | Payment-gated queue entry, wait-limit refund, disconnect and rejoin                                         |
| 5     | M3 disciplines, role-appropriate outputs                      | A dietitian or trainer cannot issue a prescription, by permission and by discipline | Permission matrix per discipline; prescribing refused for non-doctors at the route and service              |
| 6     | M4 availability and scheduled appointments                    | No double booking; reservations expire; late payment refunded                       | Concurrent booking of one slot; expiry; payment after expiry                                                |
| 7     | M5 earnings and payouts                                       | Earnings recorded per completed consultation with split snapshot; payouts reconcile | Split arithmetic, refund reversal, duplicate-payout protection, statement totals                            |
| 8     | Weight-loss clinic packaging                                  | Three disciplines bookable separately under one clinic                              | Booking each discipline; clinic pricing                                                                     |

Phases 7 and 8 depend on decisions in §7 and must not be enabled in production until those are
answered.

---

## 7. Business decisions needed

1. ~~**Revenue split.**~~ **Answered 2026-09-17: 50%** to the professional, one rate for all three
   disciplines. Seeded as `revenue.professionalSharePctBp = 5000`.
2. ~~**Payment fees.**~~ **Answered 2026-09-17: deducted before the split.** Built — see the note
   under M5 above.
3. ~~**Payout schedule and method.**~~ **Answered 2026-09-17: monthly, manual transfer**, the same
   arrangement as pharmacy payouts. No Paystack transfer integration is needed or built.
4. **Prices.** Confirm GHS 50 general and GHS 100 weight-loss as launch prices.
5. **Weight-loss commercial shape.** Separately bookable consultations, as assumed here, or a package
   or subscription? This changes phases 7 and 8 substantially.
6. **Existing doctors.** Do salaried doctors move to revenue share, and what happens to the
   membership fee in the v2 model?
7. **Cancellation, rescheduling, no-show.** Free-cancellation window, refund proportion, and what a
   no-show forfeits.
8. **Patient identity minimum.** Phone only, email only, or either.
9. **Credentials for dietitians and trainers.** Which registration or certification is required, and
   who verifies it.
10. **Capacity.** How immediate and scheduled demand share professionals, given the pilot's
    one-concurrent-call cap.

---

## 8. Questions for qualified review

These need a clinician and a Ghanaian regulatory adviser. They are not answered here, and previous
documentation is not evidence.

- Direct-to-patient telemedicine and remote prescribing without a pharmacy present: permitted form,
  record-keeping and prescription format.
- Whether weight-loss pharmacotherapy may be initiated remotely, what baseline measurements are
  required, and what monitoring obligations follow.
- Scope of practice and protected titles for dietitians and personal trainers, and what may be issued
  in their names.
- Emergency escalation duties when the patient is not at a pharmacy.
- Data protection registration and obligations for patient accounts holding contact details.
- Whether non-clinical professionals' records fall under the same retention rules as clinical ones.

---

## 9. Hosting, domains, staging (proposed)

Keep Netlify, Render and Supabase. Nothing in v2 needs different infrastructure; it needs a second
environment and, later, more capacity.

- **Production, unchanged:** `app.neemtelehealth.com` (Netlify), `api.neemtelehealth.com` (Render),
  Supabase for data.
- **Patient routes** live in the same web app: `/` for the public service list, `/book` for the two
  booking journeys, `/account` for returning patients. The pharmacy, doctor and admin portals keep
  their paths. A second domain is unnecessary and would complicate cookies.
- **Staging:** `staging-app.neemtelehealth.com` and `staging-api.neemtelehealth.com`, a second Render
  service, a separate Supabase project, Paystack **test** keys, email to a mock or a single internal
  address, SMS off. Its own CSRF cookie domain.
- **No production migration or deploy** happens without explicit authorisation.

---

## 10. Risks

- **The `pharmacyId` ripple is the riskiest change**, because it touches modules the live pilot
  depends on. It ships first, alone, with the counter journey proven unchanged.
- **Patients cannot currently be notified at all.** Scheduled appointments are not viable until
  patient contact and a working channel exist — email, since SMS is off.
- **One codebase deploys both services.** A bad deploy affects the pilot; staging and the existing
  suites are the mitigation.
- **Professionals are shared** between counter and direct demand, and the pilot runs one concurrent
  call. Without per-channel caps, one service starves the other.
- **Salary to revenue share is a contractual change**, not only a code change.
