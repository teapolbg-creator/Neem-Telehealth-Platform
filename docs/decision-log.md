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

### D14 — Patient keeps the prescription/referral PDF only · 2026-08-29 · **PREMISE VOIDED by D23 — see D25**

> **Superseded, and worth reading for why.** This decision rested entirely on preserving the claim that clinical notes are deleted at completion. D23 established that Ghanaian law does not permit that deletion, so the guarantee this protected no longer exists. D14 was not wrong on its merits; its justification ceased to apply. D25 reinstates a patient-facing doctor-authored document on the changed footing. Left here unedited below, because a decision log that quietly rewrites itself is worthless.

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
| C9 | Twilio Programmable Video roadmap — verify with Twilio directly | The real media adapter. Phase 5 shipped on mocks (D18) |
| ~~G7~~ | ~~Minimum legal retention period for clinical records in Ghana~~ | **CLOSED 2026-08-29 — a minimum exists. See D23.** Six follow-on questions remain with counsel, tracked as G7a–G7f in `data-retention.md` §10 |
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

---

### D23 — Clinical records are retained for 3 years under seal, not deleted at completion · 2026-08-29 · **DECIDED — reverses a core design assumption**

**Issue.** G7, flagged in Phase 0 as *"would be architectural if a minimum retention period exists"*, was answered by the product owner on 2026-08-29 from Medical & Dental Council sources. A minimum does exist. Deleting consultation notes at completion breaches the record-keeping duty on registered practitioners under the Health Professions Regulatory Bodies Act, 2013 (Act 857), and destroys the evidence both parties need during the 3-year civil window for a negligence claim. The Data Protection Act, 2012 (Act 843) permits — and where another law mandates, requires — retention of health data.

**What this reverses.** Phases 0–5 were built on "clinical information exists only for the duration of the consultation" (spec §16, §62, §101). That is now wrong. The completion purge, which was the headline deliverable of Phase 6, does not survive in that form.

**The distinction that decided the rest.** The finding contains two obligations that are routinely conflated: *record-keeping* (the records must exist) and *continuity of care* (a future clinician should read them). Only the second collides with spec §13. The first is satisfied by an archive nobody reads.

**Selected.** Records retained **3 years from completion**, encrypted at rest, **readable through no product surface** — the "sealed archive" option. Configurable via `retention.clinicalRecordYears`.

**Rationale.** The most protective position that still counts as complying with the record-keeping duty. The continuity-of-care argument is deliberately declined: no clinician sees a patient's past. This is reversible in the safe direction — the records will exist, so opening a consented read path later is an added feature, not a migration. The reverse would not have been true.

**Consequences — the honest list.**

1. **Spec §13's "no medical history" ceases to be a guarantee about the data and becomes one about access.** A patient index must exist, because a subject-access request, an MDC inquiry, and a negligence claim all require producing a named patient's records. Per-consultation islands cannot service any of them. Restated in `data-retention.md` §3.
2. **Vitals and point-of-care results are stored in plaintext.** Defensible when they lived for minutes; not over three years. They need field encryption like the notes already have.
3. **Key management becomes load-bearing.** One `ENCRYPTION_KEY` with no rotation path is thin for data with a multi-year life.
4. **The patient-facing deletion promise is now false.** *"Your details and everything discussed have been deleted"* must be replaced, and a notice stating the lawful basis added at capture — the product currently states no basis anywhere.
5. **Subject access and erasure need a mechanism.** Neither exists, and erasure conflicts with a statutory retention duty in a way counsel must resolve.
6. **Break-glass access must be built**: two-person authorisation, stated purpose recorded before access, append-only `clinical_record_access_log`, export rather than a browsable screen.
7. **The spec §101 critical test changes shape** — from "absent after completion" to "still present, unreadable by every role, and gone after expiry."
8. **The backup window must be materially shorter than the retention period** for destruction to be effective within a bounded time.
9. **D8 (no recording) is unaffected and independently endorsed** by the finding, which explicitly supports purging transient audio and video.
10. **D13 (four-party prescription access) stands.** Retention governs keeping; D13 governs sharing. They do not interact.
11. **Scope.** This is not a bolt-on to Phase 6. It is roughly half a phase again, or a phase of its own ahead of it.

**Still open with counsel.** The exact period within the 3–6 year range; whether paediatric records carry a longer rule; whether a sealed archive counts as complying given that continuity of care is declined; the lawful basis and required notice; the access/erasure mechanism; and an acceptable backup window. Tracked in `data-retention.md` §10 as G7a–G7f.

---

### D24 — Records are retrieved by consultation reference, not by patient · 2026-08-29 · **DECIDED**

**Issue.** D23 retained clinical records for three years. My initial reading was that a patient identity index therefore became unavoidable, because a subject-access request, an MDC inquiry, and a negligence claim all require producing a named patient's records — and per-consultation islands cannot be searched. That reading was wrong, and the product owner corrected it on 2026-08-29.

**Selected.** No patient profile and no patient index. Every consultation carries an opaque reference (`consultations.publicId`), which is given to the patient and printed on every document they receive. **That reference is how a record is located** — for the patient, for counsel, for the Council.

**Rationale.** The analogy is a shop receipt: you do not need an account to buy something, and the receipt is how the transaction is found again. It satisfies the retrieval requirement without building the thing spec §13 forbids. No table is keyed by person; no query returns "every consultation for this phone number"; there is nothing that could grow into a history feature by accident.

The clinical model supports this and is the stronger argument. Neem is an **episodic point-of-care safety check**, not longitudinal care: a patient about to buy medication gets a doctor's assessment of whether that is safe, plus a push toward in-person care when it is not. Records exist so that one episode can be examined later, not so a future clinician can assemble a picture. Continuity of care is deliberately not the value proposition, which is why declining it costs nothing clinically.

**Consequences.**

1. **The reference identifies; it does not authorise.** Quoting a number tells Neem *which* sealed record is meant. Opening it still requires the two-person authorisation and stated purpose of Archived Consultation Retrieval (D27, renamed from break-glass on counsel's instruction). Otherwise a discarded prescription slip becomes a key to someone's clinical record.
2. **Retrieval is reference-scoped**, not person-scoped. There is no "show me everything about this patient" path, by design.
3. **Subject access becomes "quote your reference"** — a recognised privacy-preserving pattern, not an evasion.
4. **Every consultation must put the reference in the patient's hands**, whatever the outcome. Advice-only consultations previously produced no artefact at all; D25 resolves that.
5. **One caveat that must be stated accurately to counsel.** `prescriptions` permanently stores `patientName`, `patientAge` and `patientSex` by value, following spec §11 and predating this decision. A name search against that table is therefore technically possible for anyone with database access. What this decision removes is the **feature**: no product surface indexes by patient, and clinical notes are reachable only by consultation reference. Nobody should tell a regulator that Neem *cannot* search by patient.
6. Phase 5.5 shrinks — the patient identity index and the person-scoped subject-access search both come out.

---

### D25 — Advice-only consultations issue a consultation summary · 2026-08-29 · **DECIDED — supersedes the premise of D14**

**Issue.** Under D24 the patient must leave holding their reference. Prescription and referral patients get a document that carries it; `ADVICE_ONLY` patients get nothing. That is the outcome where a document is most valuable and where its absence is most conspicuous.

**Relationship to D14.** D14 ruled out patient-facing doctor-authored text on a single ground: that it was "the only option that keeps 'clinical notes are deleted at completion' true without qualification." **D23 voided that premise** — the guarantee D14 protected no longer exists. D14 is not overturned on its merits; its justification ceased to apply. It is retained in this log with that noted, rather than rewritten.

**Selected.** A short, doctor-authored **consultation summary**, carrying the consultation reference. **Mandatory for `ADVICE_ONLY`, optional for every other outcome** (those already produce a document bearing the reference). **Permanent, with its own verification page**, on the same logic as a referral.

**Rationale.** Advice-only is Neem's strongest clinical story and currently its weakest artefact: a patient is talked out of medication they came in for and leaves with nothing to show a doctor was ever involved. Written advice survives the walk home; verbal advice at a counter does not. It also backs the pharmacist, who has just declined a sale, and it makes the referral-to-hospital push — the safety-critical part of the model — durable.

Permanence and a verification page follow from use: a patient may present this at a hospital, and that hospital must be able to confirm it is genuine. A verification page that expires after three years would be worse than none.

**Constraints, all of them load-bearing.**

1. **The doctor writes it. It is never generated.** A document carrying a practitioner's name and signature saying "you do not need medication" is a clinical opinion, and the first thing a lawyer reads if the patient deteriorates. Composing it automatically from the notes would put words in a doctor's mouth on a document they answer for. Structured fields with pick-lists and one or two short free-text boxes keep it inside the five-minute consultation.
2. **Safety-netting is a required field.** "What to watch for" and "when to seek care urgently" must be present before the document can be issued. A summary that says only "no medication needed" reads as an all-clear from a remote five-minute assessment, and would be worse than issuing nothing.
3. **It is not called a medical report.** In Ghana that phrase is used for employment, insurance and court purposes; naming it so invites it being presented as something it is not. It is a *consultation summary*. For the same reason it documents what the doctor found and advised — it does not justify the fee.

**G7g answered 2026-09-01: there is no mandated form or content.** The summary's fields are therefore entirely Neem's design, and the three constraints above are **product policy, not legal requirement**. That distinction is worth keeping straight in both directions. Nothing in the UI or documentation may present them as a regulatory obligation (spec §78) — and equally, "the law does not require it" is not an argument for dropping the safety-netting field, which exists because a remote five-minute assessment that says only "no medication needed" reads as an all-clear it cannot support.

**Consequences.** A new document type alongside prescriptions and referrals in Phase 6: model, doctor-facing composer, PDF, verification page. Its clinical text is permanent and patient-held, which is a deliberate change from D14 — sitting in the same category as referral `reasonText`, which D14 already accepted as a legitimate permanent carry-forward because a doctor deliberately issues it as a document.

---

### D26 — Encryption keys rotate by trying each, not by versioning ciphertext · 2026-09-01 · **DECIDED (Category C)**

**Issue.** D23 made clinical records live for years, so the key that encrypted them will outlive its own sensible lifetime. There was one `ENCRYPTION_KEY` and no rotation path at all: changing it would have made every stored field permanently unreadable.

**Options.** (A) Version the ciphertext with a key id and look up the key by id. (B) Keep a decrypt-only list of retired keys and try each in turn.

**Selected.** B. `ENCRYPTION_KEY` encrypts; `ENCRYPTION_KEY_PREVIOUS` is a comma-separated list that only ever decrypts.

**Rationale.** AES-GCM authenticates, so a wrong key throws rather than returning plausible rubbish — which is what makes trying keys in turn safe rather than reckless. Option A stores a key id beside every field and needs a registry to resolve it; B needs neither, and the cost is one extra decrypt attempt per retired key on the rare field written before the last rotation. The current key is tried first, so the common path is unchanged.

The property that matters is that rotation needs **no flag day**: move the old key to the retired list, put a new one in place, restart. Everything written from then on uses the new key and everything already written still decrypts. Re-encryption proceeds at leisure.

**Consequences.** The retired key must stay in the list until re-encryption finishes — dropping it early is indistinguishable from losing the data, and the error message says exactly that. A re-encryption job is not built; it is not needed until a first rotation is actually performed, and writing it before the operational procedure exists would be guesswork. Rotation is covered by unit tests across three key generations, because an untested rotation path is a data-loss incident waiting to happen.

---

### D27 — G7c answered: the sealed archive counts as complying · 2026-09-01 · **DECIDED**

**Answer.** Counsel confirms that retaining an encrypted, access-controlled clinical record without exposing it to subsequent doctors satisfies the record-keeping duty, on the basis that Neem is a pharmacy-initiated point-of-care consultation platform and not a longitudinal medical record. D23 and D24 stand as built.

**The product statement this rests on**, in the product owner's words: Neem fulfils its clinical role at the point of consultation, retains an auditable record of that encounter, protects it afterwards, and makes it retrievable through controlled access when legitimately required — **without creating an automatically accessible longitudinal patient medical history**. The retention architecture is therefore built around **encounter-level records, not patient profiles**.

**What this confirms, already built in Phase 5.5.** Encounter-level records; no patient profile or index; consultation reference as the retrieval key; sealed at completion; encrypted; excluded from any doctor-facing history; destroyed at the end of the retention period; the reference is an identifier and never an authentication credential.

**What it changes.**

1. **Retrieval is unblocked and is renamed.** Counsel is explicit: *"Do NOT build a conventional patient history feature. Instead, build an Archived Consultation Retrieval mechanism."* The term **break-glass is dropped** — it implies emergency clinical access by a treating clinician, which is precisely what this is not. This is controlled administrative retrieval. The architecture must stay open to a formal clinical break-glass workflow being added later *without redesign*, should counsel require one.

2. **Six permitted purposes, not four.** Counsel's list is wider than mine: legal or regulatory proceeding; a valid patient data-access request; an authorised clinical-record request where legitimately necessary; an approved quality or safety investigation; an approved research purpose, preferably de-identified; an authorised internal investigation or audit.

3. **The audit record needs more fields than I shaped.** Counsel requires the requester's **role** and the **date/time access ended**, neither of which the table had. Both added.

4. **"Protected against unauthorised modification/deletion"** is now an explicit requirement, and it is only partly satisfiable in the application. See the limitation below.

**Research access — permitted in principle, still not built.** Counsel allows an approved research purpose. It remains **out of V1**, consistent with D13, and needs a lawful basis and a consent mechanism that do not exist (G7d is still open). A research export over a sealed archive is the single most likely route by which this design quietly becomes the thing it was built to avoid, so it will not be added as a by-product of building retrieval. It is a deliberate feature with its own decision, or it is absent.

**A limitation stated plainly.** "Protected against unauthorised modification/deletion" is enforced in the application: sealed records reject writes, and only the retention job deletes. It is **not** enforced at the database level — the application's MySQL user necessarily holds DELETE on those tables in order to run the lawful destruction job, so anyone with those credentials can bypass the application. Genuine tamper-resistance needs a separate database role, or append-only storage, and is an operational change rather than a code one. Recorded here rather than left as an implied guarantee.

---

### D28 — Doctor compensation: pro-rata against a full-time baseline · 2026-09-01 · **DECIDED**

**Issue.** Open since Phase 0. `hourlyRateMinor`, `monthlySalaryMinor` and `contractedHoursPerWeek` existed and were nullable precisely because no formula had ever been settled, so nothing computed pay.

**Selected**, from the product owner:

> A full-time doctor working 40 hours is paid GHS 8,000 monthly. For part-time doctors, monthly compensation = GHS 8,000 × (contracted weekly hours ÷ 40).

**How it is held.** `doctor.fullTimeMonthlySalaryMinor` (800000 pesewas) and the 40-hour week are **settings**, not literals — the specification forbids hard-coding business values, and both will change. The formula is a pure domain function beside `splitRevenue`, with the same discipline: integer pesewas throughout, and an explicit rule for the remainder rather than a silent rounding.

**Rounding.** At the seeded values the arithmetic is exact — GHS 8,000 over 40 hours is exactly 20,000 pesewas an hour, so any whole number of hours divides cleanly. That will not survive the first change to either setting, so the remainder is resolved deliberately: compensation rounds **down** to the pesewa, and the function reports the remainder rather than discarding it silently. A doctor is never paid a fraction of a pesewa more than the formula yields, and the shortfall is visible to whoever runs payroll.

**Consequences.** Neem **still never transfers doctor salary** (spec §26). This computes an amount and shows it; payment is a manual, external act. That boundary is unchanged and deliberate — it is the difference between a reporting feature and a payroll system, and Neem is not a payroll system.

---

### D29 — The consultation reference is human-transcribable · 2026-09-01 · **DECIDED (Category B)**

**Issue.** D24 made the consultation reference the patient's only route back to their own record — Neem holds no patient profile, so nothing can be found by name or number. But the format was `generatePublicId('cons')`, which yields base64url: `cons_iEZh0HnqGo7q`. Case-sensitive, containing `-` and `_`, and full of the confusable pairs O/0, I/l/1. Counsel's own illustration was `NEEM-XXXXXXXX`.

That alphabet is fine for a machine-handled identifier and poor for one a patient keeps, reads down a telephone, or copies onto paper. Transcribability became a functional requirement the moment the reference became the retrieval key.

**Selected.** `NEEM-XXXX-XXXX-XXXX` — twelve characters of **Crockford's Base32**, grouped in fours.

**Rationale.** Crockford's alphabet omits I, L, O and U precisely because they are misread as 1, 1, 0 and V. Grouping in fours matches how people already transcribe card and licence numbers. Input is normalised on the way in: lower case, missing hyphens, a missing `NEEM` prefix and the confusable substitutions all resolve to the same record. "No consultation exists with that reference" is indistinguishable from the record having been destroyed, and turning someone away on a typo would be a poor way to service a data-access request.

**On the entropy, since it went down.** Twelve characters of a 32-symbol alphabet is 60 bits, against 72 for a base64url id. That is deliberate and safe here because counsel is explicit that this is **an identifier, not an authentication credential**: quoting it says which record is meant, and opening one still requires two administrators and a stated purpose. Every other route taking it checks ownership and answers 404. What 60 bits buys is collision safety — the birthday bound sits near a billion consultations, so uniqueness does not rest on retry alone.

**Scope.** Consultations only. Every other `publicId` stays base64url, because no human transcribes a user or doctor id. Older `cons_...` references still resolve; normalisation returns unrecognised input unchanged rather than padding it into a plausible reference, so a truncated reference fails the lookup instead of silently matching someone else's record.

**Consequences.** Changed while all data is synthetic. Once real references are printed on prescriptions and referrals this would have been expensive and disruptive, which is why it was raised before Phase 6 rather than after.

---

### D30 — A patient session is readable after the consultation ends, and actable only while it runs · 2026-09-02 · **DECIDED (Category B)**

**Issue.** `resolvePatientSession` gated on `patientSessionIsUsable`, the set of states in which a patient may still *do* something. That set stops at `IN_PROGRESS`, so the session stopped resolving the instant the doctor completed. The patient's phone polls every five seconds; the poll after completion returned 401 and the portal rendered "Session ended. Please ask the pharmacy for a new consultation code."

Two things were unreachable as a result, neither of them noticed because every route involved passed its own tests:

- **The consultation reference (D24).** D24 made it the patient's only route back to their own record, on the reasoning that a receipt needs no account. The screen that hands it over is `CompleteStep`, which no patient could ever reach. The decision was implemented; the delivery was not.
- **Feedback.** There is no moment before completion at which asking makes sense, and none after it in which the patient could be asked.

**Decision.** Reading a session and acting through one are separate rights.

- `patientSessionIsReadable` covers the active states plus `COMPLETING`, every terminal state, and `REFUND_REQUESTED`. Resolution uses this.
- `patientSessionIsUsable` is unchanged, and every mutating patient route now asserts it explicitly through `assertPatientCanAct`.

**Why the guard is per-route rather than implicit.** Widening the resolve without it would have let a completed consultation's language or mode be rewritten — `selectLanguage` had no state check of its own, and `selectModeAndEnterQueue` wrote `type` before checking anything. The assertion sits at each call site because that is where the answer differs; a single wider predicate is what created this problem in the first place.

**A second defect fell out of it.** `buildSessionView` tested the onboarding steps before the consultation's state, so a consultation that ended before the patient finished a step reported that step. A consultation cancelled while the patient was choosing a language would have shown them a language picker. This was unreachable while sessions died at the end and became reachable the moment they stopped; the outcome now outranks the ladder.

**Consequences.** The window is bounded by `PATIENT_SESSION_TIMEOUT_MINUTES` (60), unchanged. Nothing new is disclosed: the session view carries what it always carried, and the clinical record is sealed at completion by a separate mechanism (D23) that this does not touch.

---

### D31 — A refund follows the money, not the consultation · 2026-09-02 · **DECIDED (Category B)**

**Issue.** `REFUND_REQUESTED` was reachable only from live states — ACTIVATED, WAITING_FOR_PATIENT, PATIENT_JOINED, WAITING_FOR_DOCTOR. Every terminal state was a dead end.

That left the clearest refund case in the product with no route at all. A consultation reaches ACTIVATED only once money has been taken, and from there it can expire unscanned, be cancelled by the pharmacy, or be abandoned by the patient. All three mean someone paid and received nothing, and in all three the refund routes could not so much as record the request.

**Decision.** `EXPIRED`, `CANCELLED` and `ABANDONED` accept a transition to `REFUND_REQUESTED`, and `REFUND_REQUESTED` can return to any of them if the request is declined.

**`COMPLETED` is deliberately excluded.** A consultation that happened was delivered. A patient unhappy with the care they received has a complaint — captured in Phase 6.5, reviewed by an administrator — and not an automatic claim on the fee. The line is between "did you receive the service" and "was the service good": different questions, different remedies, and collapsing them would make every quality dispute a billing dispute.

**What a request does depends on where the consultation is.** A live consultation is moved to `REFUND_REQUESTED`, which holds it while the decision is pending; a finished one is left exactly where it is, because the refund is a fact about the money rather than a second ending. On rejection the prior state is restored from the state event log, which already records `fromState` — storing it a second time on the refund row would be a copy of the same fact with its own way of being wrong.

**Consequence, and the thing that nearly broke.** Making a terminal state re-enterable means a consultation can now cross into terminal twice: once when it ended, and again at `REFUNDED`. `transition()` released doctor capacity on every non-terminal→terminal crossing, so the second one would have decremented a count the consultation no longer held and handed the doctor a slot they were not free for. The release is now guarded on `clinicalSealedAt`, which the seal sets on the first crossing. The existing comment claimed `GREATEST(currentLoad - 1, 0)` made a repeat harmless; it prevents a negative count, which is not the same thing.
