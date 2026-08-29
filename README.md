# Neem

Pharmacy-based telemedicine for Ghana. Patients at a participating pharmacy consult a licensed doctor by audio, video, or a platform-placed call, and receive an electronic prescription dispensed on the spot.

> **Status: Phase 1 (Foundation) in progress.** Phase 0 discovery is complete — see [`docs/phase-0-findings.md`](docs/phase-0-findings.md). Phases 2–11 are not built yet; [`docs/roadmap.md`](docs/roadmap.md) says what exists and what does not.

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
                       temporary clinical data DELETED at completion
receive prescription ◀──────────────────────────────────────────────┘
propose substitution ─▶ doctor approves/rejects ─▶ dispense
```

Four interfaces, one application: **Patient**, **Pharmacy**, **Doctor**, **Neem Administration**.

Two rules shape almost every design decision:

1. **Clinical information exists only for the duration of the consultation.** Notes, diagnosis, treatment, vitals and test results are hard-deleted the moment the doctor completes. Prescriptions and referrals are the only carry-forwards, because a doctor deliberately issued them as documents. See [`docs/data-retention.md`](docs/data-retention.md).
2. **Business rules live on the server.** The web app decides what to render; the API decides what is allowed. See [`docs/security.md`](docs/security.md).

---

## Architecture

A modular monolith — two processes, one database.

| Part | Stack |
| --- | --- |
| `apps/web` | TanStack Start, React 19, TypeScript, Tailwind v4, shadcn/ui — the original Lovable design, preserved |
| `apps/api` | Node 22+, Fastify, TypeScript, Prisma, Socket.IO |
| `packages/contracts` | zod schemas and types shared by both, so client and server validation cannot drift |
| Database | MySQL 8 |

Full detail: [`docs/architecture.md`](docs/architecture.md).

---

## Setup

### Prerequisites

- **Node.js 22 or later**
- **Docker Desktop** (provides MySQL, MailHog, Adminer)

### First run

```bash
git clone <repository> neem && cd neem
cp .env.example .env
npm install
npm run docker:up
npm run db:migrate
npm run db:seed
npm run dev
```

- Web: <http://localhost:3000>
- API: <http://localhost:4000>
- Mail (MailHog): <http://localhost:8025>
- Adminer (optional): `docker compose -f docker/docker-compose.yml --profile tools up -d` → <http://localhost:8080>

`npm run setup` does the install, containers, migration, and seed in one step.

### Demo accounts

Printed by `npm run db:seed`. Every seeded row carries `isDemo: true`, and the API refuses to start in production with `SEED_DEMO_DATA=true`.

| Role | Email | Note |
| --- | --- | --- |
| Admin | `admin@neem.demo` | Must enrol TOTP two-factor on first sign-in — it cannot be skipped |
| Pharmacy | `akosua@pharmacy.demo` | ACTIVE |
| Pharmacy | `healthfirst@pharmacy.demo` | ACTIVE — second tenant, for isolation tests |
| Pharmacy | `tamale@pharmacy.demo` | PENDING — exercises the approval queue |
| Doctor | `ama@doctor.demo` | ACTIVE — English, Twi, Ga |
| Doctor | `kwame@doctor.demo` | ACTIVE — English, Twi |
| Doctor | `efua@doctor.demo` | PENDING — exercises credential verification |

Passwords are printed by the seed. **These are demonstration credentials and must never exist in production.**

---

## Commands

| Command | Does |
| --- | --- |
| `npm run dev` | Web and API together |
| `npm run dev:api` / `npm run dev:web` | One at a time |
| `npm test` | Unit and integration tests (Vitest) |
| `npm run test:e2e` | End-to-end tests (Playwright) |
| `npm run typecheck` | TypeScript across all workspaces |
| `npm run lint` / `npm run format` | ESLint / Prettier |
| `npm run db:migrate` | Apply migrations |
| `npm run db:reset` | Drop, re-migrate, re-seed |
| `npm run db:studio` | Prisma Studio |
| `npm run docker:up` / `docker:down` / `docker:reset` | Local services |

---

## Environment

Every variable is documented in [`.env.example`](.env.example). Configuration is validated with zod at boot.

**In production the API refuses to start** when a required credential is missing, when a secret still holds its development placeholder, when any provider is set to `mock`, or when `SEED_DEMO_DATA=true`. A half-configured payment provider is worse than a refusal to boot.

**In development**, providers default to mock adapters. Mock mode is reported by `/api/v1/health/ready`, stamped on every log line, and surfaced in the admin UI — the system never claims a payment, call, or message occurred when it cannot verify it.

### External integrations

| Concern | Provider | Status |
| --- | --- | --- |
| Payments | Paystack | Interface + mock adapter; live integration in Phase 7 |
| Video | Twilio Video | Interface + mock adapter; **verify Twilio's current roadmap before Phase 5** — see [`docs/phase-0-findings.md`](docs/phase-0-findings.md) C9 |
| Voice (Call Me) | Twilio Voice | Interface + mock adapter; Phase 5 |
| SMS / Email / WhatsApp | Not yet selected | Abstraction only; provider chosen in Phase 8 |

Each sits behind an interface in `apps/api/src/adapters/`, so changing provider changes one adapter, not the business logic.

**Consultations are never recorded.** This is structural, not configuration: the video adapter has no code path that can enable recording, `media_sessions.recordingEnabled` defaults false, and a test asserts both.

---

## Documentation

| Document | Contents |
| --- | --- |
| [`docs/phase-0-findings.md`](docs/phase-0-findings.md) | What the Lovable prototype was, ten conflicts found, decisions taken |
| [`docs/architecture.md`](docs/architecture.md) | Modules, layering, providers, folder structure, deployment path |
| [`docs/database.md`](docs/database.md) | Full schema with a retention class on every table |
| [`docs/api.md`](docs/api.md) | REST surface, envelope and error conventions |
| [`docs/security.md`](docs/security.md) | Auth design, token design, RBAC, controls, test plan |
| [`docs/data-retention.md`](docs/data-retention.md) | What is deleted, what is kept, how deletion is proved |
| [`docs/consultation-flow.md`](docs/consultation-flow.md) | Consultation state machine and failure handling |
| [`docs/queue-engine.md`](docs/queue-engine.md) | Smart allocation scoring and the 90-second window |
| [`docs/payment-flow.md`](docs/payment-flow.md) | Paystack sequence, idempotency, revenue split, refunds |
| [`docs/decision-log.md`](docs/decision-log.md) | Engineering decisions with rationale |
| [`docs/product-backlog.md`](docs/product-backlog.md) | MVP scope fence |
| [`docs/roadmap.md`](docs/roadmap.md) | Phases 1–11 |
| [`docs/compliance/`](docs/compliance/) | Ghanaian regulatory research — **all entries UNVERIFIED, not legal advice** |

---

## Compliance note

Neem is intended to process real patient information in Ghana. The compliance folder identifies candidate regulatory instruments and the questions a lawyer must answer. **Nothing in it has been verified**, no application behaviour depends on an unverified regulatory assumption, and the product makes no claim of regulatory approval or endorsement.

The highest-impact open question is whether Ghanaian law sets a **minimum retention period for medical consultation records**. If one exists, the delete-at-completion design must change, and that change is architectural. It is flagged now precisely so it does not surface late.

---

## Licence

Proprietary. © 2026 Neem Health.
