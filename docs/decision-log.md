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

### D17 — npm workspaces instead of bun · 2026-08-29 · **DECIDED (Category C)**

**Issue.** The project shipped with `bun.lock` and `bunfig.toml`; bun is not installed on the development machine, and Node.js 22+ with npm is (decision D16).
**Selected.** npm workspaces with `package-lock.json`. `bun.lock` and `bunfig.toml` removed.
**Rationale.** Requiring a second package manager to run the project adds a setup step for no gain, and the Prisma and Playwright toolchains are best-supported on npm.
**Consequences — worth stating plainly.** `bunfig.toml` carried a supply-chain guard (`minimumReleaseAge = 86400`) that skipped any package version published in the previous 24 hours. **npm has no equivalent, so that protection is gone.** Mitigations: `package-lock.json` pins exact resolved versions, and new dependencies are reviewed rather than added casually. Restoring the guard is a reason to reconsider bun later.

---

## Open items carried into Phase 1

| Ref | Item | Blocking |
| --- | --- | --- |
| C9 | Twilio Programmable Video roadmap — verify with Twilio directly | Phase 5 provider choice |
| G7 | Minimum legal retention period for clinical records in Ghana | Would be architectural if one exists — see `compliance/` Q7 |
| — | Node.js 22 + Docker Desktop installation | Any running code |

---

### D18 — Video and voice ship on mock adapters until Twilio is confirmed · 2026-08-29 · **DECIDED**

**Issue.** Twilio has previously announced end-of-life plans for Programmable Video (finding C9). Its current status is unverified, and Neem will not build against an unconfirmed product.

**Options.** (A) Confirm with Twilio before building Phase 5. (B) Build against the `VideoProvider` / `VoiceProvider` interfaces with mock adapters now, and add the real adapter once the product is confirmed.

**Selected.** B, confirmed by the product owner on 2026-08-29, with the mock at the "session lifecycle plus local camera" depth.

**What this means, stated plainly.** The consultation runs end to end — lifecycle, timer and its warnings, join and leave, session records, the clinical workflow and the completion purge. The browser's real camera and microphone are used for the local preview, so permission prompts, device selection and the mute/camera controls are genuinely exercised. **What does not work is media transport: two people cannot see or hear each other, and Call Me does not place a real call.** The remote pane says so rather than implying a connection.

**Consequences.** Three spec §100 acceptance criteria — patient audio/video, patient Call Me, doctor audio/video — are **not met** until the adapter lands, and are reported as outstanding rather than complete. The swap itself is one file; proving it works over Ghanaian mobile networks, on low-end Android browsers, and across dropped connections is separate work that a mock cannot stand in for. Consistent with Paystack (Phase 7) and the notification providers (Phase 8): the MVP is architecturally complete with external providers in mock mode until credentials exist.

---

### D19 — The doctor is not shown the patient's phone number · 2026-08-29 · **DECIDED (Category B — tell me if you disagree)**

**Issue.** Found while building Call Me. The doctor's clinical panel endpoint returned the patient's phone number in its payload — invisible in the UI, but present in the response and therefore available to anyone with developer tools open. Spec §33 exists so that a Call Me bridge keeps each party's number from the other; handing the doctor the number in a side panel defeats that completely.

**Options.** (A) Keep returning it — the doctor holds a clinical record and the number is part of it. (B) Return it only to the pharmacy, which captured it with the patient standing in front of them.

**Selected.** B.

**Rationale.** The protective reading, and the only one under which §33 is actually true. A doctor has no workflow that needs the number: Call Me dials for them, and every other mode runs in a room. The pharmacy keeps it because they collected it and are the patient's point of contact.

**Consequences.** `readPatientPanel` takes `includePhone`, off by default; the pharmacy route opts in and the doctor route does not. If you want the doctor to have it — for a call-back after a dropped connection, say — that is a business rule to state deliberately rather than an accident of the payload, and it would want its own audit entry.

---

### D20 — The doctor's contact number is stored, encrypted · 2026-08-29 · **DECIDED (Category C)**

**Issue.** Doctor onboarding collected a phone number in the form and the contract, but the registration service silently dropped it before writing to the database. Call Me cannot dial a doctor whose number was never stored.

**Selected.** `doctors.phoneEnc`, encrypted at rest like every other personal field. Migration `20260829150441_doctor_contact_phone`.

**Consequences.** The number is never returned to any client — not to the patient, not to the pharmacy, not to the doctor's own profile response. It leaves the server only by being handed to the voice provider to dial. A doctor registered before this migration has no number; `placeCallMe` refuses with a message naming the reason rather than failing obscurely.

---

### D21 — Doctor capacity is released by the state machine · 2026-08-29 · **Bug fix, recorded because it changes behaviour**

**Issue.** Accepting a consultation incremented `doctor_presence.currentLoad`. Nothing ever decremented it — `releaseCapacity` existed but had no callers. Every doctor was therefore permanently at capacity after their first consultation, and the allocation engine silently stopped routing to them. No error was raised anywhere; the queue simply reported "no eligible doctor".

**Selected.** `transition()` releases capacity whenever a consultation with a doctor moves from a non-terminal state to a terminal one.

**Rationale.** Doing it inside the state machine rather than at each terminal call site means no future path — completion, cancellation, expiry, abandonment, refund — can forget it. `releaseCapacity` floors at zero in SQL, so a retried transition cannot drive the count negative.

**Consequences.** Covered by two integration tests. This is also why `e2e/media.spec.ts` provisions its own doctor per run rather than borrowing the seeded demo account: nothing can yet move a consultation out of `DOCTOR_ACCEPTED` to a terminal state, because completing one is Phase 6.

---

### D22 — Uploaded documents were being written outside the ignored directory · 2026-08-29 · **Bug fix**

**Issue.** `STORAGE_LOCAL_PATH` is `./apps/api/uploads`, written relative to the repository root — as it reads in `.env` and in `.gitignore`. But the API process runs with `apps/api` as its working directory, so `path.resolve` produced `apps/api/apps/api/uploads`, which the ignore rule does not match. Uploaded doctor credential documents were therefore landing in a tracked location, and 33 of them had already been committed across three earlier commits.

**Selected.** `LocalStorageProvider` resolves a relative root against the repository root, derived from the module's own location rather than the process's working directory. `**/uploads/` added to `.gitignore` as a second line of defence, and the committed files removed from tracking.

**What was actually in them.** Two distinct blobs: a 1×1 PNG from the E2E fixtures and a generated placeholder licence image from the demo seed. **No real credential document was ever committed** — but the mechanism was live, and against real applicant data it would have committed identity documents to git. History is not rewritten, because the content is synthetic.
