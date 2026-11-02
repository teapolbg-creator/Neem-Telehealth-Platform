# Neem — Engineering Handover

**Document date:** 9 October 2026
**Repository:** `Neem-Telehealth-Platform`, branch `main`
**Commit inspected:** `3c06b2c` (local `main`; also `origin/staging`)
**Deployed at time of writing:** production API `803c0e7` · staging API `3c06b2c` — both read from `/api/v1/health`, which reports its own commit
**Audience:** a development team taking Neem over with no prior knowledge of it

---

## 0. How to read this document

Neem is small, live, and carries a lot of behaviour that exists because something went wrong once. Most of the non-obvious rules in the code are scar tissue, and the comments say so. This document tries to give you the scars along with the code, because without them the system looks over-engineered in places and under-built in others.

### Evidence standard

Statements here are marked where it matters:

| Mark           | Meaning                                                                                                                                |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Verified**   | I read it in the repository, queried the production or staging database read-only, or called a live endpoint during this investigation |
| **Reported**   | The product owner described it; I have not independently reproduced it                                                                 |
| **Inferred**   | A conclusion drawn from evidence, with the reasoning given so you can disagree                                                         |
| **Unverified** | Stated in the repository or by a person, not checked by me. Treat as a lead                                                            |

Two things this document deliberately does **not** do. It does not claim an incident is resolved because a test passes or a commit deployed — those are tracked as separate columns in §4. And it does not include any credential, connection string, token or patient data; §5 lists environment variable _names_ and how to obtain access.

### The most important thing to know first

**Production and staging are not running the same code.** Production is `803c0e7`. Staging is `3c06b2c`, which is three commits ahead and contains fixes for two of the problems described in §4. Any behaviour you reason about must be pinned to an environment. _(Verified: both `/health` endpoints, 9 Oct 2026.)_

---

## 1. Product and current scope

### What Neem is

Neem is a telemedicine platform for Ghana. A patient gets a consultation with a licensed professional — by video, by audio, or by a "Call Me" telephone bridge — in minutes rather than days, and leaves with whatever the consultation produced: a prescription, a referral, advice, or instructions.

It has two front doors, and the second was added later:

- **Pharmacy-mediated (the original, `COUNTER`).** A patient walks into a partner pharmacy. Counter staff create a consultation, take payment, and print a QR code. The patient scans it on their own phone, which exchanges the code for a short-lived device-bound session, and joins the call. The pharmacy takes a share of the fee.
- **Patient-direct (`DIRECT`, called **v2** throughout the code).** The patient books on their own phone with no pharmacy involved, either **immediately** (join a queue now) or **scheduled** (reserve a slot at a future time). They sign in with a phone number and a one-time code.

Both produce the same consultation record and run through the same queue, state machine and clinical flow. The channel is a field on the consultation, not a separate system.

### Who uses it

Four kinds of user, three of which have accounts. `UserRole` is `ADMIN | DOCTOR | PHARMACY`; patients never have one of these. _(Verified: `apps/api/prisma/schema.prisma`.)_

| Role                     | Authentication                                                                      | What they do                                                                               |
| ------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **Patient (counter)**    | No account. QR token exchanged for a device-bound `PatientSession`                  | Identity, language, call mode, then the consultation                                       |
| **Patient (direct, v2)** | `PatientAccount` + phone one-time code (`PatientAuthCode`, `PatientAccountSession`) | Browse services, book now or later, pay, attend, read their own documents                  |
| **Pharmacy**             | Email + password                                                                    | Create consultations, take payment, print the QR, see what is owed                         |
| **Professional**         | Email + password, 2FA optional                                                      | Go online, accept offers, run the consultation, write the clinical record, issue documents |
| **Admin**                | Email + password, **2FA required**                                                  | Verification, shift rota, refunds, payouts, settings, quality, audit                       |

_(Verified: 2FA is mandatory for `ADMIN` and otherwise opt-in — `auth.service.ts:127`.)_

### One discipline offered, three the data may contain

Neem offers **doctors only**. The dietitian and personal-trainer offerings, and the weight-loss clinic built for them, were **withdrawn on 13 October 2026** (D69). Nothing was deleted: the enum values `DIETITIAN` and `TRAINER` remain in Postgres, the three `WEIGHT_LOSS_*` services remain as rows with `isActive = false`, and `ProfessionalEarning.discipline` keeps its historical meaning. Withdrawal was a settings-and-surface change, so restoring it needs no migration.

The distinction the code now draws, in `packages/contracts/src/enums.ts`, is worth learning before reading anything downstream:

| Constant                           | Means                                  |
| ---------------------------------- | -------------------------------------- |
| `PROFESSIONAL_DISCIPLINES`         | what existing data may contain         |
| `OFFERED_PROFESSIONAL_DISCIPLINES` | what Neem offers today — `['DOCTOR']`  |
| `SERVICE_CLINICS`                  | what existing data may contain         |
| `OFFERED_SERVICE_CLINICS`          | what Neem offers today — `['GENERAL']` |

**Nothing was lost by withdrawing it.** A read-only query of production on 12 October found zero dietitian or trainer professionals, zero consultations against those services, zero open appointments, and zero roster rows. No patient had ever booked one.

Live production services:

| Clinic      | Discipline | Price        | Code                    | Active |
| ----------- | ---------- | ------------ | ----------------------- | ------ |
| GENERAL     | DOCTOR     | **GHS 1.00** | `GENERAL_CONSULTATION`  | yes    |
| WEIGHT_LOSS | DOCTOR     | GHS 100.00   | `WEIGHT_LOSS_DOCTOR`    | **no** |
| WEIGHT_LOSS | DIETITIAN  | GHS 100.00   | `WEIGHT_LOSS_DIETITIAN` | **no** |
| WEIGHT_LOSS | TRAINER    | GHS 100.00   | `WEIGHT_LOSS_TRAINER`   | **no** |

_(Verified: production `services` table, 13 Oct 2026, after the withdrawal script ran with `--apply`.)_

The GHS 100 figures on the deactivated rows are left as price history. They are unreachable — `book.index.tsx` lists only active services — and the earlier note about correcting them to GHS 1 is therefore moot.

The discipline plumbing that remains (`CandidatePool.discipline`, `clinicRoster()`, `assertMayIssue`) is correct, inert with one discipline, and deliberately kept.

### Pricing — current testing settings versus intended commercial pricing

This needs care, because the live configuration is deliberately not commercial and must not be "corrected".

| Setting                               | Code default  | **Live production value** | Status                                         |
| ------------------------------------- | ------------- | ------------------------- | ---------------------------------------------- |
| `consultation.priceMinor`             | 5000 (GHS 50) | **100 (GHS 1)**           | Intentional testing setting                    |
| `consultation.currency`               | `GHS`         | `GHS`                     | —                                              |
| `channels.directEnabled`              | `false`       | **`true`**                | Intentional — public booking is on for testing |
| `revenue.pharmacySharePctBp`          | 2000 (20%)    | **3000 (30%)**            | Operator decision                              |
| `revenue.neemSharePctBp`              | 8000 (80%)    | **7000 (70%)**            | Complements the above to 10000                 |
| `revenue.professionalEarningsEnabled` | `true`        | `true`                    | —                                              |
| `revenue.professionalSharePctBp`      | 5000 (50%)    | 5000 (50%)                | —                                              |
| `consultation.durationSeconds`        | 300 (5 min)   | 300                       | —                                              |

_(Verified: production `system_settings`, 9 Oct 2026.)_

#### None of these are commercial prices

**Every price currently in production is a testing value.** They exist to exercise the system end to end — payment, revenue split, earnings, refunds — with real money moving, because a payment flow that has only been tested with mocks has not been tested. A figure small enough to be inconsequential and large enough to be real is the point. **None of them is an agreed commercial price, and none should be read as one.**

**Pricing will be set progressively over the course of the pilot**, service by service, as the operator learns what each is worth. So expect these values to change, expect them to differ between services while that is happening, and do not treat any particular figure as settled or as a target to restore after an incident. The current value of a price is whatever the `services` table and `consultation.priceMinor` say today.

That is also why the price is a setting rather than a constant: the specification forbids hard-coding one, the code default of GHS 50 is only a seed for a brand-new environment, and the seed never overwrites a tuned value.

> **Resolved by withdrawal, not by correction.** The GHS 100 drift on the three weight-loss services was overtaken by D69: those services are now inactive and unbookable, so no patient can be charged GHS 100. The rows keep their prices as history. Nothing needs correcting.

> **The counter is free until roughly 14 January 2027** (D69, D71). `consultation.feeEnabled.counter` is `false` in production, so a consultation started at a pharmacy collects nothing, and `consultation.feeEnabled.direct` is `true`, so a patient booking on Neem themselves still pays GHS 1. Read §5 before touching either — in particular, **nothing resumes charging by itself**, and **a pharmacy's share of zero is zero, so participating pharmacies earn nothing per consultation for those three months.** That is a recorded commercial decision, not a bug in the payout figures.

The code default of GHS 50 is itself only a seed. The specification forbids hard-coding a price, so the figure lives in settings and a live environment's tuned value is never overwritten by the seed (see §5).

### Money: who gets what

Three separate mechanisms, and they are at different levels of automation. _(Verified: `payment/` module.)_

- **Payment in** — Paystack. The patient pays and a webhook confirms it; nothing is admitted to the queue on an unconfirmed payment. **The pharmacy counter collects nothing until around 14 January 2027** (D69): a waived consultation is given a zero-value `Payment` row with `isWaived = true`, `provider = 'none'` and `status = 'SUCCESS'`, and reaches `ACTIVATED` inside its own creation transaction. The row is structurally required — `RevenueAllocation.paymentId` and `ProfessionalEarning.paymentId` are both NOT NULL — and `SUCCESS` is honest, because the fee obligation really is settled. Reconciliation, the ABANDONED sweep and the refund provider call all skip `isWaived` rows.
- **Revenue allocation** — a `RevenueAllocation` row splits each payment between Neem, the pharmacy (counter channel) and the professional, by the basis-point settings above. `ProfessionalEarning` rows accrue per consultation.
- **Payouts out** — **recorded, not transferred.** Neem calculates what is owed and records that a human sent it, with a reference that can be traced back to the real transfer. There is deliberately no code that moves money to a pharmacy or a professional. _(Verified: `payout.routes.ts:17`, `:96`.)_
- **Refunds** — these _do_ call Paystack, after an admin decision. A refund is requested automatically in some flows (an abandoned consultation raises one) but is never paid without review.

### Implementation status

| Area                                                 | Status                                                                                                                                                          |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Counter journey (create, pay, QR, consult, document) | **Implemented**, live                                                                                                                                           |
| Patient-direct immediate booking                     | **Implemented**, live (`channels.directEnabled = true`)                                                                                                         |
| Patient-direct scheduled appointments                | **Implemented** — `Appointment`, `ProfessionalAvailability`, reservation expiry, slot release                                                                   |
| Weight-loss clinic (dietitian, trainer)              | **Withdrawn** 13 Oct 2026 (D69). Services deactivated, enum values kept, never used in production                                                               |
| Professional earnings and revenue share              | **Implemented**; payouts recorded manually by design                                                                                                            |
| Interruption recovery                                | **Partially deployed** — see §4; the current design is on staging, not production                                                                               |
| "Call Me" telephone bridge                           | **Inactive.** Whereby is browser-to-browser and publishes no PSTN capability; the Twilio adapter was removed. `mock` is the only voice provider the enum offers |
| Video recording                                      | **Deliberately absent** — not a feature, not a flag; the capability is missing from the provider contract                                                       |

### Legacy dependencies worth knowing

The pharmacy-mediated model came first and left traces that will look odd in a patient-direct world:

- Consultations created before v2 are all `COUNTER`; the channel field defaults accordingly.
- The revenue split still has a pharmacy share, which is meaningless on a `DIRECT` consultation; `revenue.counterShareFrom` governs when it applies.
- The patient QR/session mechanism (`ConsultationAccessToken`, `PatientSession`) exists in parallel with the v2 `PatientAccount` login. Both are live. A patient can therefore reach a consultation by two quite different auth paths.
- `CallAttendanceEvent` only started being written in late September 2026. **Consultations older than that have no attendance evidence at all**, which has already caused one class of misclassification (§4).

---

## 2. Architecture and integrations

### Shape

A **modular monolith**: two deployable processes and one database, with every external capability behind an adapter.

```
  Patient phone ─┐
  Pharmacy ──────┤      ┌───────────────────────────────────────────┐
  Professional ──┼─────▶│  WEB — apps/web                           │
  Admin ─────────┘      │  TanStack Start (SSR) + React 19          │
                        │  Hosted on NETLIFY                        │
                        └──────────────┬────────────────────────────┘
                                       │  REST/JSON  +  Socket.IO
                        ┌──────────────▼────────────────────────────┐
                        │  API — apps/api                           │
                        │  Fastify 5 + TypeScript, Node >= 22       │
                        │  Hosted on RENDER (service "neem-api")    │
                        │                                           │
                        │   routes    validation + authorization    │
                        │   services  ALL business rules            │
                        │   domain    state machines, scoring,      │
                        │             money, retention (pure)       │
                        │   data      Prisma                        │
                        │   adapters  provider interfaces + mocks   │
                        │   jobs      21 scheduled sweeps           │
                        └───┬───────────────────────────┬───────────┘
                            │                           │
              ┌─────────────▼──────────┐   ┌────────────▼─────────────────┐
              │  PostgreSQL 17         │   │  External providers          │
              │  hosted on SUPABASE    │   │  Paystack  payments/refunds  │
              │  (connection pooler)   │   │  Whereby   video/audio       │
              │  72 models, Prisma     │   │  Arkesel / Hubtel  SMS       │
              └────────────────────────┘   │  SMTP      email             │
                                           │  Local disk  file storage    │
                                           └──────────────────────────────┘
```

_(Verified: `netlify.toml`, `render.yaml`, `render.staging.yaml`, production `DATABASE_URL` host, `apps/api/src/adapters/`.)_

### Who owns what

| Component                     | Owns                                                                             | Does **not** own                                                 |
| ----------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **web** (Netlify)             | Rendering, routing, the four portals, optimistic UI, socket subscriptions        | Any business rule. It must never be the only thing enforcing one |
| **api** (Render)              | Every rule, every state transition, all authorization, all money, all scheduling | Rendering                                                        |
| **PostgreSQL** (Supabase)     | The truth. Every durable fact                                                    | —                                                                |
| **packages/contracts**        | Zod schemas shared by both apps so request/response shapes cannot drift          | Runtime behaviour                                                |
| **jobs** (in the api process) | Everything time-based: expiry, sweeps, retries, purges                           | —                                                                |
| **adapters**                  | Talking to providers, and translating their failures                             | Deciding what to do about a failure                              |

A deliberate consequence of hosting: **the web app and the API are on different platforms and deploy independently.** A change spanning both is two deploys, and they can be briefly out of step.

### Repository layout

```
apps/api              Fastify service — 116 TypeScript source files
  src/routes          HTTP surface
  src/modules/*       26 modules: auth, consultation, queue, media, clinical,
                      payment, notification, retention, scheduling, admin, …
  src/domain          pure logic — consultation-state.ts, queue-scoring.ts
  src/adapters        media / payment / notification / storage
  src/jobs            scheduler.ts — 21 jobs
  prisma              schema.prisma (72 models), 20 migrations, seed/
  scripts             operational tools (see §6)
  tests               65 Vitest files, 1,043 tests
apps/web              TanStack Start app — 44 routes
packages/contracts    shared Zod schemas
docs                  20 documents incl. decision-log.md (D1–D72)
scripts               repo-level operational checks (whereby, SMTP, SMS, backup)
```

### Integrations in detail

| Integration          | Where                                                 | Notes                                                                                                                                                                                                                                           |
| -------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Netlify**          | `netlify.toml`                                        | Hosts `apps/web` as an SSR app via Nitro's netlify preset, **not** a static bundle. `base = "apps/web"`, publish `dist`. The SSR handler path is declared explicitly because discovery silently failed once and published assets with no server |
| **Render**           | `render.yaml`, `render.staging.yaml`                  | Hosts the API only. `preDeployCommand` runs migrations and aborts the release if they fail                                                                                                                                                      |
| **Supabase**         | `DATABASE_URL`                                        | PostgreSQL 17 through the connection pooler. Separate projects for production and staging — confirmed distinct                                                                                                                                  |
| **Paystack**         | `adapters/payment/paystack-payment.provider.ts`       | Checkout, webhook verification, refunds. Boot-time guard: production refuses a test key and staging refuses a live one                                                                                                                          |
| **Whereby**          | `adapters/media/whereby-media.provider.ts`            | Room creation, join URLs, room deletion, plus inbound webhooks for attendance. `https://api.whereby.dev/v1`, bearer auth, 15s timeout                                                                                                           |
| **Arkesel / Hubtel** | `adapters/notification/`                              | SMS to Ghanaian numbers; MSISDN normalisation in `ghana-msisdn.ts`                                                                                                                                                                              |
| **SMTP**             | `adapters/notification/smtp-notification.provider.ts` | Email via nodemailer                                                                                                                                                                                                                            |
| **Storage**          | `adapters/storage/local-storage.provider.ts`          | Local disk only. **Note for scaling**: this is not object storage, and Render's disk is the single copy                                                                                                                                         |

### Realtime, and a rule about it

Socket.IO runs between both processes. The rule the codebase arrived at the hard way: **a socket event is a prompt to re-ask, never the carrier of truth.** A durable fact gets a column and is polled or re-fetched. This came from a real failure in which a patient's return was emitted to a socket room that nothing in the application was listening to, so the doctor was never told. See `patientReturnedAt` in §3.

---

## 3. Data model and the consultation lifecycle

### The entities that matter

72 Prisma models. These are the ones you need on day one, grouped by what they are for. _(Verified: `apps/api/prisma/schema.prisma`.)_

| Group               | Models                                                                                                                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity & access   | `User`, `Session`, `TwoFactorChallenge`, `TwoFactorRecoveryCode`, `Admin`                                                                                                                      |
| Patient identity    | `PatientSession` (counter, device-bound), `PatientAccount`, `PatientAuthCode`, `PatientAccountSession` (v2), `ConsultationAccessToken` (the QR)                                                |
| Professionals       | `Doctor` (all three disciplines), `DoctorLanguage`, `DoctorSubscription`, `DoctorSignature`, `DoctorDocument`, `DoctorPresence`, `DoctorQualityScore`, `DoctorPerformanceEvent`                |
| Availability & rota | `ShiftDefinition`, `DoctorShiftAssignment`, `DoctorServiceHours`, `ProfessionalAvailability` (v2)                                                                                              |
| Pharmacies          | `Pharmacy`, `PharmacyUser`, `PharmacyHours`, `PharmacyCapability`, `PharmacyDocument`, `PharmacyPayoutDetail`                                                                                  |
| Catalogue & booking | `Service`, `ProfessionalService`, `Appointment` (v2 scheduled)                                                                                                                                 |
| The consultation    | `Consultation`, `ConsultationStateEvent`, `ConsultationQueueEntry`, `ConsultationAssignment`                                                                                                   |
| The call            | `MediaSession`, `CallAttendanceEvent`, `MediaWebhookEvent`                                                                                                                                     |
| Clinical output     | `ConsultationClinicalNotes`, `ConsultationVitals`, `ConsultationTest`, `Prescription`, `PrescriptionItem`, `PrescriptionVersion`, `SubstitutionRequest`, `Referral`, `ConsultationSummary`     |
| Money               | `Payment`, `PaymentWebhookEvent`, `RevenueAllocation`, `ProfessionalEarning`, `ProfessionalPayout`, `ProfessionalPayoutDetail`, `PharmacyPayout`, `Refund`, `Promotion`, `PromotionRedemption` |
| Governance          | `AuditLog`, `ClinicalRecordAccessLog`, `Consent`, `DisclosureLog`, `RetentionJob`, `SystemSetting`, `SystemSettingHistory`                                                                     |
| Comms & feedback    | `Notification`, `NotificationTemplate`, `Feedback`, `Complaint`, `ComplaintCategory`                                                                                                           |

Two relationships are easy to get wrong:

- **`Doctor` is the professional table for every discipline**, not only doctors. A dietitian is a `Doctor` row with `discipline = DIETITIAN`. The name is legacy; renaming it is a migration nobody has wanted to do yet.
- **A consultation has many `MediaSession` rows over its life**, at most one open (`endedAt = null`). A room that expires, or that the provider has forgotten, is replaced with a new attempt under the same consultation and the old one is closed with `endReason = 'room_replaced'`.

### The state machine

Twenty states. Defined in `apps/api/src/domain/consultation-state.ts`; every move goes through `transition()` in `apps/api/src/modules/consultation/consultation.service.ts`.

```
  PENDING_PAYMENT ──▶ PAYMENT_PROCESSING ──▶ PAID ──▶ ACTIVATED
        │                     │                            │
        │                     ▼                            ▼
        │              PAYMENT_FAILED            WAITING_FOR_PATIENT
        ▼                                                  │
     EXPIRED  ◀──────────────────────────────┐             ▼
                                             │      PATIENT_JOINED
                                             │             │
                                             │             ▼
                                             │    WAITING_FOR_DOCTOR
                                             │             │
                                             │      (allocator offers)
                                             │             ▼
                                             │        ASSIGNED ──▶ REASSIGNING
                                             │             │             │
                                             │      (professional accepts)
                                             │             ▼             │
                                             │     DOCTOR_ACCEPTED ◀─────┘
                                             │             │      ▲
                                             │     (professional joins room)
                                             │             ▼      │
                                             │        IN_PROGRESS  │
                                             │             │      │
                                             │     (call breaks)  │ (resumes)
                                             │             ▼      │
                                             │        INTERRUPTED ┘
                                             │             │
                                             │             ▼
                                             └────▶   ABANDONED

         COMPLETING ──▶ COMPLETED      CANCELLED      REFUND_REQUESTED ──▶ REFUNDED

  States that OCCUPY a professional's slot:
      DOCTOR_ACCEPTED  ·  IN_PROGRESS  ·  COMPLETING
```

`EXPIRED` is reachable from every post-payment state; the sweeps described in section 4 are what get it there.

### `transition()` is the only door

The single most important convention in the codebase. `transition()` writes the timestamps, claims and releases the professional's capacity, clears the flags belonging to the state being left, and records a `ConsultationStateEvent`. **Writing `consultation.state` anywhere else is a bug**, and more than one past incident was exactly that.

Capacity is expressed once, as `OCCUPYING_CONSULTATION_STATES`. The capacity counter, the sweeps and the professional's own screen all read from that one list, so they cannot disagree. Capacity is **released** when a consultation leaves an occupying state and **re-claimed** when it returns from `INTERRUPTED`.

### Timestamp columns that carry rules

| Column               | Meaning                                     | Why it is separate                                                                    |
| -------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------- |
| `firstStartedAt`     | When the consultation first began           | Written once. The patient's timer counts from here, so reconnecting cannot restart it |
| `startedAt`          | When the current run began                  | —                                                                                     |
| `unservedDeadlineAt` | When it stops being worth waiting for (24h) | **Stored, not recomputed** — so a rejoin cannot extend the consultation's life        |
| `interruptedAt`      | When the _current_ break began              | Cleared on resume                                                                     |
| `firstInterruptedAt` | When the _first_ break began                | Written once, **never cleared**. It is the total recovery budget                      |
| `rejoinableUntil`    | Deadline for the current break              | Cleared on resume — it used not to be, see section 4                                  |
| `patientReturnedAt`  | The patient came back and is waiting        | A durable fact, not an event                                                          |

### Joining a room is not evidence that care was delivered

This distinction runs through the system and you will meet it again in the reconciliation tooling.

- **`CallAttendanceEvent`** records `JOINED` / `LEFT` per participant with a `source` of `CLIENT`, `WEBHOOK` or `SERVER`.
- **A `CLIENT` `JOINED` is written when the browser calls the join endpoint** (`joinMediaSession`, `apps/api/src/modules/media/media.service.ts:210`). It means "a page asked for a room credential" — **not** "media connected". A patient who opens the page and never actually connects still produces a `JOINED`. _(Verified by reading the call site. This is the "page load records attendance" behaviour.)_
- **`WEBHOOK` events come from Whereby** and are better evidence, because they describe the room rather than the page. _(Verified: production has received 14 media webhook events; attendance by source is CLIENT JOINED 18, CLIENT LEFT 3, WEBHOOK JOINED 7, WEBHOOK LEFT 7.)_
- **Evidence that care was delivered** is different again: clinical notes, a prescription, a referral or a summary. The reconciliation tool buckets consultations as `CARE_DELIVERED`, `JOINED_ONLY` or `NO_EVIDENCE` on precisely this distinction, because a refund decision needs it.

### Sequence — a consultation that goes well

```
Patient      Web          API              Paystack  Allocator  Professional  Whereby
   │          │            │                   │         │          │           │
   │ book/pay>│──create───>│                   │         │          │           │
   │          │            │──checkout────────>│         │          │           │
   │          │            │<─webhook: success─│         │          │           │
   │          │            │ PAID -> ACTIVATED │         │          │           │
   │ open    >│──join queue│ WAITING_FOR_DOCTOR│         │          │           │
   │          │            │─────────────────────offer──>│          │           │
   │          │            │                   │         │ ASSIGNED │           │
   │          │            │<──────────────── accept ────│          │           │
   │          │            │ DOCTOR_ACCEPTED   (slot taken)         │           │
   │          │            │<── join media ────────────────────────│            │
   │          │            │──────────── create room ──────────────────────────>│
   │          │            │ IN_PROGRESS   firstStartedAt set       │           │
   │< join ───│<─room URL──│                                        │           │
   │          │            │   (both in the call)                   │           │
   │          │            │<── notes, prescription ────────────────│           │
   │          │            │<── complete ──────────────────────────│            │
   │          │            │ COMPLETING -> COMPLETED  (slot released)           │
   │< documents            │ earnings + revenue allocation written  │           │
```

### Sequence — an interrupted call and recovery

The path that has caused the most trouble. Section 4 explains why.

```
 Patient            API                      Scheduler          Professional
    │                │                           │                   │
    │  (power cut)   │                           │                   │
    │   X ───────────│                           │                   │
    │                │<──── LEFT (webhook or client) ────────────────│
    │                │  state still IN_PROGRESS, slot still held     │
    │                │                           │                   │
    │                │  interrupt-stale-consultations (every 5 min)  │
    │                │<──────────────────────────│                   │
    │                │  last signal LEFT, 15 min elapsed             │
    │                │  -> INTERRUPTED,  SLOT RELEASED               │
    │                │     sets interruptedAt, firstInterruptedAt,   │
    │                │     rejoinableUntil = now + 15 min            │
    │                │     (capped at firstInterruptedAt + 60 min)   │
    │                │                           │                   │
    │ ── rejoin ────>│  patientReturnedAt set (durable fact)         │
    │                │──── notification ────────────────────────────>│
    │ "we are notifying your doctor"             │  alert in portal  │
    │                │                           │                   │
    │                │<──── professional rejoins ────────────────────│
    │                │  -> IN_PROGRESS, slot re-claimed              │
    │                │  rejoinableUntil, interruptedAt and           │
    │                │  patientReturnedAt CLEARED                    │
    │                │  (firstInterruptedAt kept — it is the budget) │
    │                │                           │                   │
    │   ...or nobody returns:                    │                   │
    │                │  expire-recovery-windows (every 60 s)         │
    │                │<──────────────────────────│                   │
    │                │  -> ABANDONED, room torn down,                │
    │                │     exactly ONE refund requested              │
```

**Key files.** `apps/api/src/modules/media/media.service.ts` (`joinMediaSession`, `leaveMediaSession`, `interruptConsultation`, `resumeInterrupted`, `recordPatientReturn`, `getTimer`); `apps/api/src/modules/consultation/unserved.service.ts` (the sweeps and the evidence helpers); `apps/api/src/jobs/scheduler.ts`; `apps/api/src/modules/queue/presence.service.ts` (capacity and the blocked-by message).

### Immediate versus scheduled

|                      | Immediate                        | Scheduled (v2 appointment)                                                  |
| -------------------- | -------------------------------- | --------------------------------------------------------------------------- |
| Entry                | Pay, then join the queue now     | Reserve a slot (`RESERVED`), pay (`CONFIRMED`), return at the time          |
| Slot held by         | —                                | `Appointment` against `ProfessionalAvailability`                            |
| If unpaid            | Payment expiry sweep             | `release-lapsed-reservations` returns the slot; appointment → `EXPIRED`     |
| Admission            | Straight to `WAITING_FOR_DOCTOR` | `open-due-appointments` hands it over at the appointed time → `OPENED`      |
| Deadline anchored to | Payment time                     | **`startsAt`** — measured from the appointment, not from when it was booked |
| Stragglers           | —                                | `admit-stranded-bookings` catches bookings that never reached the queue     |

### Background jobs

21 jobs in `apps/api/src/jobs/scheduler.ts`. All use `setInterval`, each first runs **after** one interval rather than at boot, and the whole scheduler is **skipped when `NODE_ENV === 'test'`**. Those bearing on the lifecycle:

| Job                                                                                                                                                                                                                                                                                               | Interval  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `expire-recovery-windows`                                                                                                                                                                                                                                                                         | 60 s      |
| `interrupt-stale-consultations`                                                                                                                                                                                                                                                                   | **5 min** |
| `expire-unserved-consultations`                                                                                                                                                                                                                                                                   | **5 min** |
| `process-waiting-queue`, `enforce-response-window`, `reconcile-doctor-load`                                                                                                                                                                                                                       | frequent  |
| `cancel-unserved-consultations`, `release-lapsed-reservations`, `open-due-appointments`, `admit-stranded-bookings`                                                                                                                                                                                | periodic  |
| `purge-expired-clinical-records`, `purge-expired-sessions`, `retry-notifications`, `reconcile-payments`, `recompute-quality-scores`, `warn-expiring-licences`, `reap-stale-presence`, `sweep-subscription-expiry`, `expire-pending-payments`, `expire-consultation-tokens`, `emit-timer-warnings` | periodic  |

The 5-minute cadence matters whenever you reason about timing: a 15-minute threshold means the transition actually lands between 15 and 20 minutes after the triggering event.

---

## 4. Current challenges and incident history

This is the section to read closely. Neem's hardest problems are all in one area — what happens when a call does not go to plan — plus one live, unresolved provider incident that is unrelated to them.

### 4.0 How to read the status columns

A passing test suite does not mean an incident is resolved. Neither does a deployed commit. These are tracked separately on purpose:

| Stage                      | Means                                                          |
| -------------------------- | -------------------------------------------------------------- |
| **Reported**               | Someone described the behaviour                                |
| **Reproduced**             | Observed in data or a test, not just described                 |
| **Fixed locally**          | Code written, tests green on a developer machine               |
| **Deployed**               | Running in a named environment, commit confirmed via `/health` |
| **Verified in production** | Observed working, in production, on real data                  |

**Nothing in the recovery work below has reached "verified in production".** Two items are deployed to staging only.

### 4.1 Issue register

| #   | Issue                                                                                                               | User impact                                                                                            | Evidence                                                                                                            | Root cause / confidence                                                                                                                                                                                                                                    | Fix & commit                                            | Local / Staging / Production | Tests                                           | Remaining work                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ---------------------------- | ----------------------------------------------- | -------------------------------------------------------------------- |
| 1   | No job could end a consultation once it left the queue                                                              | Consultations open indefinitely; one ran 7 days; money held                                            | Production record; 8 states had no terminal sweep                                                                   | **Certain** — verified by reading the scheduler and state machine                                                                                                                                                                                          | D61/D63 · `1245c9b`                                     | ✅ / ✅ / ✅                 | Lifetime suite                                  | None                                                                 |
| 2   | Patient could not rejoin until the professional returned first                                                      | Patient stuck on a dead screen after a power cut, having paid                                          | Reported, then reproduced                                                                                           | **Certain** — state stayed `INTERRUPTED`; the screen keys off state, and the event telling the professional went to a socket room nothing listened to                                                                                                      | D64 · `1d1b521`                                         | ✅ / ✅ / ✅                 | `patient-return.test.ts`                        | Patient-first flow never exercised end-to-end with two real browsers |
| 3   | Professional's slot stuck; no new offers, permanently                                                               | Professional idle and unbookable; patients queue behind them                                           | Production: a consultation held `DOCTOR_ACCEPTED` with no sweep able to see it                                      | **Certain**                                                                                                                                                                                                                                                | D65 · `803c0e7`                                         | ✅ / ✅ / ✅                 | Lifetime suite                                  | None                                                                 |
| 4   | "You are already with 1 of 1 patients" named no consultation                                                        | Professional cannot find or clear the blocker without engineer access                                  | Reported; reproduced from the record                                                                                | **Certain** — no screen listed occupying consultations                                                                                                                                                                                                     | D66 · `9bbffef`                                         | ✅ / ✅ / ✅                 | Presence view                                   | None — deployed 15 Oct                                               |
| 5   | A professional who leaves holds their slot for 2 hours                                                              | Professional locked out of the queue for an afternoon                                                  | Production: `LEFT` 13:18:38, still `IN_PROGRESS` at 15:12 — 113 min against a 120-min threshold                     | **Certain** — threshold applied to an explicit `LEFT` as if it were silence                                                                                                                                                                                | D67 · `b97335a`                                         | ✅ / ✅ / ✅                 | 37 lifetime cases                               | Deployed 15 Oct. **End-to-end staging run still not done**           |
| 6   | `rejoinableUntil` survived a resume                                                                                 | Patient's "Unfinished" card hid itself on a live consultation                                          | Production record showed deadline 13:26 on a consultation resumed at 13:18                                          | **Certain**                                                                                                                                                                                                                                                | D67 · `b97335a`                                         | ✅ / ✅ / ✅                 | Lifetime suite                                  | As above                                                             |
| 7   | A later break inherited the first break's deadline                                                                  | Second interruption expired before the patient saw it                                                  | Found while fixing #6                                                                                               | **Certain**                                                                                                                                                                                                                                                | D67 · `b97335a`                                         | ✅ / ✅ / ✅                 | Lifetime suite                                  | As above                                                             |
| 8   | Legacy consultations misclassified as `NO_EVIDENCE`                                                                 | Risk of wrong refund decisions on historic records                                                     | `CallAttendanceEvent` only exists from ~29 Sep 2026                                                                 | **Certain**                                                                                                                                                                                                                                                | Evidence helper also reads state history · `1245c9b`    | ✅ / ✅ / ✅                 | Lifetime suite                                  | None                                                                 |
| 9   | A rejoin after expiry minted a **fresh Whereby room**                                                               | A new way into a consultation that should have been closed — a room URL is a bearer credential         | Production record (7-day-old consultation)                                                                          | **Certain** — security-relevant                                                                                                                                                                                                                            | Deadline checked before the room is opened · `1245c9b`  | ✅ / ✅ / ✅                 | Lifetime suite                                  | None                                                                 |
| 10  | **Whereby room creation failing**                                                                                   | Patient and professional both unable to connect; consultation lost                                     | `NEEM-7WEC-TFWG-J4JX`, 7 Oct, zero media sessions                                                                   | **Certain** — the `WHEREBY_API_KEY` JWT expired at 16:00:11Z, ten minutes before the consultation. Environmental, not code. See §4.3                                                                                                                       | Key replaced; expiry warning D70 · `14a37ec`, `2f2a6e1` | ✅ / ✅ / ✅                 | Sentinel + expiry cases                         | None                                                                 |
| 11  | Provider failures reported as "Something went wrong on our side" (500)                                              | Patient blamed Neem; operator could not tell an outage from a bug                                      | Code read: neither provider error was mapped                                                                        | **Certain**                                                                                                                                                                                                                                                | D68 · `3c06b2c`                                         | ✅ / ✅ / ✅                 | 3 cases, one a true regression test             | None — deployed 15 Oct                                               |
| 12  | During an outage, Reconnect invites a retry that cannot work; screen says "You are in the room" when no room exists | Misleading; wasted retries                                                                             | Screenshot, 7 Oct                                                                                                   | **Certain**                                                                                                                                                                                                                                                | **Not fixed**                                           | ❌ / ❌ / ❌                 | None                                            | Decide and implement                                                 |
| 13  | Flaky test: `v2-appointments › a reservation nobody paid for › expires`                                             | CI noise; could mask a real failure                                                                    | Failed 1 run in 8, passed on re-run                                                                                 | **Suspected** — shift band derived from wall clock, so time-of-day dependent                                                                                                                                                                               | None                                                    | ❌ / ❌ / ❌                 | n/a                                             | Diagnose                                                             |
| 14  | 8 refunds sitting at `REQUESTED`                                                                                    | Real money owed to real people                                                                         | Production `refunds` grouped by state: 8 REQUESTED, 2 REJECTED, 1 COMPLETED                                         | n/a — process, not defect                                                                                                                                                                                                                                  | n/a                                                     | n/a                          | n/a                                             | **Admin decisions needed**                                           |
| 15  | Doctors went offline by themselves after a minute and a half                                                        | Doctor dropped from the queue while working; patients queue behind an apparently absent doctor         | Reported from the pilot; the live `doctor_presence` row showed `onlineSince` null beside a recent `lastHeartbeatAt` | **Certain** — `HEARTBEAT_STALE_SECONDS` was 90 and the heartbeat ran only on the queue screen                                                                                                                                                              | D72                                                     | ✅ / ❌ / ❌                 | `doctor-presence.test.ts`, 6 cases              | **Staging run, then deploy**                                         |
| 16  | The "a patient has come back" Resume button did nothing                                                             | Doctor cannot resume; the patient waits in a room the doctor never re-enters                           | Reported from the pilot with a screenshot                                                                           | **Certain** — the banner only navigated. From the consultation page that is a navigation to the page already open; from any other page the event fired before the screen mounted, and mount deliberately refuses to join an interrupted consultation (D57) | D72                                                     | ✅ / ❌ / ❌                 | None automated — verified by reading both paths | **Staging run, then deploy. Worth an automated case**                |
| 17  | A patient who closed the call could not get back in                                                                 | Doctor waits in a room nobody can re-enter; the consultation is lost although both parties are present | Reported from the pilot                                                                                             | **Certain** — the patient's link is single-use and spent, and `acceptsPatientArrival` refused a new code once the consultation was under way, so the counter could not re-admit them either                                                                | D72                                                     | ✅ / ❌ / ❌                 | `patient-return.test.ts`, 4 cases               | **Staging run, then deploy**                                         |
| 18  | Screens promised not to charge twice for consultations nobody paid for                                              | Raises a cost the patient was never asked for, and offered a refund of nothing                         | Reported from the pilot                                                                                             | **Certain** — the copy predates D69 and was unconditional                                                                                                                                                                                                  | D72                                                     | ✅ / ❌ / ❌                 | None — copy                                     | **Staging run, then deploy**                                         |

### 4.2 Dropped calls and rejoining

#### What the system is trying to survive

A patient in Ghana on a phone, on mobile data, possibly on a power cut. Calls break. The design position is that **a broken call is not a failed consultation**: the patient has paid, and coming back must cost them nothing.

#### The original defect — consultations that could never end

Eight states had no job that could terminate them: `ACTIVATED`, `WAITING_FOR_PATIENT`, `PATIENT_JOINED`, `ASSIGNED`, `DOCTOR_ACCEPTED`, `IN_PROGRESS`, `INTERRUPTED`, `COMPLETING`. One production consultation sat `IN_PROGRESS` for **seven days** — the professional accepted at 12:18:18, joined at 12:18:22, and nothing happened again.

The worse part was not the stuck row. A rejoin seven days later found the Whereby room long swept and **created a new one**. Because the room URL is the credential, that is a security defect, not a cosmetic one. The deadline is now checked _before_ a room is opened, because the harm is the room existing. _(Verified: `joinMediaSession` in `media.service.ts`.)_

#### Patients disconnecting, and being unable to rejoin

**Reported and reproduced.** A patient whose phone died could press Rejoin and nothing would visibly happen. The rejoin was not failing — the room opened and a credential was issued. Three things combined:

1. Correctly, a patient's return does not resume the consultation (only a professional should), so the state stayed `INTERRUPTED`.
2. The patient's screen is chosen entirely by that state, so the same screen re-rendered. Nothing appeared to happen.
3. The professional was never told: the event went to a socket room **nothing in the application listened to**.

The fix (D64, `1d1b521`) makes a return a **durable fact** — `patientReturnedAt`, written once by a conditional update — rather than an event. A refresh, a double tap and a reconnect are one return; they do not re-notify or reset the wait. The professional is told through channels they already use, carrying the consultation reference and nothing else, worded as "waiting" rather than "rejoin now" because they may be mid-consultation with someone else. The patient's screen says "We are notifying your doctor", never "notified" — the only thing the system knows is that the notification service accepted it.

**Intended experience, now implemented:** the patient may return first, see an honest waiting screen with the time remaining, and have the professional notified durably — all inside a bounded window.

#### Professionals leaving, and stuck capacity

Two distinct faults, both now addressed on staging only.

**Stuck capacity (#3).** A consultation stuck in `DOCTOR_ACCEPTED` — accepted, never joined, tab closed — held the professional's only slot and nothing could release it. The sweep looked at `IN_PROGRESS` alone, and the unserved deadline only exists for consultations paid for after it was introduced. Fixed by making `OCCUPYING_CONSULTATION_STATES` the single definition and sweeping all of it, plus giving a never-started consultation a clock from `assignedAt`.

**The two-hour hold (#5).** A professional's device recorded `LEFT` at 13:18:38; at 15:12 the consultation was still `IN_PROGRESS`, 113 minutes quiet against a 120-minute threshold. **Nothing was broken** — the threshold was wrong for what had happened. 120 minutes exists because silence is ambiguous: joining and leaving are recorded, talking is not. That reasoning does not apply to a `LEFT`, which is the device saying they have gone.

D67 therefore picks the threshold from the **last professional signal**:

| Last signal             | Threshold                                     |
| ----------------------- | --------------------------------------------- |
| `LEFT`                  | **15 minutes** → `INTERRUPTED`, slot released |
| anything else (silence) | **120 minutes**                               |

A professional still in the room always has `JOINED` as their last signal, so **a live consultation is never swept**, and a flapping connection or a second tab that ends on `JOINED` reads as presence. Total arc after leaving is **30 minutes**: 15 to `INTERRUPTED` (slot free), then a 15-minute recovery window, then termination. Repeated breaks share one 60-minute budget via `firstInterruptedAt`.

Add the scheduler cadence when predicting real times: the stale sweep runs every 5 minutes, so "15 minutes" lands between 15 and 20.

#### Page load recording attendance

**Confirmed, and it matters.** A `CLIENT` `JOINED` attendance row is written when the browser calls the join endpoint, not when media connects (`media.service.ts:210`). So merely loading the consultation page produces attendance evidence. Treat `CLIENT` events as "a page asked for a credential" and `WEBHOOK` events as "the room saw a participant". Both exist in production. The threshold logic in D67 reads whichever is most recent, which is deliberate — a client `JOINED` on reconnect is real evidence of presence — but any future rule that needs _proof of media_ must use the webhook source.

#### Stale rejoin deadlines, and unlimited extensions

`rejoinableUntil` used to survive a resume, on the reasoning that the deadline belonged to the interruption rather than to who was in the room. That left an obsolete deadline on a live consultation, and the patient's "Unfinished" card — which takes the earliest deadline it can see — **hid itself on a consultation that was still running**.

Leaving `INTERRUPTED` now clears `rejoinableUntil`, `interruptedAt` and `patientReturnedAt` inside `transition()`, so any future route out clears them too. What stops this becoming an unlimited extension is `firstInterruptedAt`, written once and never cleared: every window is `min(now + recoveryWindow, firstInterruptedAt + maxRecoveryTotal)`.

#### Excessive overtime and the timer

The patient-facing timer counts from `firstStartedAt`, not `startedAt`, and freezes at `interruptedAt` while interrupted — so a reconnect cannot restart the clock and a break does not accrue time. The timer **never ends a consultation**; it warns. Only a professional completing it, or a sweep terminating it, ends one.

#### Legacy attendance misclassification

`CallAttendanceEvent` only began being written in late September 2026. An early version of the evidence check therefore classified every older consultation as `NO_EVIDENCE` — which, for a refund decision, is the opposite of harmless. The evidence helper now also reads state history, so a consultation that demonstrably reached `IN_PROGRESS` with a professional actor is not reported as though nobody ever arrived.

### 4.3 The Whereby incident of 7 October 2026

**Status: RESOLVED. Root cause established, fixed, and guarded against recurrence.**

**The `WHEREBY_API_KEY` had expired.** The key is a JWT; its `exp` claim was **2026-10-07T16:00:11Z**. The consultation below was created at 16:10:30 and accepted at 16:11:27 — ten minutes and eleven minutes after the credential died. Whereby refused `POST /meetings`, so no room was ever created, which is exactly what the record shows.

Three things came out of it:

1. **The key was replaced** in both Render services. `npm run whereby:check` creates and deletes a real room against the live API and confirms a working key without printing it.
2. **A credential with a date on it now says so before the date** (D70). A daily job reads `credentialExpiresAt()` off the provider and warns ahead of expiry, because the failure mode here was behaviour changing silently when a timestamp passed.
3. **A sentinel guard**, found when the real replacement key arrived carrying `exp: 9007199254740891` — `Number.MAX_SAFE_INTEGER`, Whereby's way of saying "never expires". That is _finite_, so it passed `Number.isFinite`, and `new Date(exp * 1000)` is an Invalid Date, whose NaN comparisons are all false — so the early return never fired and `toISOString()` threw. It would have crashed the daily job on every run. A key that never expires is now reported as having no expiry.

Everything below is the original diagnosis, kept because the reasoning is how the cause was found and is worth reading before diagnosing the next media fault. This remains a separate problem from everything in §4.2.

#### What happened, from the record

All times UTC. Consultation `NEEM-7WEC-TFWG-J4JX` — reference only; no patient identity appears here or is needed.

| Time     | Event                                                                                                             |
| -------- | ----------------------------------------------------------------------------------------------------------------- |
| 16:10:30 | Consultation created — channel **`DIRECT`** (patient-direct booking), type **VIDEO**                              |
| 16:10:58 | **Payment succeeded** — GHS 1.00, status `SUCCESS`                                                                |
| 16:11:00 | `PAID` → `ACTIVATED` → `WAITING_FOR_PATIENT` → `PATIENT_JOINED` → `WAITING_FOR_DOCTOR`                            |
| 16:11:20 | Offered to a professional (`offered_to_doctor_attempt_1`)                                                         |
| 16:11:27 | **Accepted** → `DOCTOR_ACCEPTED`, slot taken                                                                      |
| ~16:11   | Both parties attempt to join. **Both see an error.** No media session is ever created                             |
| 18:14:50 | Swept → `INTERRUPTED`, **slot released** (123 min after accept: the 120-min silence threshold plus sweep cadence) |
| 18:29:51 | `INTERRUPTED` → **`EXPIRED`** (`recovery_window_elapsed`)                                                         |
| 18:29:51 | **One refund requested**, GHS 1.00, state `REQUESTED`                                                             |

_(All verified by read-only query of the production database, 9 Oct 2026.)_

#### The exact failing operation

**Room creation — `openRoom()`, i.e. `POST /meetings` to Whereby.** Not token issuance, not room lookup, not joining.

The evidence is decisive: the consultation has **zero `MediaSession` rows**. `joinMediaSession()` creates the session row as part of opening a room, so a failure after room creation would have left a row behind. There is none, so the failure is at or before the Whereby `POST /meetings` call. Both participants failed identically because both call the same endpoint, `POST /api/v1/patient/consultation/media/join` (and its professional equivalent).

#### What each participant saw

Both the patient and the professional saw the same thing _(reported, with a screenshot of the patient's phone)_:

- A spinner and "Connecting…"
- "Waiting for the doctor to join. You are in the room and they will see you when they arrive." — **false**; there was no room
- "Something went wrong on our side. Please try again." with a **Reconnect** link that could not have worked

#### HTTP status, error handling, timeouts and retries

| Aspect                        | Behaviour at the time                                                                                                                                                                                     |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status returned to the client | **500**, `INTERNAL_ERROR`, generic message                                                                                                                                                                |
| Why                           | `MediaProviderError` was mapped nowhere and fell through to the generic handler                                                                                                                           |
| Whereby timeout               | 15 s (`WHEREBY_TIMEOUT_MS`, default 15000)                                                                                                                                                                |
| Retry                         | **None for room creation.** There is a retry path for _token issuance_ — if `issueJoinToken` throws, a replacement room is opened and the token re-issued — but a failure of `openRoom` itself propagates |
| Logging                       | A single `unhandled error` line with the adapter's message. Room URLs are never logged, by design                                                                                                         |

#### Classification

| Hypothesis                                                                     | Assessment                                                                                                                                      |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Application defect                                                             | **Ruled out with high confidence.** Production ran `803c0e7` throughout, and room creation last succeeded on 6 Oct at 13:08 on that same commit |
| Upstream Whereby outage                                                        | **Possible.** Not confirmed                                                                                                                     |
| Authentication / configuration (revoked or rotated key, wrong value in Render) | **Possible, and a known live risk** — rotating the Whereby API key was an outstanding task                                                      |
| Billing / quota (402, 429)                                                     | **Possible**                                                                                                                                    |
| Network between Render and Whereby                                             | **Possible.** The adapter has distinct messages for unreachable and timed-out                                                                   |
| Whereby API retired                                                            | **Ruled out** — an unauthenticated probe of `https://api.whereby.dev/v1` returned 401, so the service is alive and responding                   |

**Verified narrowing:** the fault is environmental rather than in Neem's code. **Not established:** which of the four environmental causes it was. That distinction needs one piece of evidence nobody has yet retrieved.

#### What is missing, and the minimum needed to close it

Only one of the following is required:

1. **`npm run whereby:check`** — the fastest route. Reads `WHEREBY_API_KEY` from `.env`, never prints it, creates a real room against the live API, verifies and deletes it. Touches no database. _(Verified to exist: `scripts/whereby-check.mjs`. **Writes to Whereby** — it creates and deletes a real meeting.)_
2. **The Render log line** for `neem-api` around 16:11 UTC on 7 Oct. Search **`unhandled error`**, not "Whereby" — when Whereby supplies a message the adapter uses _Whereby's own words_, which may be just "Unauthorized". The message distinguishes the causes:

| Message                                                         | Means                                                         |
| --------------------------------------------------------------- | ------------------------------------------------------------- |
| Whereby's wording, or `Whereby returned <status> for /meetings` | API refusal — 401 key, 402 billing, 403 permission, 429 quota |
| `The video provider could not be reached.`                      | Network or DNS from Render — not the key                      |
| `The video provider did not respond in time.`                   | Whereby slow or hung; 15 s timeout                            |

Neither was available to this investigation: there is no Render CLI or API key on the machine used, and the Whereby key is deliberately not readable from the repository.

#### Recovery performed, and remaining risk

**No manual recovery was performed. No production record was modified.** The system recovered itself: the slot was released at 18:14, the consultation expired at 18:29, and exactly one refund was requested. As of 9 October all six professional presence rows read `load=0/1` and zero consultations occupy a slot. _(Verified.)_

Remaining risk:

- **The cause is still present as far as anyone knows.** No room has been created successfully since 6 October. The next patient to pay may hit exactly this.
- **The patient paid and received nothing.** The refund is raised but sits at `REQUESTED` awaiting an admin decision, along with six others.
- **Diagnosis is still harder than it should be on production**, because D68 is on staging only.
- **A consultation that fails this way still consumes a professional's slot for two hours** on production, because D67 is also staging-only. Here the fallback behaved correctly — but slowly.

---

## 5. Development setup and deployment

### Required software

| Tool    | Version                                        | Why                                                   |
| ------- | ---------------------------------------------- | ----------------------------------------------------- |
| Node.js | **>= 22** (declared in `package.json` engines) | Both apps                                             |
| npm     | 10+ (workspaces)                               | The monorepo uses workspaces; do not use yarn or pnpm |
| Docker  | any current                                    | Local PostgreSQL                                      |
| Git     | any current                                    | —                                                     |

### First run

```
npm run setup
```

Which is: `npm install` → `docker:up` → `db:migrate` → `db:migrate:test` → `db:grants` → `db:seed`. _(Verified to exist in `package.json`. **Not executed during this investigation** — treat the end-to-end run as unverified.)_

Then:

```
npm run dev          # both processes
npm run dev:api      # API only
npm run dev:web      # web only
```

Useful database commands: `docker:up`, `docker:down`, `docker:reset`, `db:migrate`, `db:migrate:test`, `db:reset`, `db:seed`, `db:studio`, `db:grants`.

### Migrations — the safe procedure

Migrations are **authored offline**, never generated against a live database:

```
npx prisma migrate diff \
  --from-schema-datamodel <snapshot of the previous schema> \
  --to-schema-datamodel prisma/schema.prisma \
  --script
```

Then `db:migrate` (dev), `db:generate`, `db:migrate:test`. Two rules:

- **Never edit a migration that has already been applied in any environment.** It changes the checksum and the next deploy fails. Add a second migration. This has already happened once; the recovery was to restore the original file and add a separate backfill migration.
- **Keep schema changes and data backfills in separate migrations**, for the same reason.

### Seed data, and why seeding production is safe

`db:seed` upserts reference data: languages, shift definitions, complaint categories, services, and `DEFAULT_SETTINGS`. For settings the upsert's `update` clause touches **only `description` and `category`** — never a value. _(Verified: `apps/api/prisma/seed/reference-data.ts`.)_ So re-seeding an environment will not reset a tuned price or a feature flag. This is relied upon: a setting added in code does not exist as a row until a seed runs, and until then its code default applies.

Demo and synthetic data are gated behind `SEED_DEMO_DATA`, with `DEMO_ADMIN_EMAIL` / `DEMO_ADMIN_PASSWORD` for a local admin. `npm run admin:create` makes a real admin (**mutating**).

### Tests

| Command                                      | What                                                                  | Verified                               |
| -------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------- |
| `npm test`                                   | 1,043 Vitest tests, 65 files, against a real PostgreSQL test database | **Run during this work — all passing** |
| `npx eslint .`                               | Lint + Prettier                                                       | **Run — clean**                        |
| `npx tsc --noEmit -p apps/api/tsconfig.json` | Typecheck                                                             | **Run — clean**                        |
| `npm run test:e2e`                           | 11 Playwright specs                                                   | Not run — unverified                   |

**Run one suite at a time.** Parallel runs share the test database and corrupt one another; if results look impossible, that is usually why. Stop, `db:migrate:test`, run once cleanly.

### Environments and isolation

|          | Production                            | Staging                                                |
| -------- | ------------------------------------- | ------------------------------------------------------ |
| Web      | Netlify                               | Netlify                                                |
| API      | Render `neem-api`, branch `main`      | Render `neem-api-staging`, branch `staging`            |
| Database | Supabase project A                    | Supabase project B — **confirmed a different project** |
| Paystack | Live key; **boot refuses a test key** | Test key; **boot refuses a live key**                  |
| Email    | Real                                  | `STAGING_EMAIL_REDIRECT`                               |

### Branch to deployment

| Branch    | Deploys to        | Trigger                                                         |
| --------- | ----------------- | --------------------------------------------------------------- |
| `staging` | staging API + web | Push. `autoDeploy` is not set, so Render's default (on) applies |
| `main`    | **production**    | Push — **there is no separate release step**                    |

**Pushing `main` deploys production.** The only gate is `preDeployCommand: npm run db:deploy`, which runs `prisma migrate deploy`; Render aborts the release if it fails. A consequence worth relying on: a service serving a given commit has necessarily applied that commit's migrations.

The repository is connected to **Lovable**. Do not rewrite published history — no force push, no rebasing or amending anything already pushed.

### Verifying the running release

Check the commit, never the behaviour:

```
curl -s https://api.neemtelehealth.com/api/v1/health
curl -s https://neem-api-staging.onrender.com/api/v1/health
```

Both return the running seven-character commit from `RENDER_GIT_COMMIT`. `/health/ready` additionally proves the database is reachable.

Two traps, both of which have produced wrong conclusions:

- **A 502 means "not yet", not "broken".** Render serves 502 while a service restarts. A check written as `!= 404` passes on a 502.
- **Verifying a few minutes after a push usually shows the old build.** Poll for the exact commit before concluding anything.

### Rollback

There is no one-button rollback. The options, in order of preference:

1. **Re-deploy the previous commit from the Render dashboard** (Render keeps previous deploys). Fastest, no git history change.
2. **`git revert` and push.** Safe with Lovable, because it adds a commit rather than rewriting history.
3. **Never** force-push an earlier commit over `main`.

Caution: a rollback does **not** undo a migration. If the bad release migrated, write a forward migration.

### Environment variables

Names and purposes only. No values appear in this document, and none should be pasted into a chat, a ticket or a terminal transcript.

| Variable                                                                                                                                      | Purpose                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `NODE_ENV`, `DEPLOY_ENV`, `LOG_LEVEL`                                                                                                         | Runtime mode and logging                                 |
| `API_PORT`, `API_PUBLIC_URL`, `WEB_ORIGIN`, `MARKETING_ORIGIN`                                                                                | Addresses and CORS                                       |
| `DATABASE_URL`, `TEST_DATABASE_URL`, `AUDIT_DATABASE_URL`                                                                                     | PostgreSQL. The audit URL is a separate, restricted role |
| `SESSION_SECRET`, `CSRF_SECRET`, `CSRF_COOKIE_NAME`, `CSRF_COOKIE_DOMAIN`                                                                     | Session and CSRF                                         |
| `SESSION_IDLE_TIMEOUT_MINUTES`, `SESSION_ABSOLUTE_TIMEOUT_HOURS`, `PATIENT_SESSION_TIMEOUT_MINUTES`                                           | Session lifetimes                                        |
| `LOGIN_MAX_ATTEMPTS`, `LOGIN_LOCKOUT_MINUTES`                                                                                                 | Brute-force protection                                   |
| `ENCRYPTION_KEY`, `ENCRYPTION_KEY_PREVIOUS`                                                                                                   | Field encryption, with rotation support                  |
| `PAYMENT_PROVIDER`, `PAYSTACK_SECRET_KEY`, `PAYSTACK_PUBLIC_KEY`, `PAYSTACK_WEBHOOK_SECRET`, `PAYSTACK_TIMEOUT_MS`, `PAYSTACK_RECEIPT_DOMAIN` | Payments                                                 |
| `VIDEO_PROVIDER`, `WHEREBY_API_KEY`, `WHEREBY_WEBHOOK_SECRET`, `WHEREBY_TIMEOUT_MS`                                                           | Video                                                    |
| `VOICE_PROVIDER`                                                                                                                              | Call Me — `mock` only; no PSTN provider exists           |
| `SMS_PROVIDER`, `SMS_API_KEY`, `SMS_SENDER_ID`, `ARKESEL_*`, `HUBTEL_*`                                                                       | SMS                                                      |
| `EMAIL_PROVIDER`, `SMTP_*`, `MAILHOG_*`, `STAGING_EMAIL_REDIRECT`                                                                             | Email                                                    |
| `WHATSAPP_PROVIDER`, `WHATSAPP_API_KEY`, `WHATSAPP_PHONE_NUMBER_ID`                                                                           | WhatsApp                                                 |
| `STORAGE_DRIVER`, `STORAGE_LOCAL_PATH`, `UPLOAD_MAX_BYTES`                                                                                    | File storage                                             |
| `RATE_LIMIT_*`                                                                                                                                | Per-surface rate limits                                  |
| `SEED_DEMO_DATA`, `DEMO_ADMIN_EMAIL`, `DEMO_ADMIN_PASSWORD`                                                                                   | Local/demo only                                          |
| `RENDER_GIT_COMMIT`, `GIT_COMMIT`                                                                                                             | Release identification — set automatically on Render     |

**Obtaining access.** Ask the product owner for an invitation to each service console (Render, Netlify, Supabase, Paystack, Whereby, the SMS provider) rather than for the values. Read production secrets from the Render dashboard when you need them, and do not copy them into the repository, a chat, or a shared document. If a secret is ever printed into a terminal transcript, treat it as leaked and rotate it — this happened once during this work with the staging database password, which is why it is on the rotation list in §8.

---

## 6. Operations and troubleshooting runbook

### The tools, and exactly what they do

**Classify by reading, not by grepping for Prisma writes.** `close-stale-demo-queue.ts` contains no direct write call and is nevertheless mutating, because it goes through `transition()`.

| Tool                          | Command                                                                        | Reads / writes                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Reconciliation report         | `npm run reconcile:consultations -- --env <file> [--reference <ref>] [--json]` | **Read-only.** One write call exists, inside `repair()`, reachable only with `--apply` _(verified by reading)_ |
| …repair mode                  | `… --apply`                                                                    | **MUTATING.** Repairs unambiguous cases only; refuses mixed evidence                                           |
| Sweep forecast                | `npm run sweep:preview`                                                        | **Read-only.** Predicts what the three sweeps would do                                                         |
| Consultation verifier         | `npm run verify:consultation -- --env <file> --reference <ref>`                | **Read-only.** PASS/FAIL assertions per outcome                                                                |
| Professional check            | `npm run doctor:check`                                                         | **Read-only**                                                                                                  |
| Production config check       | `check-production-config.ts`                                                   | **Read-only**                                                                                                  |
| Whereby credential check      | `npm run whereby:check [-- --keep] [-- --delete <id>]`                         | **Read-only against Neem; WRITES to Whereby** — creates and deletes a real meeting. Never prints the key       |
| SMS / SMTP checks             | `npm run arkesel:check`, `hubtel:check`, `smtp:check`                          | **Send a real message.** Treat as outward-facing                                                               |
| Supabase check                | `npm run check:supabase`                                                       | Mostly read; verify before using on production                                                                 |
| Close stale demo queue        | `close-stale-demo-queue.ts`                                                    | **MUTATING** — transitions consultations                                                                       |
| Membership grace              | `grant-membership-grace.ts`                                                    | **MUTATING**                                                                                                   |
| Create admin / reset demo 2FA | `admin:create`, `db:reset-2fa`                                                 | **MUTATING**                                                                                                   |
| Backup / restore              | `npm run backup`, `restore`, `backup:rehearse`                                 | Backup reads; **restore writes**                                                                               |

The `--env <file>` convention loads a named dotenv file, so a production run names its file explicitly rather than picking one up by accident.

**What a reconciliation result proves.** It proves what the _database_ shows: state, deadlines, and which evidence bucket a consultation falls into (`CARE_DELIVERED` / `JOINED_ONLY` / `NO_EVIDENCE`). It does **not** prove anything about what happened on the call, whether media actually connected, or whether a patient was satisfied. Remember that a `CLIENT` `JOINED` means a page asked for a credential.

### Scenario: a paid patient is missing from the professional's queue

1. Find the consultation and its state history (`verify:consultation`, read-only).
2. Was payment actually confirmed? `PAID` requires a verified webhook — an unconfirmed payment never admits to the queue.
3. Is it `WAITING_FOR_DOCTOR`, or stuck earlier (`WAITING_FOR_PATIENT`, `PATIENT_JOINED`)? The patient must complete identity, language and mode.
4. Is **anyone on duty**? This is the most common answer. A professional needs `ACTIVE` status, a usable subscription, a valid licence, **a `CONFIRMED` shift covering now**, presence online, the right language, and spare capacity. Shift coverage is evaluated in **UTC** (= Accra), and the NIGHT band (20:00–08:00) ships **inactive**, so outside 08:00–20:00 nobody can be on duty until an admin enables it.
5. For a scheduled booking, check `open-due-appointments` has run and `admit-stranded-bookings` has not had to.

### Scenario: a professional shows as busy when they look available

1. Read their presence: `currentLoad` / `maxLoad`.
2. List consultations in `DOCTOR_ACCEPTED`, `IN_PROGRESS` or `COMPLETING` for that professional — those are the only states that occupy a slot.
3. On staging (D66) the queue banner names them with a link. On production it does not yet, so this is a database question.
4. If `currentLoad` disagrees with the actual count, `reconcile-doctor-load` recomputes it from the same definition; it runs on the scheduler.
5. If a consultation is genuinely stuck, check how long: production sweeps an inactive one at 120 minutes, staging at 15 after an explicit `LEFT`. **Before concluding it is stuck, check whether the threshold has actually elapsed** — this has been misdiagnosed before.

### Scenario: a patient cannot rejoin

1. Check the state. Rejoin is allowed in `DOCTOR_ACCEPTED`, `IN_PROGRESS` and `INTERRUPTED`.
2. Check `rejoinableUntil` and `unservedDeadlineAt`. Past either, the join is refused by design and the patient is told the consultation will be arranged rather than charged again.
3. Check whether `patientReturnedAt` is set — if so the return was registered and the professional has been notified.
4. If the room itself is the problem, go to the next scenario.

### Scenario: a Whereby or room-connection failure

1. **Does the consultation have a `MediaSession` row?** None at all means room creation failed; a row with a `providerRoomRef` means the room exists and the problem is later.
2. Run `npm run whereby:check` to test the credential against the live API (creates and deletes a real meeting).
3. Read the API logs and search **`unhandled error`** on production, or **`provider unavailable`** once D68 is deployed. Do not search for "Whereby" — the adapter uses Whereby's own words.
4. Distinguish: API refusal (401/402/403/429) vs `could not be reached` (network) vs `did not respond in time` (timeout).
5. Expect a 500 on production and a 503 `PROVIDER_UNAVAILABLE` on staging — the same underlying failure.

### Scenario: an unfinished or expired consultation

1. `verify:consultation` for the full picture.
2. `sweep:preview` to see what the sweeps would do next, before they do it.
3. Decide from the evidence bucket, not the state alone: `NO_EVIDENCE` and `CARE_DELIVERED` deserve different refund outcomes.
4. Only use `reconcile:consultations --apply` for unambiguous cases, and only with explicit authorisation.

### Scenario: a pending, failed or duplicate refund

1. List refunds by state. A refund raised by a sweep is `REQUESTED` and waits for a human.
2. Exactly one refund per abandoned consultation is the invariant — more than one is a bug worth reporting.
3. Refunds are the one money path that calls Paystack. Payouts are **recorded, not transferred**.
4. Never process a refund without the product owner's explicit instruction.

### Scenario: background jobs not running

1. The scheduler is **skipped entirely when `NODE_ENV === 'test'`** — check the environment first.
2. Every job first runs **after** one interval, not at boot, so a service restarted a minute ago has run nothing.
3. `sweep:preview` shows what the sweeps _would_ do; if its forecast is non-empty and nothing is changing, the scheduler is not running.
4. Check the API process is actually up (`/health/ready`), since the jobs live inside it.

### Scenario: missed notifications or real-time updates

1. Notifications are durable rows with a `retry-notifications` job — check the `Notification` table before suspecting the provider.
2. **Socket events are never the source of truth.** If a UI is stale, the question is whether the underlying column is set, not whether the event fired.
3. For SMS, `arkesel:check` / `hubtel:check` send a real message — use deliberately.

### Escalation and the separation that matters

Keep diagnosis and repair apart:

- **Diagnosis** is read-only and needs no authorisation: `verify:consultation`, `reconcile:consultations` without `--apply`, `sweep:preview`, database reads.
- **Repair** on production — `--apply`, any mutating script, a refund, a settings change — needs the product owner's explicit instruction for that specific action, and should be preceded by a read-only preview of exactly what it will touch.

Prefer letting a sweep do the work over a manual repair: the sweep is the code path that will run again anyway.

---

## 7. Security, privacy and testing

### Authentication and authorization

| Surface                       | Mechanism                                                                                                             |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Admin, professional, pharmacy | Email + password, session cookie. **2FA mandatory for `ADMIN`**, opt-in otherwise _(verified: `auth.service.ts:127`)_ |
| Patient (counter)             | A one-time QR token exchanged for a short-lived, **device-bound** session                                             |
| Patient (v2)                  | Phone number + one-time code (`PatientAuthCode`) → `PatientAccountSession`                                            |
| All mutating requests         | CSRF: the browser echoes the CSRF cookie in a header                                                                  |
| Brute force                   | `LOGIN_MAX_ATTEMPTS` / `LOGIN_LOCKOUT_MINUTES`, plus per-surface rate limits                                          |

Role boundaries are enforced in route pre-handlers on the API. **Implemented and verified by reading**; not independently penetration-tested.

### Clinical data

- **Sealing.** A finished consultation's clinical record is sealed; the error handler maps the sealed case centrally to **403 with the rule stated**, rather than letting it surface as a 500.
- **One door.** Clinical tables are reached only through `clinical-record.service.ts`. A past change queried the notes table directly to answer a yes/no question and broke retention guarantees; the fix was a `hasClinicalContent` helper that counts and never returns content.
- **Access logging.** `ClinicalRecordAccessLog`, `DisclosureLog` and `Consent` exist as first-class tables.
- **Retention** is enforced by the `purge-expired-clinical-records` job, not by policy alone. `docs/data-retention.md` is the specification.

### Secrets and logging

- Whereby room URLs are **bearer credentials**, stored encrypted (`roomUrlEnc`, `hostRoomUrlEnc`) and never logged, never audited, never returned to the wrong participant.
- Provider error paths quote status codes and the provider's words, **never a URL** — deliberate, and worth preserving when you touch those adapters.
- Field encryption supports rotation via `ENCRYPTION_KEY_PREVIOUS`.
- A separate restricted database role exists for audit (`AUDIT_DATABASE_URL`, `db:grants`).

### Minimisation

Video participants are labelled "Patient" and "Doctor" — the professional learns who the patient is from the clinical record, not a video tile. Notifications carry a consultation reference and nothing else, because a lock screen is not the place for a name or a symptom.

### Known security concerns

| Concern                                                     | Status                                                                                                                                                                                      |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Staging database password printed into a working transcript | **Must be rotated**                                                                                                                                                                         |
| Whereby API key rotation                                    | Outstanding task; also a candidate cause of the 7 Oct incident                                                                                                                              |
| `WHEREBY_WEBHOOK_SECRET`                                    | Previously noted as unset. **Evidence contradicts a total absence**: 14 webhook events have been received and recorded. Verify the current production value rather than assuming either way |
| Local disk storage                                          | `STORAGE_DRIVER` is local; a single copy on the host                                                                                                                                        |
| No penetration test                                         | None recorded                                                                                                                                                                               |

### Regulatory and clinical questions — open, not settled

These are awaiting qualified review and are **not** engineering decisions. Nothing here should be read as legal advice or as a conclusion: HeFRA registration, Medical and Dental Council obligations, Pharmacy Council requirements, Data Protection Commission registration, processor agreements with each provider, Bank of Ghana questions on the payment flow, and professional indemnity. A retention brief for counsel is outstanding.

### Test coverage matrix

| Journey / behaviour                                            | Covered | Where                                            | Gaps                                |
| -------------------------------------------------------------- | ------- | ------------------------------------------------ | ----------------------------------- |
| Pharmacy counter: create → pay → QR → consult                  | Yes     | Integration                                      | —                                   |
| Patient-direct immediate booking                               | Yes     | Integration                                      | —                                   |
| Scheduled appointments: reserve, pay, open, expire, release    | Yes     | `v2-appointments`                                | **One flaky test**                  |
| Payment callbacks / webhook verification                       | Yes     | Payment integration                              | —                                   |
| Concurrent booking of one slot                                 | Yes     | Appointment tests                                | —                                   |
| Queue scoring and the hard gates                               | Yes     | Domain unit tests                                | —                                   |
| Capacity claim and release                                     | Yes     | Lifetime + recovery suites                       | —                                   |
| Disconnect, interrupt, resume                                  | Yes     | `call-recovery.test.ts`                          | **No two-browser run**              |
| Patient-first rejoin and professional notification             | Yes     | `patient-return.test.ts`                         | **No two-browser run**              |
| Professional-left thresholds, flapping, budget cap             | Yes     | `consultation-lifetime.test.ts` (37 cases)       | Not exercised live                  |
| Provider outage → 503                                          | Yes     | `call-recovery.test.ts`, 1 regression + 2 guards | —                                   |
| Expiry, abandonment, exactly-one refund                        | Yes     | Lifetime suite                                   | —                                   |
| Refund approval / rejection                                    | Partial | Refund tests                                     | End-to-end with Paystack unverified |
| Access between accounts (one patient reading another's record) | Partial | Retention/clinical tests                         | Deserves explicit adversarial tests |
| Clinical sealing and retention purge                           | Yes     | `retention.test.ts`                              | —                                   |
| Real audio/video quality                                       | **No**  | —                                                | Needs real devices                  |

**Tests that cannot be automated here and must be done by hand:**

- Two browser sessions, patient and professional, with a **real disconnection** (close the tab, kill the network, flight mode).
- Multiple tabs for one professional, to confirm closing one does not interrupt.
- Real audio and video on a real phone on Ghanaian mobile data.
- The Whereby room URLs opened by two different people at once (`whereby:check -- --keep` produces a room that stays up for this).

---

## 8. Handover priorities

### Prioritised unresolved work

**P0 — Verify D72 on staging, then deploy it** (presence, Resume, patient re-entry, and the payment wording). All four were reported from the live pilot and all four are fixed locally but unverified by hand.
_Acceptance:_ a doctor stays online across the consultation, earnings and queue screens for ten quiet minutes, and stays offline after declaring a break with the tab left open; Resume works from the consultation page and from the dashboard; a patient who closes the tab gets back in both ways — the counter issues a fresh code mid-consultation, and reopening the site offers "Rejoin"; the counter sees "The patient has left the call"; no screen on the counter side mentions paying.

**P1 — Decide the eight `REQUESTED` refunds.** Product-owner decisions, not engineering.

**P2 — Rotate the staging database password.** It was leaked into a transcript and is still live. The Whereby API key has been rotated.

**P3 — Complete the manual staging verification of interruption recovery** (D66–D68, deployed 15 Oct but never exercised end to end).
_Acceptance:_ two browsers, a real disconnection; slot released on time; patient can return first and the professional is notified; resuming leaves no stale deadline; a second break does not renew the budget.

**P4 — Fix the misleading outage UI** — Reconnect that cannot work, and "You are in the room" when no room exists. This is the last unfixed item from the 7 October incident.

**P5 — Diagnose the flaky `v2-appointments` test.**

**P6 — Confirm what `WHEREBY_WEBHOOK_SECRET` actually is in production.** Never verified.

**P7 — Diary the end of the free pilot, around 14 January 2027.** Nothing resumes charging by itself; someone must set `consultation.feeEnabled.counter` back to `true`. Deliberate (D69) — but it is a diary entry, not a code path.

**P8 — Reconcile the marketing site's prices with production.** The site says GH₵50 to book yourself; production charges GHS 1. It has been out of step independently of all of the above.

### Immediate investigation priorities, week one

1. Read `docs/decision-log.md` D57 and D61–D72 — the whole recovery and presence story, with reasoning. D72 is the most recent and the least verified.
2. Reconcile production read-only and look at every open consultation.
3. Confirm what `WHEREBY_WEBHOOK_SECRET` actually is in production.
4. Check that the Whereby credential warning job is actually running, and that it reports "no expiry" rather than throwing — the replacement key carries a sentinel `exp`.

### Design decisions worth understanding before changing anything

| Decision                                        | Why                                                                                                                     |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| One `transition()` for every state change       | Timestamps, capacity and flags are set in one place or they drift                                                       |
| Durable facts over events                       | A socket event reaches nobody who is offline, reloading or on another page                                              |
| Deadlines stored, not recomputed                | A rejoin must not be able to extend a consultation's life                                                               |
| `firstInterruptedAt` never cleared              | Makes clearing the current deadline safe instead of a loophole                                                          |
| Silence and `LEFT` treated differently          | Talking is not recorded, so silence is ambiguous; `LEFT` is not                                                         |
| Room deadline checked before the room is opened | A room URL is a bearer credential; the harm is its existence                                                            |
| Payouts recorded, not transferred               | Deliberate: no code moves money out                                                                                     |
| Presence declared, not detected                 | A sleeping laptop is not a decision; a break is (D72)                                                                   |
| A patient leaving is not a patient abandoning   | Only a professional or a sweep ends a consultation; every re-entry fix works with that rule rather than around it (D72) |
| The fee waiver decided at creation, not payment | A waived consultation is `ACTIVATED` before its creation transaction commits, so no other path can charge it (D69)      |
| Adapters with mocks, selected by env            | Business logic never learns which provider it has                                                                       |

### Open questions for the product owner

1. What is the schedule for setting real prices during the pilot, and who approves each one? Prices are expected to be set progressively, service by service, so the team needs to know who decides and how a change is recorded.
2. When should public booking and testing prices end, and what governs the switch to commercial pricing?
3. Who decides refunds, and within what service level?
4. Is the 30-minute total recovery window right for Ghanaian conditions, or should it be longer on a power cut?
5. Should the NIGHT shift band be activated, and is out-of-hours cover intended at all?
6. What is the plan for `Call Me`, given no PSTN provider exists?

### Accounts and access required (no credentials in this document)

Render · Netlify · Supabase (production and staging projects) · Paystack · Whereby · Arkesel and/or Hubtel · SMTP provider · GitHub · Lovable · the domain registrar/DNS.

### First-week checklist

- [ ] Accounts above, read-only where possible to start
- [ ] `npm run setup`, then `npm run dev`; book a consultation end to end locally
- [ ] `npm test` green locally
- [ ] Read `docs/decision-log.md` D57, D61–D68, and `docs/architecture.md` (note its stale header)
- [ ] Read `apps/api/src/domain/consultation-state.ts` and `consultation.service.ts` `transition()`
- [ ] Run `reconcile:consultations` against **staging**, read-only, to learn the tool safely
- [ ] Confirm which commit each environment runs via `/health`
- [ ] Shadow one real consultation end to end
- [ ] Take the P0 Whereby item

---

## 9. Documentation map, and its caveats

| Document                    | Lines | Use it for                                                                     |
| --------------------------- | ----- | ------------------------------------------------------------------------------ |
| `docs/decision-log.md`      | 2,320 | **The most valuable document.** D1–D68, each with the problem that produced it |
| `docs/roadmap.md`           | 939   | Where the product is going                                                     |
| `docs/api.md`               | 663   | Endpoint reference                                                             |
| `docs/data-retention.md`    | 322   | Retention rules                                                                |
| `docs/database.md`          | 281   | Schema notes                                                                   |
| `docs/architecture.md`      | 273   | System shape — **header is stale**                                             |
| `docs/security.md`          | 258   | Controls                                                                       |
| `docs/launch-runbook.md`    | 180   | Launch procedure                                                               |
| `docs/consultation-flow.md` | 134   | The journey                                                                    |
| `docs/queue-engine.md`      | 106   | Allocation and scoring                                                         |
| `docs/staging.md`           | 104   | Staging specifics                                                              |
| `docs/product-backlog.md`   | 79    | Backlog                                                                        |

**Caveat.** `docs/architecture.md` still opens with _"Status: Proposed (Phase 0). Not yet implemented."_ That is wrong — the system is built and live. The body is broadly accurate; the header is not. Worth correcting early, since it is the first thing a new engineer reads.

Code comments cite decisions as `(D57)`, `(D63)`. Three such references once pointed at entries that did not exist; they have been written. **Keep that invariant**: never leave a `(Dnn)` reference dangling, and add an entry when you make a decision of similar weight.

---

## 10. Glossary

| Term                    | Meaning                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------ |
| **Consultation**        | The central record: one patient, one professional, one paid encounter                            |
| **Channel**             | `COUNTER` (via a pharmacy) or `DIRECT` (patient booked themselves, v2)                           |
| **v2 / patient-direct** | The journey where a patient books on their own phone                                             |
| **Professional**        | Any of doctor, dietitian or trainer. Stored in the `Doctor` table regardless                     |
| **Discipline**          | `DOCTOR`, `DIETITIAN` or `TRAINER`                                                               |
| **Clinic**              | `GENERAL` or `WEIGHT_LOSS` — how services are grouped for a patient                              |
| **Occupying state**     | `DOCTOR_ACCEPTED`, `IN_PROGRESS`, `COMPLETING` — the states that hold a professional's slot      |
| **Offer / assignment**  | The allocator proposing a consultation to a professional, with a response window                 |
| **Presence**            | A professional being online, with `currentLoad` against `maxLoad`                                |
| **Shift band**          | `MORNING` / `AFTERNOON` / `NIGHT`, evaluated in UTC (= Accra)                                    |
| **Interruption**        | A broken call; recoverable, not a failure                                                        |
| **Recovery window**     | `rejoinableUntil` — how long the current break may last                                          |
| **Recovery budget**     | `firstInterruptedAt` + `maxRecoveryTotalMinutes` — the cap across all breaks                     |
| **Unserved deadline**   | `unservedDeadlineAt` — when a consultation stops being worth waiting for (24h)                   |
| **Sweep**               | A scheduled job that moves consultations the world has stopped touching                          |
| **Evidence bucket**     | `CARE_DELIVERED` / `JOINED_ONLY` / `NO_EVIDENCE` — what the record can show about a consultation |
| **Attendance event**    | `JOINED` / `LEFT` per participant, from `CLIENT` (the page) or `WEBHOOK` (Whereby)               |
| **Dnn**                 | A numbered entry in `docs/decision-log.md`                                                       |
| **Minor units**         | Money in the smallest unit — `priceMinor: 100` is GHS 1.00                                       |
| **bp (basis points)**   | Hundredths of a percent — `3000` is 30%                                                          |
