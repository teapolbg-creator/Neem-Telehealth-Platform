# Phase 0 — Discovery Findings

**Date:** 2026-08-29
**Status:** Awaiting approval to begin Phase 1
**Inputs reviewed:** `About Neem.docx` (business document), `clarify questions 1/2` + `answers to clarify questions 1/2`, `one more tip for Neem coding.docx`, the Master Build Specification, and the complete Lovable repository.

---

## 1. What the existing repository actually is

The Lovable project is a **high-fidelity, non-functional UI prototype**. It is a well-built design artefact, not an application.

### 1.1 Stack as found

| Concern | Actual |
| --- | --- |
| Framework | **TanStack Start** v1.168 (file-based routing, SSR) — *not* Next.js |
| Build | Vite 8, wrapped by `@lovable.dev/vite-tanstack-config` v2.13.1 |
| Server runtime | Nitro 3 beta, **default build target Cloudflare** |
| UI | React 19.2, TypeScript 5.8 (`strict: true`) |
| Styling | Tailwind CSS **v4** (CSS-first `@theme inline`, oklch tokens) |
| Components | shadcn/ui "new-york", 47 Radix-based primitives |
| Icons | lucide-react |
| Data fetching | `@tanstack/react-query` v5 (installed, provider mounted, **never used**) |
| Forms | react-hook-form + zod v3 + `@hookform/resolvers` (installed, **never used**) |
| Charts | recharts (installed, **never used** — charts are hand-rolled divs) |
| Package manager | **bun** (`bun.lock`, `bunfig.toml` with a 24h supply-chain release-age guard) |
| Fonts | Plus Jakarta Sans (body), Nunito (display), self-hosted via `@fontsource` |

### 1.2 What exists

- **7 routes**, ~2,000 lines total: `/`, `/pharmacy`, `/pharmacy/new`, `/patient/$sessionId`, `/doctor`, `/admin`, plus `__root`.
- **3 Neem components**: `AppShell` (top nav + sidebar grid), `Chip` (status pill, 5 tones), `Logo`.
- **A real design system** in `src/styles.css`: brand teal `oklch(0.58 0.13 175)`, medical blue `oklch(0.55 0.17 255)`, warning orange, `card-soft` and `chip` utilities, a 0.75rem radius scale.
- **Good SSR error handling** already wired: `src/server.ts` normalises h3-swallowed 500s, `src/start.ts` adds request middleware, the root route has `errorComponent` / `notFoundComponent`.
- **Genuinely reusable UI patterns**: the patient portal's phone-frame shell, the 3-step pharmacy wizard, the doctor split-screen clinical workspace, the admin KPI grid.

### 1.3 What does not exist

There is **no backend of any kind**. Specifically absent: database, ORM, migrations, API routes, authentication, authorization, sessions, payments, WebSockets, Twilio, PDF generation, QR generation, notifications, audit logging, data retention, validation, tests, Docker, `.env` handling, CI.

Every screen renders from `src/lib/neem-data.ts` — 71 lines of hard-coded arrays. Every button is either inert or flips local `useState`. The QR code is a decorative pseudo-random grid (`(i * 7919) % 100 > 55`), not a QR code.

**Estimate: the prototype covers roughly 5–8% of the specified MVP, and that portion is presentation-layer only.**

---

## 2. Environment blockers (must be resolved before Phase 1 can run)

Verified by inspection of this machine:

| Tool | Status | Needed for |
| --- | --- | --- |
| **Node.js** | not installed | Everything |
| **bun** | not installed | The project's own package manager |
| **Docker** | not installed | MySQL, MailHog |
| **MySQL** | not installed | The database |
| git | installed | — |
| Python | Windows Store stub only | — |

**Nothing in this repository can currently be installed, built, run, or tested.** Phase 1 cannot produce a running system until at minimum Node.js (or bun) and a MySQL instance exist. See Q5 in §6.

### 2.1 Git is broken

`.git` is a **file**, not a directory. It points at a worktree gitdir inside a Linux nix store (`/nix/store/r62rrm9zik.../repo.git/worktrees/dev-server`) that does not exist on Windows. `.workspace/.git` is an initialised-but-empty repository whose `main` branch **has zero commits**.

Consequences:

- There is no local version history. This is a file snapshot, not a clone.
- `AGENTS.md` warns against rewriting Lovable history — there is no history here to rewrite.
- The Lovable remote token in `.workspace/.git/config` carries `"scopes":["git:read"]` and expires 2026-09-27. **We cannot push back to Lovable** even if we wanted to.
- **A bearer token is stored in plaintext in the repository.** Read-only and short-lived, but it must not be committed anywhere public.

**Recommendation:** initialise a fresh local git repository and commit the current snapshot as the baseline, so every subsequent phase is reviewable as a diff.

---

## 3. Conflicts and contradictions found

Ranked by how much they change the build.

### C1 — Framework: spec says Next.js, repo is TanStack Start *(architecture-changing)*

Spec §6 states "React / Next.js"; §5 says preserve a superior compatible architecture where practical. Migrating to Next.js would discard the entire working Lovable frontend for no functional gain. **Resolution: keep TanStack Start for the web app.** The open question is where the backend lives — see Q4.

### C2 — Who collects patient identity *(workflow-changing)*

The Lovable `/pharmacy/new` wizard collects *first name, age range, gender* **at the pharmacy counter** and explicitly promises "No phone number, ID, or medical history is stored on the pharmacy side."

The spec (§10) requires the **patient** to enter *full name, age, sex, phone number* **on their own phone after scanning the QR** — and §18 lets the pharmacy then view those four fields for the active consultation only.

These are incompatible. **Resolution: follow the spec.** The pharmacy wizard becomes: create consultation → take payment → show QR. Identity capture moves to the patient portal. The pharmacy consultation screen gains a read-only temporary patient panel.

### C3 — Doctor allocation: two contradictory models in the business document

`About Neem.docx` §"Consultation Allocation System" says "The first available doctor to accept the consultation is connected." Its own §"Strategic Recommendation" then argues against exactly that, and the answers document confirms the smart queue with an explicit priority order. **Resolution: smart queue only. The first-to-click model is not implemented.**

### C4 — Prescription retention purpose and third-party sharing *(privacy / regulatory — needs your decision)*

`About Neem.docx` says prescriptions are stored long-term "for research and quality assurance for Neem, the pharmacy once granted permission **and other 3rd party healthcare institutions if granted permission**."

Spec §45 lists exactly four permitted readers — patient, issuing doctor, dispensing pharmacy, Neem Admin — and says other pharmacies cannot access. Third-party institutional sharing and secondary research use appear nowhere in the spec. **Category A. See Q1.**

### C5 — Patient-facing clinical summary after consultation *(privacy)*

The Lovable patient portal's completion screen displays a clinical summary ("Suspected uncomplicated malaria. RDT positive…"). The spec requires diagnosis and clinical notes to be **deleted the moment the doctor completes the consultation** (§16, §101). A stored, retrievable patient-facing summary would be a retained clinical record and would contradict that. **Category A. See Q2.**

### C6 — False regulatory claim in the UI

`src/routes/index.tsx` footer reads: "© 2026 Neem Health · **Approved by the Ghana Medical & Dental Council**". Spec §78 forbids presenting unverified regulatory status as fact. **Resolution: remove this string in Phase 1.** No approval claim goes into the product without a document you can show a regulator.

### C7 — Hard-coded business values throughout the prototype

`GH₵ 45.00` consultation fee, `GH₵ 8,940` revenue, the 30%/70% split rendered as literals, `MDC-44291-GH`, `neem.gh/s/NM-99282`, "Live pilot across Accra, Kumasi & Tamale", six languages (MVP is three). Spec §38/§39 forbid hard-coding these. **Resolution: all become `system_settings` rows or seeded demo data, clearly marked DEMO.**

### C8 — Features in the prototype UI that the spec never authorises

In-consultation **text chat** and **image upload** buttons appear in both the patient and doctor call screens. Neither is in the specification, and an image upload during a consultation creates a clinical-data-retention question the spec does not answer. **Category B. See Q3.** Default if unanswered: remove both from MVP, log in the backlog.

### C9 — Twilio Programmable Video product risk

Twilio has previously announced end-of-life plans for Programmable Video. I do **not** have verified current information on its status and will not assert one. This is exactly why spec §91 requires a `VideoProvider` interface. **Action: verify Twilio Video's availability and roadmap with Twilio directly before Phase 5.** The abstraction means the answer changes one adapter, not the application.

### C10 — Languages

Business document lists six; `neem-data.ts` seeds six; the answers document sets MVP to **English, Twi, Ga**. **Resolution: `languages` table seeded with all six, only English/Twi/Ga `active = true`, Admin toggles the rest.**

---

## 4. What gets reused, refactored, replaced

**Reused unchanged:** the entire design system (`styles.css` tokens, `card-soft`, `chip`), all 47 shadcn/ui primitives, `Logo`, `Chip`, the fonts, the SSR error-handling layer, the root route head/meta setup, the landing page layout, and the visual language of every dashboard.

**Refactored:** `AppShell` gains real auth context and role-derived navigation (today it renders all four portals as tabs to anyone — a demo device, not a product). Every route becomes a data-driven page fed by React Query against the real API. The pharmacy wizard is restructured per C2. The doctor workspace keeps its layout and gains a real clinical workspace, prescription builder, and timer.

**Replaced:** `neem-data.ts` (deleted — becomes API + seed data), the decorative QR grid (real `qrcode` output), the hand-rolled bar charts (recharts, already installed), and every `useState` flow that must be server-enforced (spec §92).

---

## 5. Proposed architecture — summary

Full detail in `docs/architecture.md`. Headlines:

- **Modular monolith**, two deployables: `web` (TanStack Start, the Lovable app preserved) and `api` (Node + Fastify + TypeScript). Clean module boundaries so services can be extracted later; no microservices now.
- **MySQL 8 + Prisma.** UUIDv7 internal keys; a separate short opaque `publicId` on every externally-referenced entity (spec §65).
- **Money as integer pesewas** (GHS minor units). No floating-point anywhere in the financial path.
- **Auth:** argon2id passwords; opaque server-side sessions in httpOnly/SameSite cookies (revocable, unlike JWT); TOTP 2FA for Admin; 256-bit single-use consultation tokens for patients.
- **Real-time:** Socket.IO in the same Node process, authenticated at handshake, room-per-consultation.
- **Provider abstractions** (spec §91): `PaymentProvider`, `VideoProvider`, `VoiceProvider`, `SmsProvider`, `EmailProvider`, `WhatsAppProvider` — each with a real adapter and a mock adapter selected by env. Mock mode is loudly labelled in the UI and in logs.
- **Testing:** Vitest (unit + integration against a real MySQL test database) and Playwright (the 16 required E2E scenarios).
- **PDF:** PDFKit server-side — no headless Chromium dependency.

---

## 6. Category A questions — ANSWERED 2026-08-29

All five were put to the product owner and resolved. Recorded as decisions D1, D13, D14, D15, D16 in `docs/decision-log.md`.

| # | Question | Decision |
| --- | --- | --- |
| Q1 | Prescription third-party sharing / research use | **Four parties only.** Spec §45 governs. No third-party access, no research export in V1. `consents` / `disclosure_log` shaped but unused |
| Q2 | What the patient keeps after completion | **Prescription/referral PDF only.** The clinical summary screen is removed; no `patientRemark` field |
| Q3 | In-consultation chat and image upload | **Cut from MVP**, logged in the backlog |
| Q4 | Repository layout | **Monorepo** — `apps/web` + `apps/api` + `packages/contracts` |
| Q5 | Local runtime | **Node.js 22 LTS + Docker Desktop** (MySQL 8, MailHog, Adminer via compose) |

The original wording of each question is preserved below for the record.

---

### Original questions

Per spec §106 I stopped rather than assuming.

**Q1 — Prescription retention purpose and third-party access (C4).**
Your business document contemplates sharing prescriptions with third-party healthcare institutions and using them for research, with permission. The spec restricts access to four parties and says nothing about research use. Which governs the MVP?
*Recommendation:* build the four-party model now, and shape a `consents` + `disclosure_log` table so third-party sharing can be added later without a migration rewrite — but ship no third-party access and no research export in V1.

**Q2 — What, if anything, does the patient keep after the consultation (C5)?**
The prescription is permanent and downloadable — settled. But the Lovable UI also shows a clinical summary. Options:
(a) patient receives **only** the prescription/referral PDF, no clinical summary — the strictest reading of your deletion rule (*recommended*);
(b) the doctor may write a short patient-facing remark stored **on the prescription record** — your business document does mention "a short remark if necessary" alongside name/age/sex;
(c) something else.
Note that (b) makes a small amount of clinical text permanent. That is a policy choice, not an engineering one.

**Q3 — In-consultation chat and image upload (C8).**
Present in your Lovable UI, absent from the spec. Include in MVP or move to backlog? If included, I need a retention rule for uploaded images. *Recommendation:* cut both from MVP.

**Q4 — Repository layout (D1 in the decision log).**
- **Option A — Monorepo:** move the app to `apps/web/`, add `apps/api/` and `packages/contracts/`. Cleanest long-term and standard. Cost: departs from Lovable's expected root layout, so round-tripping edits through the Lovable editor becomes impractical.
- **Option B — Additive:** leave the web app exactly where it is at the repo root, add `server/` alongside it. Preserves Lovable compatibility. Cost: a slightly unusual layout.

Given that git history is already gone and the Lovable token is read-only, **Option A is recommended.** If you intend to keep editing this project in Lovable's editor, say so and I will build Option B.

**Q5 — Local runtime (§2).**
You need Node.js 22 LTS and a MySQL 8 instance on this machine. For MySQL, Docker Desktop is cleanest (`docker compose up` gives MySQL + MailHog + Adminer and matches production), but a native MySQL 8 installer also works. Which do you want to install? The application will work with either.

---

## 7. Documents created in Phase 0

| File | Contents |
| --- | --- |
| `docs/phase-0-findings.md` | This document |
| `docs/architecture.md` | System architecture, module boundaries, folder structure, dependencies |
| `docs/database.md` | Full ERD, retention classification per table |
| `docs/api.md` | REST surface, response/error envelope conventions |
| `docs/security.md` | Threat model, auth design, token design, control checklist |
| `docs/data-retention.md` | Temporary vs permanent classification, deletion mechanism |
| `docs/consultation-flow.md` | Consultation state machine and valid transitions |
| `docs/queue-engine.md` | Smart allocation scoring, 90s window, reassignment, no-language-match path |
| `docs/payment-flow.md` | Paystack sequence, webhook idempotency, revenue split, refunds |
| `docs/decision-log.md` | Engineering decisions with rationale |
| `docs/product-backlog.md` | MVP vs Post-MVP, explicit scope fence |
| `docs/roadmap.md` | Phases 1–11 with deliverables and exit criteria |
| `docs/compliance/README.md` | How the compliance register works, and its limits |
| `docs/compliance/ghana-regulatory-register.md` | Candidate instruments, all marked UNVERIFIED, with verification tasks |

---

## 8. Recommended next step

Answer Q1–Q5. On approval I begin **Phase 1 — Foundation**: repository restructure, local environment, Prisma schema and migrations, authentication + RBAC + Admin 2FA, structured logging, the audit-log skeleton, the test harness, and the design-system extraction — ending with a running application, a migrated database, and a passing test suite.
