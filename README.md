# Neem

Pharmacy-based telemedicine for Ghana. Patients at a participating pharmacy consult a licensed doctor by audio, video, or a platform-placed call, and receive an electronic prescription dispensed on the spot.

> **Status: Phases 0–10 complete. Phase 11 (demo readiness) in progress.** [`docs/roadmap.md`](docs/roadmap.md) records what each phase built and what it found.

---

## What Neem does

```
PHARMACY               PATIENT (own phone)      NEEM              DOCTOR
create consultation ─▶ pay ─▶ QR ─▶ scan ─▶ name/age/sex/phone
                              language ─▶ audio | video | Call Me
                                       └─▶ smart queue ──────────▶ 90s to accept
                                            consultation ◀───────▶ conduct
                                                        outcome ◀─ prescription
                                                                   referral
                       clinical record SEALED at completion, destroyed at
                       the end of its retention period — see below
receive prescription ◀──────────────────────────────────────────────┘
propose substitution ─▶ doctor approves/rejects ─▶ dispense
```

Four interfaces, one application: **Patient**, **Pharmacy**, **Doctor**, **Neem Administration**.

Two rules shape almost every design decision:

1. **A clinical record is sealed at completion, not deleted.** The original design deleted notes, diagnosis, vitals and test results the moment the doctor finished. Counsel established that a medical record must be retained for a statutory period, so **decision [D23](docs/decision-log.md)** replaced deletion with sealing: the record persists, **no role can read it** — not the doctor who wrote it, not the pharmacy, not an administrator — and it is destroyed automatically at the end of its retention period. The patient leaves with a consultation reference ([D24](docs/decision-log.md)), which is the only route back to their own record, and a narrow, four-eyes, audited retrieval path exists for a lawful demand ([D27](docs/decision-log.md)). See [`docs/data-retention.md`](docs/data-retention.md).

2. **Business rules live on the server.** The web app decides what to render; the API decides what is allowed. Every rule the UI appears to apply is enforced again at the boundary, and `security.test.ts` sweeps the live router on every run to prove no route answers a stranger. See [`docs/security.md`](docs/security.md).

---

## Architecture

A modular monolith — two processes, one database.

| Part                 | Stack                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------ |
| `apps/web`           | TanStack Start, React 19, TypeScript, Tailwind v4 — the original Lovable design, preserved |
| `apps/api`           | Node 22+, Fastify, TypeScript, Prisma, Socket.IO                                           |
| `packages/contracts` | zod schemas and types shared by both, so client and server validation cannot drift         |
| Database             | MySQL 8                                                                                    |

Full detail: [`docs/architecture.md`](docs/architecture.md).

---

## Setup

### Prerequisites

- **Node.js 22 or later**
- **Docker Desktop** (provides MySQL and MailHog)

### First run

```bash
git clone <repository> neem && cd neem
cp .env.example .env
npm run setup
npm run dev
```

`npm run setup` installs, starts the containers, migrates and seeds. The individual steps are `npm install`, `npm run docker:up`, `npm run db:migrate`, `npm run db:seed`.

| Service            | URL                                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------- |
| Web                | <http://localhost:8080>                                                                       |
| API                | <http://localhost:4000>                                                                       |
| Mail (MailHog)     | <http://localhost:8025>                                                                       |
| Adminer (optional) | <http://localhost:8081> — `docker compose -f docker/docker-compose.yml --profile tools up -d` |

### Demo accounts

Printed by `npm run db:seed`. Every seeded row carries `isDemo: true` and a `.demo` email address, so demo and production data cannot be confused (spec §76). The seed refuses to run when `NODE_ENV=production`, and the config loader independently rejects `SEED_DEMO_DATA=true` there.

| Role     | Email                       | Note                                                               |
| -------- | --------------------------- | ------------------------------------------------------------------ |
| Admin    | `admin@neem.demo`           | Must enrol TOTP two-factor on first sign-in — it cannot be skipped |
| Pharmacy | `akosua@pharmacy.demo`      | ACTIVE — can initiate consultations                                |
| Pharmacy | `healthfirst@pharmacy.demo` | ACTIVE — second tenant, for isolation                              |
| Pharmacy | `kumasi@pharmacy.demo`      | ACTIVE                                                             |
| Pharmacy | `tamale@pharmacy.demo`      | PENDING — exercises the approval queue                             |
| Doctor   | `ama@doctor.demo`           | ACTIVE — English, Twi, Ga                                          |
| Doctor   | `kwame@doctor.demo`         | ACTIVE — English, Twi                                              |
| Doctor   | `efua@doctor.demo`          | PENDING — exercises credential verification                        |

Passwords are printed by the seed. **These are demonstration credentials and must never exist in production.**

**The admin's second factor is unrecoverable by design.** Once enrolled, its secret cannot be read back, so an automated run cannot sign in as that admin. `npm run db:reset-2fa` clears enrolment for demo administrators only, and is required before an end-to-end run that exercises the enrolment journey.

---

## Commands

| Command                                              | Does                                                               |
| ---------------------------------------------------- | ------------------------------------------------------------------ |
| `npm run dev`                                        | Web and API together                                               |
| `npm run dev:api` / `npm run dev:web`                | One at a time                                                      |
| `npm test`                                           | Unit and integration tests (Vitest, against a real MySQL database) |
| `npm run test:e2e`                                   | End-to-end tests (Playwright)                                      |
| `npm run typecheck`                                  | TypeScript across all workspaces                                   |
| `npm run lint` / `npm run format`                    | ESLint / Prettier                                                  |
| `npm run db:migrate`                                 | Apply migrations                                                   |
| `npm run db:reset`                                   | Drop, re-migrate, re-seed                                          |
| `npm run db:seed`                                    | Reference and demo data                                            |
| `npm run db:reset-2fa`                               | Clear demo admin TOTP enrolment                                    |
| `npm run db:studio`                                  | Prisma Studio                                                      |
| `npm run backup`                                     | Encrypted database backup                                          |
| `npm run restore -- <file>`                          | Restore one, verifying its signature first                         |
| `npm run backup:rehearse`                            | Back up, restore to a scratch database, compare row by row         |
| `npm run docker:up` / `docker:down` / `docker:reset` | Local services                                                     |

### Testing notes

`npm test` runs against a real MySQL database (`neem_test`), not mocks — a large part of what it verifies lives in the database itself: unique constraints, foreign keys, transactional atomicity. It takes roughly 45 minutes.

`npm run test:e2e` drives the running dev server. Because that server watches for file changes, **anything that touches the working tree during a run — an editor save, a `git checkout`, a merge — restarts the API and fails tests that were not broken.** Run it against a quiet tree.

---

## Environment

Every variable is documented in [`.env.example`](.env.example). Configuration is validated with zod at boot.

**In production the API refuses to start** when a required credential is missing, when a secret still holds its development placeholder, when any provider is set to `mock`, or when `SEED_DEMO_DATA=true`. A half-configured payment provider is worse than a refusal to boot.

**In development**, providers default to mock adapters. Mock mode is stamped on every log line and shown on the admin dashboard, so the system never claims a payment, call, or message occurred when it cannot verify it. The unauthenticated readiness probe deliberately does _not_ report it — which providers a deployment uses is configuration, and `GET /admin/system-health` is where an administrator sees it.

### External integrations

Each sits behind an interface in `apps/api/src/adapters/`, so changing provider changes one adapter, not the business logic. Development defaults to the mock in every case.

| Concern        | Provider               | Adapter                                                                                                                                                          |
| -------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Payments       | Paystack               | **Built.** HMAC verified over the raw body, before parsing, idempotent                                                                                           |
| SMS / WhatsApp | Twilio                 | **Built**                                                                                                                                                        |
| Email          | SMTP (MailHog locally) | **Built**                                                                                                                                                        |
| Storage        | Local filesystem       | **Built**                                                                                                                                                        |
| Video / voice  | Twilio                 | **Interface and mock only.** Selecting `twilio` throws at boot with a message saying the adapter is not implemented — it does not silently fall back to the mock |

The media flows are complete either side of that boundary: joining, rejoining, the timer, and Call Me bridging without exposing either party's number all work against the mock, and the real adapter is a drop-in. But a demonstration runs on simulated media, and the screens say so rather than implying a call took place.

**Consultations are never recorded.** This is structural, not configuration: the video adapter has no code path that can enable recording, `media_sessions.recordingEnabled` defaults false, and a test asserts both.

---

## Documentation

| Document                                                 | Contents                                                                     |
| -------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [`docs/demonstration.md`](docs/demonstration.md)         | A 15-minute walkthrough of the full business cycle on a seeded machine       |
| [`docs/roadmap.md`](docs/roadmap.md)                     | Phases 0–11, what each built, and what building it exposed                   |
| [`docs/decision-log.md`](docs/decision-log.md)           | D1–D34, engineering decisions with their reasoning                           |
| [`docs/architecture.md`](docs/architecture.md)           | Modules, layering, providers, folder structure                               |
| [`docs/database.md`](docs/database.md)                   | Full schema with a retention class on every table                            |
| [`docs/api.md`](docs/api.md)                             | REST surface, reconciled against the live router and kept that way by a test |
| [`docs/security.md`](docs/security.md)                   | Auth design, RBAC, controls, and the §79 test plan                           |
| [`docs/data-retention.md`](docs/data-retention.md)       | What is kept, what is destroyed, how it is proved                            |
| [`docs/consultation-flow.md`](docs/consultation-flow.md) | Consultation state machine and failure handling                              |
| [`docs/queue-engine.md`](docs/queue-engine.md)           | Smart allocation scoring and the 90-second window                            |
| [`docs/payment-flow.md`](docs/payment-flow.md)           | Paystack sequence, idempotency, revenue split, refunds                       |
| [`docs/product-backlog.md`](docs/product-backlog.md)     | MVP scope fence and what is deliberately post-MVP                            |
| [`docs/phase-0-findings.md`](docs/phase-0-findings.md)   | What the Lovable prototype was, and the conflicts found in it                |
| [`docs/compliance/`](docs/compliance/)                   | Ghanaian regulatory research — **all entries UNVERIFIED, not legal advice**  |

---

## Compliance note

Neem is intended to process real patient information in Ghana. The compliance folder identifies candidate regulatory instruments and the questions a lawyer must answer. **Nothing in it has been verified**, no application behaviour depends on an unverified regulatory assumption, and the product makes no claim of regulatory approval or endorsement.

The retention question has been answered and the architecture changed because of it: records are retained and sealed rather than deleted at completion ([D23](docs/decision-log.md)), and a sealed archive with no clinician access was accepted as complying ([D27](docs/decision-log.md)).

**Five questions remain open with counsel**, tracked as G7a–G7f in [`docs/data-retention.md`](docs/data-retention.md) §10. Two of them are material to launch rather than to engineering:

- **G7d — the lawful basis and the required form of patient notice.** The product currently states no basis anywhere.
- **G7e — how a patient exercises access and erasure**, and how erasure interacts with a statutory retention duty. These usually conflict, and the resolution has to be written down.

The remainder concern the exact retention period (G7a), whether paediatric records carry a longer rule (G7b), and an acceptable backup window (G7f).

---

## Licence

Proprietary. © 2026 Neem Health.
