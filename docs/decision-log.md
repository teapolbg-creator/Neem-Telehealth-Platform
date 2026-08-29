# Decision Log

Format per spec §107: date · issue · options · selected · rationale · consequences.
Status is **Proposed** until you approve Phase 0.

---

### D1 — Repository layout · 2026-08-29 · **DECIDED: Monorepo**

**Issue.** The backend has to live somewhere. Lovable's tooling expects the app at the repository root.
**Options.** (A) Monorepo: `apps/web` + `apps/api` + `packages/contracts`. (B) Additive: web stays at root, `server/` added alongside.
**Selected.** A, confirmed by the product owner on 2026-08-29.
**Rationale.** Git history is already unrecoverable and the Lovable token is read-only (`git:read`, expires 2026-09-27), so Lovable round-tripping is already impractical. A monorepo gives a conventional structure and lets `packages/contracts` share zod schemas between client and server so the two cannot drift.
**Consequences.** Editing this project in the Lovable editor is foreclosed. The `web` app's source moves from `./src` to `apps/web/src`; `vite.config.ts`, `tsconfig.json`, `components.json`, and the `@/*` path alias move with it and are re-pointed in Phase 1.

---

### D2 — Keep TanStack Start rather than migrating to Next.js · 2026-08-29 · **Proposed**

**Issue.** Spec §6 names "React / Next.js"; the repository is TanStack Start.
**Options.** (A) Migrate to Next.js. (B) Keep TanStack Start.
**Selected.** B, under spec §5 ("preserve a superior compatible architecture where practical").
**Rationale.** Both are React + TypeScript + SSR with file-based routing. Migrating would discard 2,000 lines of working, well-designed UI and the entire Lovable design system for no capability gain, and would contradict spec §105's instruction not to rewrite working Lovable code without justification.
**Consequences.** No Next.js-specific tooling. Mitigated by putting the backend in its own Node process, which the requirements independently call for.

---

### D3 — Separate Node/Fastify API process rather than TanStack server routes · 2026-08-29 · **Proposed**

**Issue.** Where does business logic run?
**Options.** (A) TanStack Start server routes / server functions. (B) A separate Fastify service.
**Selected.** B.
**Rationale.** The requirements need long-lived WebSockets, scheduled deletion and expiry jobs, raw-body webhook verification, Prisma against MySQL, and server-side PDF generation. The Lovable Nitro config targets Cloudflare by default, which fits none of those well. A dedicated Node process is also the natural seam for later service extraction (spec §3, §90).
**Consequences.** Two processes to run locally; a real API boundary that must be versioned and documented — which the spec requires anyway.

---

### D4 — Opaque server-side sessions rather than JWT · 2026-08-29 · **Proposed**

**Issue.** Session mechanism for pharmacy, doctor, and admin.
**Options.** (A) Stateless JWT. (B) Opaque token, server-side session row.
**Selected.** B.
**Rationale.** Suspending a doctor or pharmacy must end their live session **immediately** (spec §22, §27, §55). Stateless JWTs cannot be revoked without a blocklist, which reintroduces the same server state while keeping JWT's downsides.
**Consequences.** A session lookup per request — negligible at pilot scale and indexed. Horizontal scaling is unaffected because sessions live in MySQL, not memory.

---

### D5 — Integer pesewas for all money · 2026-08-29 · **Proposed**

**Issue.** Monetary representation (spec §38, §98).
**Selected.** `Int` minor units plus an explicit currency; percentages in basis points; split remainder assigned deterministically to Neem.
**Rationale.** Eliminates float error entirely and makes the split reproducible and testable.
**Consequences.** Formatting happens once at the presentation edge. A `Money` helper is mandatory; raw arithmetic on amounts is a lint-flagged smell.

---

### D6 — Single-use QR token exchanged for a device-bound session · 2026-08-29 · **Proposed**

**Issue.** Reconciling "single-use QR" (spec §10) with the reality that patients refresh, lock their phones, and switch apps mid-consultation.
**Options.** (A) Token validated on every request — a refresh then locks the patient out. (B) Token exchanged once for a device-bound session cookie.
**Selected.** B.
**Rationale.** Single-use applies to the *token*; the *session* is what carries the patient through. This satisfies the security requirement without a hostile experience.
**Consequences.** A genuinely lost device needs a pharmacy-issued replacement token, which revokes the previous one and is audited. That path is deliberate and visible.

---

### D7 — PDFKit rather than headless-browser rendering · 2026-08-29 · **Proposed**

**Rationale.** Server-side, deterministic, no Chromium dependency, no HTML-template injection surface, small footprint. Prescriptions and referrals are structured documents, not web pages.
**Consequences.** Layout is written in code rather than HTML/CSS — more verbose, but exactly reproducible, which matters for a legal document.

---

### D8 — Recording made structurally impossible, not merely disabled · 2026-08-29 · **Proposed**

**Rationale.** Spec §32 requires that recordings are never created, including by accident. A configuration flag can be flipped; absent code cannot.
**Selected.** The video adapter constructs rooms with recording off and exposes no enable path; `media_sessions.recordingEnabled` is `NOT NULL DEFAULT FALSE` with a CHECK constraint; a test asserts both.

---

### D9 — Languages seeded as data, three active · 2026-08-29 · **Proposed**

**Rationale.** The business document lists six, the answers document sets the MVP to English, Twi, and Ga, and Admin must be able to add more (spec §29).
**Selected.** All six seeded; English/Twi/Ga `isActive = true`; the rest toggled by Admin without a migration.

---

### D10 — Remove the "Approved by the Ghana Medical & Dental Council" claim · 2026-08-29 · **Proposed**

**Issue.** `src/routes/index.tsx` renders that claim in the footer.
**Selected.** Remove it in Phase 1.
**Rationale.** Spec §78 forbids presenting unverified regulatory status as fact. No approval or endorsement claim ships without a document you can put in front of a regulator.

---

### D11 — Vitest + Playwright · 2026-08-29 · **Proposed**

**Rationale.** Vitest shares Vite's config and transform pipeline, so one toolchain covers both apps; integration tests run against a real MySQL test database rather than mocks, because the constraints (unique keys, transactions) are a large part of what is being tested. Playwright covers the 16 required E2E scenarios cross-browser and handles the mobile-viewport patient flow.

---

### D12 — No Redis in the MVP · 2026-08-29 · **Proposed**

**Rationale.** At pilot scale, MySQL-backed jobs and in-process Socket.IO are sufficient, and every added service is operational cost. The job queue and the Socket.IO adapter both sit behind interfaces, so introducing Redis later is a configuration change rather than a rewrite (spec §3, §89).

---

### D13 — Prescription access: four parties only · 2026-08-29 · **DECIDED**

**Issue.** `About Neem.docx` contemplates long-term prescription storage "for research and quality assurance for Neem, the pharmacy once granted permission and other 3rd party healthcare institutions if granted permission." Spec §45 permits four readers and mentions neither research use nor third-party institutions.
**Selected.** Spec §45 governs the MVP, confirmed by the product owner on 2026-08-29.
**Rationale.** The Ghanaian data-protection position is unverified (see `compliance/`), so the more protective option is correct. Third-party disclosure needs a consent mechanism and a defined lawful basis that do not yet exist.
**Consequences.** Permitted readers are exactly: the patient (via their session), the issuing doctor, the dispensing pharmacy, and Neem Admin. **No other pharmacy, no third-party institution, no research export in V1.** `consents` and `disclosure_log` tables are shaped in the Phase 1 schema but unused, so later third-party sharing is an added feature rather than a migration rewrite. An authorization test asserts cross-pharmacy access is refused (spec §102).

---

### D14 — Patient keeps the prescription/referral PDF only · 2026-08-29 · **DECIDED**

**Issue.** The Lovable patient portal renders a clinical summary after completion, which would be a retained clinical record and contradicts spec §16/§101.
**Options.** (A) PDF only. (B) PDF plus a short doctor-authored patient-facing remark stored on the prescription.
**Selected.** A, confirmed by the product owner on 2026-08-29.
**Rationale.** Strictest reading of the deletion rule, and the only option that keeps "clinical notes are deleted at completion" true without qualification.
**Consequences.** The clinical summary block is removed from the patient completion screen. `prescriptions.patientRemark` is **not** created. Referral `reasonText` remains the sole doctor-authored clinical text on a permanent record, because a referral is a document the doctor deliberately issues to another clinician.

---

### D15 — In-consultation chat and image upload cut from MVP · 2026-08-29 · **DECIDED (Category B)**

**Issue.** Both appear as buttons in the Lovable patient and doctor call screens. Neither is in the specification.
**Selected.** Removed from the MVP and logged in the backlog.
**Rationale.** Neither is specified, and image upload in particular would create a clinical-data retention question the spec does not answer. Adding an unspecified surface that stores patient-supplied images would widen scope and privacy exposure at once.
**Consequences.** The five-button call control row becomes four (mic, camera, speaker, end). Reversible — say the word and it returns with a retention rule attached.

---

### D16 — Local environment: Node.js 22 + Docker Desktop · 2026-08-29 · **DECIDED**

**Selected.** Node.js 22 LTS plus Docker Desktop, confirmed by the product owner on 2026-08-29.
**Rationale.** `docker compose up` provides MySQL 8, MailHog, and Adminer in one reproducible command and mirrors the eventual cloud topology, so the local/production gap stays small.
**Consequences.** `docker/docker-compose.yml` is a Phase 1 deliverable. Both must be installed before Phase 1 can produce running code.

---

## Open items carried into Phase 1

| Ref | Item | Blocking |
| --- | --- | --- |
| C9 | Twilio Programmable Video roadmap — verify with Twilio directly | Phase 5 provider choice |
| G7 | Minimum legal retention period for clinical records in Ghana | Would be architectural if one exists — see `compliance/` Q7 |
| — | Node.js 22 + Docker Desktop installation | Any running code |
