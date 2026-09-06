# Neem — Architecture

**Status:** Proposed (Phase 0). Not yet implemented.

---

## 1. Shape

A **modular monolith** with two deployable processes and one database.

```
                        ┌──────────────────────────────────────────┐
   Patient phone ──────▶│  web  — TanStack Start (SSR, React 19)   │
   Pharmacy browser ───▶│  Patient · Pharmacy · Doctor · Admin     │
   Doctor browser ─────▶│  portals, one app, role-based routing    │
   Admin browser ──────▶└────────────┬─────────────────────────────┘
                             REST/JSON │ Socket.IO
                        ┌─────────────▼────────────────────────────┐
                        │  api  — Node 22 + Fastify + TypeScript   │
                        │                                          │
                        │  HTTP layer   routes · validation · authz│
                        │  Service layer  business rules (the      │
                        │                 only place rules live)   │
                        │  Domain        state machines, scoring,  │
                        │                money, retention policy   │
                        │  Data layer    Prisma repositories       │
                        │  Adapters      provider interfaces       │
                        │  Jobs          scheduled + queued work   │
                        └───┬──────────────────────────┬───────────┘
                            │                          │
                  ┌─────────▼─────────┐     ┌──────────▼──────────────┐
                  │   MySQL 8         │     │  External providers     │
                  │   (Prisma)        │     │  Paystack   (payments)  │
                  └───────────────────┘     │  Whereby    (video/audio)│
                                            │  SMS/Email/WhatsApp     │
                                            └─────────────────────────┘
```

**Core Neem systems:** web, api, MySQL, the job runner.
**External services:** Paystack, Whereby, the notification providers.
**Temporary data:** patient sessions, clinical notes, vitals, point-of-care tests (see `data-retention.md`).
**Permanent data:** consultations (operational fields only), prescriptions, referrals, payments, revenue, feedback, audit logs.

### Why two processes rather than one

The Lovable app is a TanStack Start project whose Nitro build targets Cloudflare by default. The specification requires long-lived WebSockets, scheduled deletion jobs, raw-body webhook signature verification, Prisma against MySQL, and server-side PDF generation. Those want a long-running Node process, not an edge worker. Splitting them keeps the Lovable frontend untouched and gives the backend the runtime it actually needs.

### Why a modular monolith rather than microservices

Five pharmacies, 10–12 doctors, a one-month pilot. Microservices would add deployment, tracing, and consistency cost for no benefit. Modules communicate through **service interfaces only** — never by reaching into another module's Prisma models — so any module can later be lifted out behind an HTTP boundary without touching its callers.

---

## 2. Modules

Each is a folder under `apps/api/src/modules/<name>/` containing `*.routes.ts`, `*.service.ts`, `*.schema.ts` (zod), `*.repository.ts`, and tests.

| Module         | Owns                                                                                  |
| -------------- | ------------------------------------------------------------------------------------- |
| `auth`         | Login, logout, sessions, password reset, TOTP 2FA, rate limiting, lockout             |
| `identity`     | Users, roles, RBAC policy evaluation                                                  |
| `pharmacy`     | Pharmacy onboarding, profile, verification workflow, state machine                    |
| `doctor`       | Doctor onboarding, documents, credentials, licence tracking, signature, state machine |
| `scheduling`   | Shift definitions, shift assignment, confirmation, the 40-hour rule                   |
| `subscription` | Doctor six-month membership, renewal, expiry → suspension                             |
| `consultation` | Consultation lifecycle, state machine, access tokens, patient sessions, timer         |
| `queue`        | Smart allocation scoring, offers, the 90s window, reassignment, admin alerts          |
| `clinical`     | Vitals, point-of-care tests, clinical workspace, outcome capture                      |
| `prescription` | Prescription lifecycle, versions, PDF, verification, dispensing, substitution         |
| `referral`     | Referral creation and PDF                                                             |
| `payment`      | Paystack orchestration, webhooks, idempotency, refunds                                |
| `finance`      | Revenue allocation, pharmacy payouts, reconciliation, payroll calculation             |
| `feedback`     | Ratings, categories, complaints                                                       |
| `quality`      | Doctor performance events, weighted quality score                                     |
| `notification` | Template rendering, channel dispatch, delivery tracking                               |
| `analytics`    | Aggregations over retained data only                                                  |
| `settings`     | System settings, change history, admin safety confirmations                           |
| `audit`        | Append-only audit log writer and reader                                               |
| `retention`    | Deletion policy, purge execution, verification                                        |
| `realtime`     | Socket.IO server, room membership, event fan-out                                      |

### Cross-cutting

- `src/lib/` — logger (pino, redaction list), errors, result types, money, ids, crypto, clock (injectable, so time-based tests are deterministic).
- `src/middleware/` — request id, auth, RBAC guard, rate limiter, CSRF, validation, error handler.
- `src/adapters/` — provider interfaces and their real + mock implementations.
- `src/jobs/` — the scheduled and queued workers.

---

## 3. Layering rule

```
route  →  service  →  repository  →  Prisma
   ↓         ↓
 zod     domain (pure functions: state machines, scoring, money)
```

- Routes do **no** business logic. They validate, authorise, call one service, and serialise.
- Services own transactions and are the **only** place business rules exist (spec §92).
- The domain layer is pure and dependency-free, which is what makes the required unit tests (queue scoring, revenue split, state transitions, the 40-hour rule, discounts) cheap and reliable.
- Repositories are the only code that touches Prisma.

---

## 4. Provider abstractions

Every external service sits behind an interface in `src/adapters/`, with a real and a mock implementation chosen by environment variable. Mock mode is surfaced in the UI and stamped on every log line — the system never claims a payment, call, or message happened when it cannot verify it (spec §93).

```ts
interface PaymentProvider {
  initialize(input: InitPaymentInput): Promise<InitPaymentResult>;
  verify(reference: string): Promise<VerifiedPayment>;      // server-side, authoritative
  parseWebhook(raw: Buffer, headers: Headers): WebhookEvent; // signature-verified
  refund(input: RefundInput): Promise<RefundResult>;
}

interface VideoProvider  { createRoom(id): Promise<RoomHandle>;  issueToken(...); endRoom(id); }
interface VoiceProvider  { placeBridgedCall(input): Promise<CallHandle>; endCall(id); }
interface SmsProvider    { send(msg: OutboundMessage): Promise<DeliveryReceipt>; }
interface EmailProvider  { send(msg: OutboundEmail):   Promise<DeliveryReceipt>; }
interface WhatsAppProvider { send(msg: OutboundMessage): Promise<DeliveryReceipt>; }
```

**Recording is disabled structurally, and now also operationally.** `VideoProvider` has no method that could request a recording, and the Whereby adapter sends no `recording` object when it creates a room; `whereby-adapter.test.ts` asserts the request body has no such key (spec §32). What that no longer covers is Whereby's own dashboard, which can enable recording without touching this repository — see [D35](decision-log.md) and `security.md` §10.

**Call Me** uses provider-side bridging so neither party sees the other's number: the platform dials both legs and connects them. No patient number is persisted beyond the consultation.

---

## 5. Real-time

Socket.IO attached to the Fastify HTTP server. The handshake is authenticated with the same session cookie as REST — no separate token scheme. Rooms:

| Room                      | Members                                           | Events                                                                                |
| ------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `consultation:<publicId>` | patient session, assigned doctor, owning pharmacy | state changes, participant join/leave, timer warnings                                 |
| `pharmacy:<publicId>`     | that pharmacy's account                           | queue status, prescriptions, substitution decisions, referrals                        |
| `doctor:<publicId>`       | that doctor                                       | assignment offers, countdown, substitution requests                                   |
| `admin`                   | all admins                                        | queue depth, no-language-match alerts, payment anomalies, refunds, complaints, health |

Room membership is authorised server-side on join. Clinical content is **never** broadcast — events carry ids and states, and the client fetches authorised detail over REST.

---

## 6. Jobs

A single in-process scheduler (`node-cron`-style) plus a lightweight DB-backed work queue. No Redis in the MVP; the queue interface allows adding BullMQ later without touching callers.

| Job                              | Cadence   | Purpose                                                  |
| -------------------------------- | --------- | -------------------------------------------------------- |
| `enforce-response-window`        | every 5s  | 90-second doctor offer timeout → reassign                |
| `process-waiting-queue`          | every 10s | offer waiting consultations to available doctors         |
| `emit-timer-warnings`            | every 10s | consultation duration warnings                           |
| `expire-pending-payments`        | every 30s | 5-minute payment window (spec §35)                       |
| `expire-consultation-tokens`     | every 60s | invalidate unused QR tokens                              |
| `reap-stale-presence`            | every 60s | drop doctors whose heartbeat stopped                     |
| `retry-notifications`            | every 60s | bounded retry with backoff                               |
| `purge-expired-sessions`         | every 15m | expired auth and patient sessions                        |
| `recompute-quality-scores`       | hourly    | weighted doctor quality score                            |
| `purge-expired-clinical-records` | hourly    | destroy sealed records whose retention has elapsed (D23) |
| `sweep-subscription-expiry`      | hourly    | membership expiry → grace → suspension (spec §27)        |
| `reconcile-payments`             | hourly    | Paystack vs local ledger drift                           |

**This table was wrong until Phase 11.** It listed `purge-temporary-data`, `check-licence-expiry` and `check-subscription-expiry`, none of which exist under those names, and omitted five jobs that do. `purge-temporary-data` described the pre-D23 design, where completion destroyed the clinical record; completion now **seals** it and schedules destruction, and `purge-expired-clinical-records` carries that out when the period elapses. Membership expiry is `sweep-subscription-expiry`, hourly rather than daily, because the boundary is a moment and a doctor suspended a day late is a doctor who took a day of consultations they were not entitled to.

MDC licence expiry has no job. `findExpiringLicences` exists and an admin route surfaces it, so the warning is a pull rather than a push — see `product-backlog.md`.

---

## 7. Folder structure (Option A — monorepo, recommended)

```
neem/
├─ apps/
│  ├─ web/                      # the Lovable app, preserved
│  │  ├─ src/routes/            # TanStack file routing
│  │  │  ├─ index.tsx
│  │  │  ├─ s.$token.tsx        # QR landing → token exchange
│  │  │  ├─ patient/…           # consultation portal
│  │  │  ├─ pharmacy/…          # dashboard, new consultation, prescriptions, finance
│  │  │  ├─ doctor/…            # queue, workspace, profile, shifts, earnings
│  │  │  ├─ admin/…             # ops, users, finance, settings, analytics, audit
│  │  │  ├─ verify.$code.tsx    # public prescription verification
│  │  │  └─ auth/…
│  │  ├─ src/components/neem/   # AppShell, Chip, Logo + new shared components
│  │  ├─ src/features/          # per-portal hooks, API clients, forms
│  │  ├─ src/lib/
│  │  └─ src/styles.css         # design tokens (unchanged)
│  │
│  └─ api/
│     ├─ prisma/schema.prisma
│     ├─ prisma/migrations/
│     ├─ prisma/seed/           # demo data, DEMO-flagged
│     └─ src/
│        ├─ modules/<21 modules>
│        ├─ adapters/{payment,video,voice,sms,email,whatsapp}/
│        ├─ jobs/
│        ├─ middleware/
│        ├─ lib/
│        └─ server.ts
│
├─ packages/
│  ├─ contracts/                # zod schemas + inferred types, shared by web and api
│  └─ tsconfig/
│
├─ docker/docker-compose.yml    # mysql, mailhog, adminer
├─ e2e/                         # Playwright: the 16 required scenarios
├─ docs/
└─ .env.example
```

Under **Option B** the same content lives at `./src` (web, unchanged) and `./server` (api), with `packages/contracts` becoming `./shared`.

---

## 8. Dependencies to add

**api runtime:** `fastify`, `@fastify/cookie`, `@fastify/cors`, `@fastify/helmet`, `@fastify/rate-limit`, `@fastify/multipart`, `@prisma/client`, `prisma`, `zod`, `argon2`, `otplib`, `qrcode`, `pdfkit`, `socket.io`, `pino`, `pino-pretty`, `date-fns`, `date-fns-tz`, `uuid`, `dotenv`, `paystack` SDK or plain `undici`.

**api dev:** `vitest`, `@vitest/coverage-v8`, `tsx`, `typescript`, `@types/node`, `prisma`, `supertest`-equivalent via `fastify.inject`.

**web:** `socket.io-client`. Everything else was already installed.

**Corrected in Phase 10.** This paragraph used to end "react-query,
react-hook-form, zod, recharts, and the Radix set are present but unused, so
most of the frontend work is wiring rather than adding" — a prediction that
the scaffolded set would get wired up. Two of them were: react-query and zod
are used throughout. The rest never were.

The 46 shadcn/ui files under `src/components/ui/` were imported by nothing
outside their own directory for the entire build. Neem's screens are
`components/neem/` plus the route files, using the `cn` helper directly, and
that turned out to be the whole of it. The directory is deleted, along with
the 39 packages that existed only to serve it: the 26 Radix primitives,
`react-hook-form` and `@hookform/resolvers`, `recharts`, `cmdk`, `vaul`,
`sonner`, `embla-carousel-react`, `react-day-picker`, `react-resizable-panels`,
`input-otp`, `date-fns`, `class-variance-authority`, and
`@tanstack/router-plugin` (which arrives transitively through
`@tanstack/react-start` anyway). Seventeen dependencies remain.

Nothing about the built output changed, because Vite never bundled files no
entry point reached. What changed is that 4,360 lines of unreviewed code —
including a `dangerouslySetInnerHTML` sink in `chart.tsx` — and 39 packages'
worth of install-time supply-chain surface are no longer carried by a product
that handles patient data.

Three packages **stay** despite no import naming them, and a dependency scan
that only reads import statements will keep proposing their removal:
`@tailwindcss/vite` and `vite-tsconfig-paths` are peer dependencies of
`@lovable.dev/vite-tanstack-config`, and `react-dom` is a peer of
`@tanstack/react-start` and the thing that actually renders the application.

**e2e:** `@playwright/test`.

Note `bunfig.toml` enforces a 24-hour minimum release age on installs. That guard stays; it will occasionally require pinning a slightly older patch version, which is the correct trade.

---

## 9. Configuration

No secret is ever hard-coded (spec §7). `.env.example` documents every variable. On boot, the api validates its environment with zod and **refuses to start** if a required production credential is missing while `NODE_ENV=production`. In development, absent credentials select the mock adapter and log a prominent warning; they never silently degrade in production.

Business configuration — price, duration, revenue split, response window, queue weights, quality weights, membership fee, languages, shifts — lives in the `system_settings` table, not in code (spec §56).

---

## 10. Deployment path

Local: `docker compose up` (MySQL, MailHog, Adminer) + `bun run dev` (web and api concurrently).

Cloud, later, with no rewrite: the api is a stateless container behind a load balancer (sessions live in MySQL, not memory), the web builds to a Node target, MySQL becomes a managed instance, uploaded documents move from local disk to object storage behind the existing storage interface, and the in-process job scheduler moves to a dedicated worker container. Sticky sessions are unnecessary because Socket.IO can be given a Redis adapter at that point — the abstraction is in place from the start.
