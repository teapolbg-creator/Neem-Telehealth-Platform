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
**Rationale.** Single-use applies to the _token_; the _session_ is what carries the patient through. This satisfies the security requirement without a hostile experience.
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

| Ref    | Item                                                             | Blocking                                                                                                                                      |
| ------ | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| C9     | Twilio Programmable Video roadmap — verify with Twilio directly  | The real media adapter. Phase 5 shipped on mocks (D18)                                                                                        |
| ~~G7~~ | ~~Minimum legal retention period for clinical records in Ghana~~ | **CLOSED 2026-08-29 — a minimum exists. See D23.** Six follow-on questions remain with counsel, tracked as G7a–G7f in `data-retention.md` §10 |
| —      | Node.js 22 + Docker Desktop installation                         | Any running code                                                                                                                              |

---

### D18 — Video and voice ship on mock adapters until Twilio is confirmed · 2026-08-29 · **DECIDED — video superseded by [D35](#d35)**

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

**Issue.** G7, flagged in Phase 0 as _"would be architectural if a minimum retention period exists"_, was answered by the product owner on 2026-08-29 from Medical & Dental Council sources. A minimum does exist. Deleting consultation notes at completion breaches the record-keeping duty on registered practitioners under the Health Professions Regulatory Bodies Act, 2013 (Act 857), and destroys the evidence both parties need during the 3-year civil window for a negligence claim. The Data Protection Act, 2012 (Act 843) permits — and where another law mandates, requires — retention of health data.

**What this reverses.** Phases 0–5 were built on "clinical information exists only for the duration of the consultation" (spec §16, §62, §101). That is now wrong. The completion purge, which was the headline deliverable of Phase 6, does not survive in that form.

**The distinction that decided the rest.** The finding contains two obligations that are routinely conflated: _record-keeping_ (the records must exist) and _continuity of care_ (a future clinician should read them). Only the second collides with spec §13. The first is satisfied by an archive nobody reads.

**Selected.** Records retained **3 years from completion**, encrypted at rest, **readable through no product surface** — the "sealed archive" option. Configurable via `retention.clinicalRecordYears`.

**Rationale.** The most protective position that still counts as complying with the record-keeping duty. The continuity-of-care argument is deliberately declined: no clinician sees a patient's past. This is reversible in the safe direction — the records will exist, so opening a consented read path later is an added feature, not a migration. The reverse would not have been true.

**Consequences — the honest list.**

1. **Spec §13's "no medical history" ceases to be a guarantee about the data and becomes one about access.** A patient index must exist, because a subject-access request, an MDC inquiry, and a negligence claim all require producing a named patient's records. Per-consultation islands cannot service any of them. Restated in `data-retention.md` §3.
2. **Vitals and point-of-care results are stored in plaintext.** Defensible when they lived for minutes; not over three years. They need field encryption like the notes already have.
3. **Key management becomes load-bearing.** One `ENCRYPTION_KEY` with no rotation path is thin for data with a multi-year life.
4. **The patient-facing deletion promise is now false.** _"Your details and everything discussed have been deleted"_ must be replaced, and a notice stating the lawful basis added at capture — the product currently states no basis anywhere.
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

1. **The reference identifies; it does not authorise.** Quoting a number tells Neem _which_ sealed record is meant. Opening it still requires the two-person authorisation and stated purpose of Archived Consultation Retrieval (D27, renamed from break-glass on counsel's instruction). Otherwise a discarded prescription slip becomes a key to someone's clinical record.
2. **Retrieval is reference-scoped**, not person-scoped. There is no "show me everything about this patient" path, by design.
3. **Subject access becomes "quote your reference"** — a recognised privacy-preserving pattern, not an evasion.
4. **Every consultation must put the reference in the patient's hands**, whatever the outcome. Advice-only consultations previously produced no artefact at all; D25 resolves that.
5. **One caveat that must be stated accurately to counsel.** `prescriptions` permanently stores `patientName`, `patientAge` and `patientSex` by value, following spec §11 and predating this decision. A name search against that table is therefore technically possible for anyone with database access. What this decision removes is the **feature**: no product surface indexes by patient, and clinical notes are reachable only by consultation reference. Nobody should tell a regulator that Neem _cannot_ search by patient.
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
3. **It is not called a medical report.** In Ghana that phrase is used for employment, insurance and court purposes; naming it so invites it being presented as something it is not. It is a _consultation summary_. For the same reason it documents what the doctor found and advised — it does not justify the fee.

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

1. **Retrieval is unblocked and is renamed.** Counsel is explicit: _"Do NOT build a conventional patient history feature. Instead, build an Archived Consultation Retrieval mechanism."_ The term **break-glass is dropped** — it implies emergency clinical access by a treating clinician, which is precisely what this is not. This is controlled administrative retrieval. The architecture must stay open to a formal clinical break-glass workflow being added later _without redesign_, should counsel require one.

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

**Issue.** `resolvePatientSession` gated on `patientSessionIsUsable`, the set of states in which a patient may still _do_ something. That set stops at `IN_PROGRESS`, so the session stopped resolving the instant the doctor completed. The patient's phone polls every five seconds; the poll after completion returned 401 and the portal rendered "Session ended. Please ask the pharmacy for a new consultation code."

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

---

### D32 — There is no in-app notification archive · 2026-09-03 · **DECIDED (Category B)**

**Issue.** `notifications` stores `renderedPayloadHash`, not the rendered body. That was decided in Phase 0 for a good reason — a notification history holding the text of every message would be a second copy of personal data, growing beside the record it was supposed to summarise (spec §60, docs/database.md).

Building Phase 8 made the consequence concrete: **a notification bell with a list of past messages cannot be built.** There is nothing to list. The obvious workarounds are all worse:

- _Store the body for IN_APP only._ The channel a message went out on has nothing to do with how sensitive it is, and this would create exactly the archive the schema exists to prevent.
- _Store the variables and re-render._ Identical in effect. `{ consultationReference, pharmacyName }` reconstitutes the message perfectly.
- _Store nothing and show nothing._ Leaves a doctor who was offline with no way to learn what they missed.

**Decision.** In-app notification is **real-time only**, and the durable surface is the work queue itself.

- A socket emit reaches whoever is looking at the screen.
- A doctor who was not gets the same information from the queue they would have to visit anyway: `/doctor/substitutions` lists what is awaiting their decision, `/doctor/queue` what is offered, `/admin/refunds` what is awaiting a decision.
- The `notifications` row records that a dispatch happened, with a hash — enough to answer "was this sent" and "did it fail", and not enough to reconstruct what it said.

This is the same reasoning that produced the substitution inbox in Phase 6.5, and the phrase used there still applies: **a work queue rather than a notification.** A queue is better than an archive anyway — it shows what still needs doing rather than what was once announced.

**Consequence for retries.** A failed message cannot be re-sent verbatim, because the text is gone. Templates that take no variables re-render exactly from the catalogue and are retried; the rest are marked `SUPPRESSED` with the reason recorded, rather than re-sent with a placeholder in them. That is a real limitation and is stated in the module rather than hidden.

**What this does not change.** SMS, email and WhatsApp still deliver a full message to the recipient's own device. The restriction is on what Neem keeps, not on what it sends.

---

### D33 — The list of public routes is code, and the build enforces it · 2026-09-03 · **DECIDED (Category B)**

**Issue.** Phase 10 asked for a "full authorization audit". An audit is a
snapshot: it tells you the API was sound on the day someone read it. Neem will
have routes added for years after that day, and the failure this audit exists
to prevent — a route registered without a guard — is precisely the one that
announces nothing. It returns 200. It looks like it works.

Auditing by reading is also how the _other_ Phase 9 defect happened in reverse.
Four routes existed with no caller and nobody noticed, because reading code
tells you what is written, not what is reachable.

**Decision.** The authentication boundary is a data structure in the test
suite, and a sweep enforces it against the **live Fastify route tree**.

`INTENTIONALLY_PUBLIC` maps fifteen `METHOD /path` keys to the reason each one
is unauthenticated — "you cannot be signed in in order to sign in", "the
provider has no session; the HMAC is the authentication". The sweep enumerates
every route the router actually serves, calls each one anonymously, and fails
on any that answers without appearing in the map. A second assertion fails on
any entry in the map that no longer matches a live route, so a renamed route
cannot leave behind a line that pre-authorises the next thing to take its name.

**Three consequences, all of them the point.**

- A route added next month is in scope next month, with nobody remembering.
- Making a route public becomes an argument in review rather than an omission
  in middleware.
- The reasons are versioned next to the list, so "why is this public" has an
  answer that does not depend on who is still working here.

**A 404 counts as a failure.** It means the handler ran and looked the record
up before deciding it had nothing to say — which is one schema change away
from saying something. Only 401 and 403 pass.

**Why not enforce it in the application instead**, refusing to register a route
without a guard? Because `/auth/login` has to exist, so the mechanism needs an
exception list either way, and an exception list in the application is
consulted at boot by a process with no way to complain to a human. In the test
suite it fails a build, which is where a security decision should be argued.

---

### D34 — Leaving a consultation revokes the session, not the cookie · 2026-09-03 · **DECIDED (Category B)**

**Issue.** `POST /patient/session/leave` called `reply.clearCookie` and nothing
else. That is a reasonable-looking implementation and it protects exactly one
person: whoever is currently holding the phone.

The patient's device in this product is a handset at a pharmacy counter. The
threat is not a private laptop left unlocked — it is a token that was copied,
screenshotted, or read off a shared phone before it was handed back. Against
that, clearing a cookie in the victim's browser does nothing at all: the
attacker's copy was never in that browser.

Staff logout has revoked server-side since Phase 2 (`revokeSession`). The
asymmetry was not a decision anyone made; the patient path simply never got
the same treatment, and it is the path with the weaker device.

**Decision.** Leaving ends the session on the server. `endPatientSession` sets
`expiresAt` to now, which the existing expiry check in
`resolvePatientSession` already honours, so every copy of the token stops
resolving on its next request.

**Expiring rather than deleting**, because re-entry has to keep working. A
patient who tapped the wrong thing scans a fresh QR code, and
`exchangeAccessToken` upserts a new token hash and expiry over the same row.
Deleting would have meant losing the identity the patient had already entered.

**The test steals the token before leaving.** A test that calls `leave` and
then checks the same cookie fails would pass against the old implementation
too, because the response cleared it. Copying the cookie first is the only
version of this test that distinguishes the two behaviours, and it is worth
saying out loud that the weaker test would have looked identical in the report.

---

### D35 — Video and in-browser audio move to Whereby; Call Me still has no provider · 2026-09-06 · **DECIDED**

**Issue.** [D18](#d18) parked video on a mock rather than build against Twilio
Programmable Video, whose end-of-life status was never confirmed. That was the
right call and it left the product's central function simulated: two people
could not see or hear each other. It was the largest single gap between "the
build is complete" and "the product can be used".

**Selected.** Whereby Embedded, chosen by the product owner on 2026-09-06 and
subscribed on the Build plan.

**What it costs.** $9.99/month including 2,000 participant-minutes, then
$0.004 per participant-minute. Only two people join a room — the pharmacy
does not — so an eight-minute consultation is sixteen participant-minutes,
about six US cents against a GH₵40 fee. Media is not a constraint on this
business at pilot scale.

**What changed in the code.** One new adapter, `WherebyVideoProvider`. The
`VideoProvider` interface did not change: it was written provider-agnostic in
Phase 5 and the shape held. Two smaller things followed from Whereby being
URL-based rather than token-based — `JoinToken.endpoint` (already in the
interface, previously unused) now carries the room URL, and `MediaSessionView`
gained `joinUrl` so the browser can reach it.

**Three consequences worth stating plainly.**

**Call Me is not solved.** Whereby is browser-to-browser and publishes no PSTN
capability. Call Me dials both parties and bridges them so neither learns the
other's number (spec §33); that still has no implementation, and it is the mode
that works on a feature phone. `VOICE_PROVIDER` remains `mock`, and choosing
anything else throws at boot rather than degrading quietly.

**The no-recording guarantee is now part architectural, part operational.**
`VideoProvider` has no method that could request a recording, and the adapter
sends no `recording` object — `whereby-adapter.test.ts` asserts the request
body has no such key. But Whereby's dashboard can enable recording
independently of this repository. Consultations are never recorded (spec §32),
and that guarantee is now only as strong as an account setting nothing in the
code can see. Recorded in `docs/security.md` as an operational control, which
is weaker than what it replaced and is said rather than hidden.

**Room URLs are bearer capabilities.** Whoever holds one can join, and the
doctor's carries a host key. So the room is deleted at completion rather than
left to expire — Whereby keeps a room reachable for an hour past its end date,
which would otherwise outlive the sealing of the clinical record. The URL is
never logged, never audited, and returned only to the authenticated participant
it was minted for.

**The browser embed.** `WherebyStage` renders Whereby's `<whereby-embed>`
element and Neem's own controls drive it — the room URL carries `minimal=on`
and `leaveButton=off` so there is only ever one set of controls. Three things
about it were not obvious:

- **It loads in the browser only.** The SDK touches `document` at module scope,
  so a top-level import throws while TanStack Start renders the consultation
  page on the server, taking down the whole screen rather than just the video.
  The module is imported inside an effect and the element is withheld until it
  is registered — an unregistered custom element renders as an inert empty box,
  which would have looked like a camera that never started.
- **Only one thing may hold the camera.** The mock path renders a local preview
  through `getUserMedia`; the embed acquires devices in its own frame, and on
  several Android browsers the second caller gets nothing. The two paths are
  mutually exclusive, keyed on whether the server returned a `joinUrl`.
- **Chat, screenshare, people and breakout are off.** Chat is not cosmetic:
  in-consultation text was cut in [D15](#d15) for want of a retention rule, and
  a chat panel inside the video is exactly that decision undone.

**A recording alarm, because the guarantee is now partly operational.** The
embed raises `recording_status_change`, and the stage turns any status other
than "not recording" into a red banner telling both parties to stop. It
prevents nothing — it makes visible the one thing the code can no longer
prevent. The source-wide grep that forbids asking a provider to record now
covers `apps/web` too, because `startRecording()` is a method the browser
holds; that widening was verified by adding a call and watching the test fail.

**Still unproven.** The adapter's tests stub `fetch`, so they establish what
Neem asks for and not that Whereby agrees; `npm run whereby:check` exercises
the real API with the operator's own key. **No consultation has yet carried
real media** — that needs a key, which the build does not have. Whether it
holds up on Ghanaian mobile networks and low-end Android browsers is separate
work that no adapter can stand in for.

---

### D36 — Twilio is removed entirely, and voice has no provider · 2026-09-06 · **DECIDED**

**Issue.** Twilio was named throughout the build as the intended provider for
video, voice, SMS and WhatsApp, and implemented for none of them except
notifications. [D35](#d35) moved video to Whereby. What remained was a set of
pointers to a vendor the product is not going to use — in `.env.example`, in
the provider enums, in the interface documentation — which reads as a plan
rather than as the dead end it is.

**Selected.** Remove it. `TwilioNotificationProvider` is deleted, every
`TWILIO_*` variable is gone from configuration, and `twilio` is no longer a
value any provider enum accepts.

**A provider name that throws at boot is worse than no name at all**, which is
the reasoning behind removing it from the enums rather than keeping it as a
loud failure. `VOICE_PROVIDER=twilio` failing with "not implemented" reads as a
capability that merely needs configuring. `VOICE_PROVIDER` accepting only
`mock` states the truth: there is nothing to select.

**The consequence, which is larger than the change.** Production refuses a mock
adapter — a mock reports messages that were never sent — so with Twilio gone
there is **no value for `VOICE_PROVIDER`, `SMS_PROVIDER` or
`WHATSAPP_PROVIDER` that a production environment will accept. This build can
no longer be deployed to production at all.**

That is not a regression introduced by deleting code. Those capabilities were
never implemented; what has changed is that the configuration now says so
instead of naming a vendor and implying the work was a credential away. The
production guard was given a second message for exactly this case, so an
operator reads "there is nothing else to set it to: no SMS provider is
implemented" rather than "mock is not permitted", and goes looking for a
decision rather than for a setting they got wrong.

**SMS is the one that blocks a launch.** A patient's consultation reference
reaches them by SMS and it is their only route back to their own record
([D24](#d24)). Call Me is a mode that can be dropped; SMS is load-bearing for a
guarantee already made to patients.

**Hubtel was considered for Call Me and does not offer it.** The product owner
proposed Hubtel, a Ghanaian provider. Its developer portal and documentation
index list Settlement, Payments, Customer Verification, Transactions and SMS —
**no voice API, no call bridging, no IVR**. Call Me needs a provider that dials
two legs and bridges them so neither party learns the other's number (spec
§33), and nothing in Hubtel's published surface does that. Hubtel remains a
strong candidate for **SMS**, which is the more urgent gap.

**Consequences.** Two spec §100 acceptance criteria — patient Call Me, and
notification delivery — are not met and are reported as outstanding.
`npm run check:production-config` now always fails, deliberately, until a
provider is chosen for SMS at minimum.

---

### D37 — SMS is Hubtel; Call Me is deferred to the pilot · 2026-09-06 · **DECIDED**

**Issue.** [D36](#d36) left SMS with no provider, which blocked a launch rather
than merely removing a feature: a patient's consultation reference reaches them
by SMS and it is their only route back to their own record ([D24](#d24)). Neem
keeps no patient profile, so a message that does not arrive leaves the patient
with no way at all to find what happened to them.

**Selected.** Hubtel for SMS, chosen by the product owner on 2026-09-06.
`POST https://smsc.hubtel.com/v1/messages/send`, HTTP Basic over a client id
and secret, an alphanumeric sender ID.

**Three things the adapter does that are not obvious.**

**Credentials go in the header, never the query string.** Most of Hubtel's own
examples pass `clientid` and `clientsecret` as query parameters. A query
string reaches access logs, proxy logs and error reports, and these are account
credentials.

**A 200 with no message id is not a send.** An empty answer from a gateway is
recorded FAILED rather than SENT. Recording it as sent would put a lie in the
notification log, and a patient whose reference never arrived would be
indistinguishable from one who got it.

**A number that cannot be understood is refused before the call is made**, not
retried. `toGhanaMsisdn` accepts `0244123456`, `233244123456` and
`244123456`, and rejects everything else. This is the part of the adapter that
matters most, and a test caught a real bug in it: the "no trunk zero" rule was
`d{9}`, which also matched `024412345` — a local number one digit short —
and turned it into `233024412345`. That is not the patient's number, may well
be somebody's, and would have received their consultation reference.

**Registration is the risk, not the code.** Ghana's networks reject numeric
international senders outright and block unregistered alphanumeric ones — MTN
began enforcing this in July 2026. An unregistered sender is **accepted by the
API and dropped by the network, silently**, so the integration looks healthy
and delivers nothing. `HUBTEL_SENDER_ID` is therefore required at boot rather
than defaulted, and `npm run hubtel:check -- --to <number>` sends one real
message so a handset, not a log line, confirms it works.

**Call Me is deferred to the pilot**, deliberately and not for want of trying.
It needs a provider that dials two legs and bridges them so neither party
learns the other's number (spec §33). Checked and ruled out: **Hubtel**
publishes no voice API at all; **Arkesel**'s Voice SMS is one-way broadcast
("plays a recorded message down the line") and its VoiceConnect is a contact
centre rather than a documented bridging API; **Africa's Talking** does not
offer Voice in Ghana at all — its own country table lists Ghana as SMS, USSD
and Airtime only. Twilio does support it and was removed in D36.

So `VOICE_PROVIDER` remains `mock`-only, production still refuses to boot,
and the reason is now one capability rather than three. Whether Call Me is
needed is a question the pilot can answer with evidence — how many patients
arrive at a counter unable to use the QR flow — rather than a guess made now.

**Consequences.** WhatsApp still has no provider and is unused. Delivery
reports are requested (`RegisteredDelivery: true`) but nothing consumes them:
there is no Hubtel callback route, so `notifications` records SENT meaning
"the gateway accepted it". Closing that gap needs a webhook endpoint and is
worth doing once real delivery rates are visible.

---

### D38 — "Call Me" is switched off, not mocked · 2026-09-06 · **DECIDED**

**Issue.** [D37](#d37) left one thing blocking a deployment: `VOICE_PROVIDER`
could only be `mock`, and production refuses a mock — so no production
configuration could be completed at all. The product owner decided to defer
Call Me to the pilot, which means the build needs a way to say "this capability
is off" that is not the same as "this capability is pretending".

**Selected.** `VOICE_PROVIDER=none`, and it is now the default.

**`none` and `mock` are different states, and conflating them is what
blocked the deploy.** A mock _pretends_: it reports a bridged call that never
happened, which is exactly why production refuses it and must go on refusing
it. `none` does not pretend — the mode is not offered to a patient, the
server refuses it, and nothing anywhere claims a call took place. That is a
product decision a deployment is entitled to make, and the configuration can
now express it.

**Where "off" is enforced.**

`getVoiceProviderOrNull()` is the single place that decides, and everything
else asks it — the patient's mode list, the routes, the guard. Nothing reads
`VOICE_PROVIDER` on its own. It also honours a provider injected for testing,
which is why the integration tests still exercise the bridge while the mode is
off everywhere else.

The patient's session view now carries `availableTypes`, built on the server,
and the mode screen renders that rather than a constant of its own. A button
that leads to a rejection is worse than no button: the patient is standing at a
counter and cannot tell a product decision from a fault.

**And the filtering is not the boundary.**
`selectModeAndEnterQueue` refuses `CALL_ME` outright when it is off, so a
request naming it is rejected whatever the client believed — the same rule as
everywhere else in this system, that the UI decides what to render and the API
decides what is allowed. A test asks for `CALL_ME` directly and asserts the 422.

**What is not lost.** The `VoiceProvider` interface, the mock, the bridge
service and its integration tests all stay. The end-to-end Call Me scenarios
are `describe.skip` with the reason written above them rather than deleted,
because a scenario that vanishes looks like coverage nobody thought about.
Turning the mode back on is: implement an adapter, add it to the enum, set the
variable, delete one `.skip`.

**Consequence.** Production configuration is completable again — the remaining
items are credentials and secrets rather than gaps in the build. Whether Call
Me is needed at all is now a question the pilot answers with evidence: how many
patients arrive at a counter unable to use the QR flow, and whether they need a
conversation or only their consultation reference.

---

### D39 — SMS moves to Arkesel; Call Me stays unresolved · 2026-09-06 · **DECIDED / PARTLY OPEN**

**Issue.** The product owner asked Arkesel's support about voice, and moved SMS
to them on the strength of the answer.

**SMS: selected, and built.** `POST https://sms.arkesel.com/api/v2/sms/send`,
the key in an `api-key` header, `sender` / `message` / `recipients`.
Arkesel distinguishes its failures by status code, so the adapter does too —
401, 403 and 422 are permanent, 429 and 5xx are retried. Getting that boundary
wrong is expensive in both directions: retrying a permanent failure buries the
queue, and giving up on a transient one loses a patient's consultation
reference.

**Hubtel is kept, not deleted.** It is built, tested and working, and a second
SMS provider is real resilience during a pilot in a market where one gateway
can have a bad week. `SMS_PROVIDER` chooses. That is different from Twilio in
[D36](#d36), which was removed because nothing was ever implemented for it — a
name that could not be used. Both of these can.

The Ghana number normaliser is now shared rather than copied per adapter, and
the scripts' `.mjs` copy is compared to it case by case by a test. It is the
function where being wrong is worst — a number guessed at does not fail to
arrive, it arrives at a stranger.

**Call Me: NOT selected, and the reason matters.** The support exchange does
not establish the capability Neem needs, and it would be easy to read as if it
does:

> "So can a voice call be outbounded from my app to a customer's phone number?"
> "Yes, with Arkesel's Voice Connect feature, you can make outbound voice calls
> from your app to a customer's phone number."

Two problems. The reply came from **"~ Arkesel Assist"**, an automated
assistant, and it had already said of the first question that "the context does
not specify the exact mechanics" — a hedge, carried into an answer that reads
as a confirmation.

More importantly, **"an outbound voice call from your app to a customer's
phone" is exactly what Arkesel's documented Voice SMS already does** — it
"plays a recorded message down the line to a number you supply". That sentence
is true of a one-way broadcast and true of a bridged call, and Call Me needs
the second: the patient's handset rings, **a doctor speaks live on the other
end**, and neither party learns the other's number (spec §33).

So Call Me remains `VOICE_PROVIDER=none` ([D38](#d38)) until a human at
Arkesel answers a question that distinguishes the two. The question is recorded
in `docs/compliance/README.md` alongside the other things awaiting an external
answer, because a decision made on an ambiguous sentence from a chatbot is the
kind that surfaces during a pilot with a patient waiting.

---

### D40 — The API is bundled with esbuild, not compiled with tsc · 2026-09-06 · **DECIDED**

**Issue.** `npm run build` had never worked for the API, and nothing noticed
because development never runs it. Three faults, stacked:

1. `tsc -p tsconfig.build.json` failed with **462 `TS5097` errors**. Every
   import in this codebase carries a `.ts` extension — which is what `tsx`
   and Node's own type stripping require — and `tsc` cannot emit those.
2. It emitted **anyway**, to `dist/apps/api/src/` rather than `dist/`, while
   `npm start` ran `node dist/server.js`.
3. The JavaScript it produced **still imported `.ts` paths**, so even run from
   the right place it died on its first import with `ERR_MODULE_NOT_FOUND`.

**Selected.** esbuild, bundling `src/server.ts` to a single
`apps/api/dist/server.js`. It rewrites the specifiers as it bundles, which
removes the problem at its root rather than rewriting several hundred import
statements to satisfy a compiler nobody was using.

**What is bundled and what is not.** `apps/api/src` and
`packages/contracts/src` are bundled — contracts is published as TypeScript
source with no build of its own, so it cannot survive as a runtime import.
Every real dependency stays external and is resolved from `node_modules`,
which matters most for `@prisma/client` (generated, with platform-specific
query engines) and `@node-rs/argon2` (native). The external list is read from
`apps/api/package.json` rather than written into the build script, so adding a
dependency cannot silently start bundling it.

**Types are checked separately, and that is deliberate.** esbuild strips types
without checking them; `npm run typecheck` checks them. The old arrangement had
the build acting as a second, differently-configured type check that disagreed
with the first — which is how it accumulated 462 errors nobody saw.

**The build found a second bug, which is the point of running things.**
`load-dotenv.ts` resolved the repository root by counting directories:
`../../../../.env` from `src/config`. The bundle puts that same code in
`dist/`, where four levels up is a directory _outside_ the repository — so the
built API loaded no configuration at all and refused to boot with
"DATABASE_URL: Required", which reads like a missing variable rather than a
build that moved the file. It now searches upward for the nearest `.env`,
which is correct as source, correct as a bundle, and correct again for a
deployment that puts a `.env` beside the artefact.

**Verified by running it, not by the build exiting zero.** The bundle boots,
loads configuration, connects to the database, answers `/health` and
`/health/ready`, starts the scheduler and the realtime server — and the full
end-to-end suite passes against it: **47 passed, 0 failed**, the two skips
being Scenario 15's documented `fixme` and the Call Me suite disabled in
[D38](#d38).

**Still absent: continuous integration.** There is no `.github`, so nothing
runs this build except a person choosing to. That is how it stayed broken, and
a green build today is not a guarantee about tomorrow.

---

### D41 — Continuous integration, and what each job is for · 2026-09-06 · **DECIDED**

**Issue.** [D40](#d40) fixed a build that had been broken for eleven phases and
ended by naming the reason it stayed broken: nothing ran it except a person
choosing to. A green build that day said nothing about the next one.

**Selected.** GitHub Actions, three jobs, split by how long you should be
willing to wait.

`check` is lint, typecheck, build and the 337 unit tests — about five minutes,
no database. Everything else waits on it, so a lint error does not burn an hour
of runner time before reporting. **The build step is the point of the whole
file**; the rest is worth having but would not have caught what was actually
wrong.

`integration` runs the Vitest suite against a real MySQL 8.4 service. It is
slow — most of an hour — and that is a property of the tests rather than a
problem to optimise away: unique constraints, transactional atomicity and
payment idempotency are much of what is being asserted, and a mock cannot show
any of them. It then **boots the built artefact and calls `/health` and
`/health/ready`**, because building and running are different claims and only
one of them was ever checked. That step exists specifically for the
`load-dotenv` bug in D40, where the bundle compiled cleanly and then could not
find its configuration.

`e2e` runs Playwright, and uploads the report, the traces and the API log when
it fails. A Playwright failure is close to unreadable without them, and the API
log is usually where the cause is — the Phase 11 deadlock presented as tests
skipping for reasons that had nothing to do with the deadlock.

**Two details that would otherwise bite.** The unit job asserts no database,
which was verified by running the suite against an unreachable one rather than
assumed. And both database jobs install a MySQL client explicitly:
`scripts/mysql-cli.mjs` falls back to `docker exec neem-mysql` when the host
has none, and a service container is not called that.

**Not addressed.** There is no deployment pipeline here, and no branch
protection — CI reports, and nothing yet requires it to be green before a merge.
That is a repository setting rather than a file, and it belongs to whoever owns
the GitHub organisation.

---

### D42 — Call Me capacity is a setting, and the call rate limit stops being a constant · 2026-09-09 · **DECIDED**

**Issue.** The pilot is going ahead on a deliberately small footprint: one
pharmacy, two doctors, and an Arkesel subscription for **one simultaneous
voice call**. Month two adds four more pharmacies, with the doctor count and
the number of lines decided from month one's data rather than guessed now.

One line is a hard capacity limit the system had no idea about. Nothing counted
live bridges, so a second Call Me request would have been dialled and failed
somewhere inside the provider — at a pharmacy counter, with a patient waiting,
and reported to the doctor in whatever words the provider chose.

**Selected.** `media.maxConcurrentBridgedCalls` in `system_settings`, default
1, checked before anything is dialled.

Three details are the decision rather than the implementation:

- **It is a setting, not a constant.** The limit is commercial — it changes in
  month two by buying more capacity. A deploy is the wrong unit of change for
  that, and the spec already says business config lives in `system_settings`.
- **It is counted from our own records, not asked of the provider.** The answer
  is needed on the path about to dial; a round trip there is latency at a
  counter, and a provider that is briefly unreachable must not read as "no
  calls in progress" and let us exceed what we pay for.
- **A consultation does not compete with itself.** A doctor pressing the button
  twice gets their existing call, not a capacity error, so the guard excludes
  the consultation asking.

The refusal names the alternative — audio or video — because a pharmacy needs
something to do, not only something to read.

**Found while doing it: the call route's rate limit was hard-coded** at 10 per
5 minutes, alone among every limit in the system. The number was defensible;
being unreachable was not. It could not be tuned for a deployment and could not
be raised for the test suite, which is how it surfaced — four new tests placed
enough calls to throttle two existing ones, and the failure looked like a bug
in the new tests. It is now `RATE_LIMIT_CALL_MAX` / `_WINDOW`, defaulting to
the values it used to hard-code, raised in `tests/setup.ts` like its
neighbours, and given a production ceiling. It matters more now than when it
was written: every call costs money and occupies one of a very small number of
lines.

**Still open: whether Arkesel can carry this at all.** [D39](#d39) refused to
enable Call Me on the strength of a chatbot reply that could not distinguish a
one-way recorded broadcast from a live bridged call. The product owner has now
met Arkesel's technical team, who named **Voice Connect IVR** and quoted ten
simultaneous calls, growing with demand. That is a human answer and a real
capacity number, and it is not yet an answer to D39's question — "IVR"
conventionally describes recorded menus and keypad input, which is not what
spec §33 needs. What is needed is confirmation that the patient's handset
rings, **a doctor speaks live on the other end**, and neither party learns the
other's number.

So `VOICE_PROVIDER` stays `none` and no Arkesel voice adapter is written until
that is confirmed in writing along with the API itself. The capacity work above
is deliberately provider-agnostic and lands now, because it is needed whichever
provider answers.

---

### D43 — The database is PostgreSQL on Supabase, not MySQL · 2026-09-10 · **DECIDED**

**Issue.** The product owner chose Supabase to host the database. Supabase is
PostgreSQL; this system was MySQL 8 throughout. The request was phrased as
"set up a database", which is worth correcting because the correction is the
whole shape of the work: **the database already existed** — 60 models, 31
enums, every collection point wired to it, including `media_sessions` carrying
`VOICE_BRIDGE` for a Call Me feature that has no provider yet. What did not
exist was a _hosted instance_, and what stood between the two was a change of
engine.

Done now rather than later, on one argument: there is no production data, so
this is as cheap as it will ever be. A month into the pilot it would be a
migration with patients' records in it.

**What actually had to change**, because "switch the provider" is not the job:

- **The migration history.** MySQL SQL cannot be applied to Postgres, so the
  eight migrations were archived to `docs/archive/` and replaced with a single
  initial migration: 60 tables, 31 _native_ Postgres enums.
- **Case sensitivity, which fails silently.** MySQL's default collation matched
  regardless of case; Postgres does not. Eleven `contains:` searches across
  doctors, pharmacies and pilot applications now pass `mode: 'insensitive'`.
  Without it an administrator typing "korle" finds nothing while "Korle" finds
  the row — a search that fails by returning an empty list, which reads exactly
  like "no such doctor".
- **Write-conflict retry.** `isWriteConflictError` matched only Prisma's
  `P2034`. Postgres reports serialization failure and deadlock as SQLSTATE
  `40001` and `40P01`. Missing them does not throw — it stops the retry, and
  the symptom is a **lost consultation offer** with a paid patient waiting,
  which is the fault D-era Phase 11 already found once.
- **Raw SQL.** Four queries used `?` placeholders and unquoted camelCase
  columns, which Postgres folds to lower case. They are the row lock enforcing
  the 40-hour rule, the capacity release when a consultation ends, and the
  spec §62 assertion that destruction is a real DELETE. All failed loudly.
- **The audit role.** MySQL's `GRANT ... ON db.table TO 'user'@'%'` became
  Postgres grants, and needed `CONNECT` and `USAGE` as well — a role that may
  select from a table still cannot reach it without the right to connect to the
  database and see the schema. Granting only on the table produces an account
  that looks correct and cannot log in. Verified by attempting the forbidden
  thing: `INSERT`/`SELECT` on `audit_logs`, zero privileges elsewhere, and
  `SELECT` on a clinical table refused.
- **Backups.** `mysqldump` became `pg_dump`, and the whole encrypt → decrypt →
  restore → count cycle was re-rehearsed: 61 tables, eleven witness tables with
  matching row counts.

**Three faults introduced during the migration and caught before commit**, kept
here because each is a way this work goes wrong quietly:

1. **`db:migrate:test` reported success while doing nothing.** Adding
   `directUrl` — which Supabase needs, because its pooled connection cannot
   carry migrations — meant Prisma migrated over the _direct_ URL, checked the
   development database, found it current, and printed "test database
   migrated" against an empty `neem_test`. It now overrides both URLs **and
   counts the tables**, because "no pending migrations" reads identically
   whether you are up to date or pointed at the wrong database.
2. **The backup verification passed on a file `psql` cannot read.**
   `pg_dump --format=custom` is a binary archive; the rehearsal decrypts and
   looks for `CREATE TABLE`, which appears in the archive's table of contents.
   The check passed and meant nothing. The dump is plain SQL so the check tests
   what it claims.
3. **The test fixtures had been wrong the whole time.** They wrote mixed-case
   emails straight to Prisma — rows no request could produce, since
   `emailSchema` lower-cases everything the API accepts. MySQL's collation
   matched them anyway. On Postgres **181 tests failed** with "That email or
   password is not correct" for accounts created moments earlier. Postgres did
   not break them; it revealed them.

**Consequences worth stating.**

The suite runs in about nine minutes against Postgres where it took
forty-five against MySQL. That was not a goal and is not a reason for the
decision, but it changes how often the full suite is worth running.

**Supabase hosts the database and not the API.** Neem's backend is a
long-running Fastify process holding Socket.IO connections open, with scheduled
jobs; Supabase Edge Functions are Deno and short-lived. A separate Node host is
still required. Supabase's own auth is also unused: Neem has opaque
server-side sessions, argon2id and mandatory admin TOTP, which the
specification requires and which are not interchangeable with a hosted
identity product.

Two connection strings, not one: the pooled connection (port 6543) for the
running API and the direct one (5432) for migrations, both over TLS. The schema
declares `directUrl` for exactly this, and `.env.example` says so at the point
where somebody would otherwise paste one URL into both.

---

### D44 — The API is hosted on Render · 2026-09-10 · **DECIDED**

**Issue.** The database moved to Supabase ([D43](#d43)), and Supabase does not
host the API. Neem's backend is a long-running Fastify process holding
Socket.IO connections open with an in-process job scheduler; Edge Functions are
Deno and short-lived. A conventional Node host was needed.

**What the code actually requires**, which narrowed the field more than the
usual comparison would:

- **Prescription PDFs and doctor credentials live on local disk.**
  `local-storage.provider.ts` is the only storage implementation, and those are
  permanent records. A persistent volume is mandatory, not a preference.
- **The jobs run inside the API process**, including a five-second sweep
  enforcing the 90-second doctor response window. So the service can never
  scale to zero — a sleeping instance stops expiring offers — and can never run
  two copies, which would offer every consultation twice.
- **Socket.IO has no Redis adapter**, so its state is in memory. Single
  instance again.

That is a small always-on box with a disk, not a cluster.

**Selected: Render.** Fly.io and Railway were both capable, and Fly is cheaper
with a wider choice of regions including Johannesburg. The deciding factor was
not capability but operational surface: Render's deploy model is the one this
project already runs on Netlify — connect the repository, push to deploy — and
the team had just been through that configuration. Fly asks for a new mental
model of machines and per-machine volumes to run one small service.

Render's main limitation is honest and happens to fit: attaching a disk forces
a single instance and replaces overlapping deploys with stop-then-start, so
each deploy is a short gap. Neem needs a single instance regardless, so nothing
is being given up.

**Two faults found while preparing the deployment, either of which would have
broken the first one:**

1. **A relative `STORAGE_LOCAL_PATH` resolved outside the mounted disk.** The
   repository root was computed by counting six directory levels up from the
   source file — correct in source, wrong in the bundle, which is one level
   deep rather than four. The same six `..` landed two levels above the root,
   so the path became `/apps/api/uploads`: the container's ephemeral
   filesystem, destroyed by the next deploy, taking the prescriptions with it.
   Precisely the fault [D40](#d40) found in `load-dotenv`, and it takes the
   same answer — search upward for a marker rather than counting. Verified
   against the real bundle location.
2. **The API reads `API_PORT`; every platform injects `PORT`.** It would have
   bound 4000, Render would have health-checked the port it assigned, received
   nothing, and reported a failed deploy without hinting that a naming
   difference was the entire problem. `PORT` is now a fallback and `API_PORT`
   still wins where both are set.

The built bundle was then started the way Render will start it — `PORT` set, an
absolute storage path — and answered its health check.

**Open, and named rather than deferred silently: nothing backs up the disk.**
Supabase covers the database on its own schedule. The volume holding signed
prescriptions and credential documents is not covered by that, and a Render
cron running `npm run backup` would write to its own ephemeral disk and discard
the result. The missing piece is somewhere durable to put a backup, not a
schedule. `BACKUP_ENCRYPTION_KEY` is deliberately absent from the service, so
the configuration does not imply an arrangement that does not exist.

**Also still required:** a home for `apps/web`, which is a separate deployable.
`WEB_ORIGIN` assumes `app.neemtelehealth.com`. The subdomain layout is load
bearing rather than tidy: session cookies are `sameSite: 'lax'`, and `app.` and
`api.` under one registrable domain are same-site, so those cookies are sent on
API calls. A different domain for the app would force `SameSite=None` and a
weaker CSRF posture.

---

### D45 — Supabase's PostgREST roles are revoked, not merely switched off · 2026-09-11 · **DECIDED**

**Issue.** Provisioning the Supabase project ([D43](#d43)) put Neem's 60 tables
into the `public` schema, and Supabase treats `public` as the schema its Data
API serves. That API is PostgREST, reachable with the `anon` key — a key
designed to be distributed to browsers — and what normally stands in front of
it is Row Level Security. **Tables created by Prisma Migrate have no RLS.**

Neem's authorisation is sessions, RBAC middleware and ownership predicates, all
of it in the Fastify application. None of it is in front of PostgREST. So the
question was never "is RLS configured correctly" but "is there a second door
into `consultation_clinical_notes` that the application does not guard".

**What was actually found**, once it was measured rather than assumed:

- `anon` and `authenticated` could `SELECT` **all 61 tables** — the 60 models
  plus `_prisma_migrations`. Nobody granted that: Supabase ships
  `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon,
authenticated`, so every table Prisma created was granted as it was created.
- `PUBLIC` — the pseudo-role meaning every role — held `USAGE` on the schema,
  which is PostgreSQL's own default rather than anything Supabase did.
- The Data API happened to be switched off, so nothing was exposed in practice.

That last point is the decision. **Nothing was leaking, and the arrangement was
still wrong**: the only thing between a publicly distributable key and every
clinical note in the system was one toggle in a dashboard, reversible by
anybody with access to it and by accident as easily as on purpose.

**Decision: revoke at the grant level, and treat the toggle as incidental.**

    REVOKE USAGE ON SCHEMA public FROM PUBLIC;
    REVOKE USAGE ON SCHEMA public FROM anon, authenticated;
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
      REVOKE ALL ON TABLES FROM anon, authenticated;

Three things about that list are worth keeping, because each was learned by
being wrong first.

1. **The schema `USAGE` line is the durable one.** Table grants come back —
   a default privilege hands them to whatever the next migration creates. No
   default privilege can restore `USAGE` on a schema that already exists, so
   once revoked it stays revoked, and without it no table grant inside the
   schema can be exercised at all.
2. **`FROM PUBLIC` and `FROM anon` are different statements.** The schema ACL
   held both a grant to `PUBLIC` and direct grants to the two roles. Revoking
   either alone leaves `USAGE` in place and looks exactly like a revoke that
   did nothing, which cost a round of confusion before the ACL was read rather
   than guessed at.
3. **`ALTER DEFAULT PRIVILEGES` is recorded per creating role**, and a
   statement without `FOR ROLE` changes only the defaults of whoever runs it.
   Migrations run as `postgres`, so that is the role that matters.
   `supabase_admin` also carries such defaults; they cover tables that role
   creates, which are Supabase's own and not ours, and altering them needs
   membership in the role that the application account does not have. Named
   here so nobody spends an afternoon on a statement that is supposed to be
   refused.

**Nothing of Neem's runs as `anon` or `authenticated`.** The API connects as
`postgres`, which owns the schema, and an owner needs no `USAGE` grant. The one
least-privilege role this system adds — the append-only audit account of
[D43](#d43) — is granted `CONNECT` and `USAGE` explicitly by
`scripts/grant-audit-user.mjs` before any table privilege, for exactly this
reason. Verified after revoking: the owning role still selects, still runs DDL,
and a table created afterwards is not readable by `anon`.

**Supabase's dashboard will report RLS as disabled on all 60 tables.** That is
expected and is not a misconfiguration to be fixed. RLS protects rows from
roles that can reach the table; these roles cannot reach the schema. Enabling
RLS instead of revoking would leave the grants in place and make safety depend
on every future table remembering a policy — the failure mode being a new table
that is readable until somebody notices. This note exists so that the warnings
are not "fixed" later by turning PostgREST's access back on.

**Checked by a script rather than by recollection**, because the property has to
survive the next migration and the next operator: `npm run check:supabase` reads the grants, the schema `USAGE`, the default
privileges and PostgREST's own `pgrst.db_schemas` setting, and fails on
anything that would let `anon` read. Its own history is the argument for
asking the database rather than the network — it twice reported safety it had
not established, once from a placeholder key's HTTP 503 and once from a rejected
key's 401, because an endpoint that will not answer looks identical to one that
is switched off. `has_table_privilege` has no such ambiguity. The whole cycle —
seeded grants, the printed statements, a clean re-run — was rehearsed against a
local PostgreSQL standing in for the project.

**Consequence for the pilot.** None operationally: no Supabase feature Neem uses
is affected, because Neem uses none of them beyond the database itself. The cost
is a constraint to remember — adding a Supabase client library later, or the
Data API for some quick integration, now requires deliberately granting what
was deliberately taken away, which is the right way round.

---

### D46 — SMS is switched off for the pilot, not removed · 2026-09-12 · **DECIDED**

**Issue.** SMS was becoming a launch blocker. The Arkesel sender ID is not yet
registered with the networks, and an unregistered alphanumeric sender is
accepted by the API with a 200 and then dropped silently — so the channel could
not be trusted, and waiting for it was holding up a pilot whose purpose is to
find out whether the core model works at all.

The instruction was explicit and worth recording: deactivate SMS **without**
deleting the provider, the adapters, the templates, the database fields or the
tests, in a way that can be reversed during the pilot rather than rebuilt.

**Decision.** One system setting, `notifications.smsEnabled`, default
`false`, `requiresConfirm: true`. While it is off, a template that declares
SMS sends EMAIL instead. Everything else is untouched: `SMS_PROVIDER`, both
adapters, `toGhanaMsisdn`, the `SMS` enum value, all seven templates and
`npm run arkesel:check`.

A setting rather than an environment variable, because turning SMS back on is a
commercial and operational decision the pilot expects to make mid-flight — once
the sender ID is registered and a handset has been seen to buzz. That should be
a toggle in the admin console, with audit and history, not a deploy.

**A disabled SMS becomes an email rather than nothing.** The event still
happened: a consultation is waiting, a prescription was withdrawn. Dropping it
because a channel is off is how an operator learns to stop trusting the
notification system.

**Three details that are not obvious and cost something to get wrong.**

1. **Deduplication.** `doctor.membership.expiring` and `.suspended` already
   declare EMAIL alongside SMS. Substituting one for the other without
   collapsing them sends the same doctor the same message twice — a defect that
   reads as a mail-server problem for a week before anyone opens the template.
2. **An explicit `channels` override still wins.** The retry job passes a
   single channel to resend precisely what failed; re-routing there would retry
   a different message from the one that did not arrive.
3. **Booleans arrive in more than one shape.** The value passes through the
   admin console, JSON and a `json` column, so `getBooleanSetting` accepts
   `"false"` and `0` as well as `false`. A switch that reads `"false"` as
   true fails in the permissive direction and looks like it worked.

**What cannot be rerouted, and why that is now acceptable.**

Doctors and pharmacies have email addresses. **Patients do not, and there is no
field for one** — `PatientSession` holds a name, age, sex and phone, and
`patientIdentitySchema` collects nothing else, because Neem keeps no patient
profile (spec §8.1). So `patient.consultation.ready` and
`patient.consultation.complete` cannot become emails. They are recorded as
`SUPPRESSED` with a reason, which is visible to an operator rather than
silently lost.

That would have been unacceptable a week ago and is not now. `…complete`
carried the consultation reference, which under [D24](#d24) is the patient's
only route back to their own record — and the SMS was its only delivery. The
reference is now on the completion screen _and_ printed on every page of every
document the patient can download from their own phone. The SMS was the sole
copy of something that now has two better ones.

Adding an email address for patients was considered and rejected for the pilot:
it means a migration, a contract change, a new encrypted field and a counter
conversation, against a population at a pharmacy in Ghana where many patients
will not have one. It would be building the wrong thing carefully.

**The tests that assert SMS now ask for it.** Six failed on the new default,
all of them covering the SMS path itself. Rewriting them to expect email was
the wrong repair — they are the evidence that the capability still works, and
inverting them would turn "SMS is off, not gone" into an unverified claim. They
call `setSmsEnabled(true)` instead, which makes a dependency visible that was
previously inherited from a default that happened to suit them.

So SMS is off in production and still proven in the suite, which is the state
the instruction actually asked for.

**Still open.** Notification failures remain invisible to operators: there is no
endpoint listing `FAILED` or `SUPPRESSED` rows, and `admin.notifications` is
a template editor. With one pharmacy in month one somebody can query the table;
at five that stops being true, and the suppressed patient notifications this
decision creates are exactly the rows nobody will think to look for.

---

### D47 — The CSRF cookie is shared across the parent domain, and nothing else is · 2026-09-13 · **DECIDED**

**Issue.** Administrators, doctors and pharmacists could not sign out of
production. Sign-out went to the login page, which found the session still
live and sent them straight back.

The cause was the double-submit CSRF arrangement meeting the subdomain layout
from [D44](#d44). The client reads `neem_csrf` with `document.cookie` and
echoes it in `x-neem-csrf`. The API set that cookie without a domain, which
makes it belong to `api.neemtelehealth.com` alone; JavaScript on
`app.neemtelehealth.com` cannot see it. Every signed-in mutation therefore went
out without the header and was refused with `403 CSRF_INVALID` before its
handler ran. Sign-out was only the most visible, because the client navigated
to the login page whether or not the request succeeded. Admin settings, queue
actions and pharmacy requests were refused the same way. Sign-in needs no
token, so the deploy looked healthy.

D44 was right that `app.` and `api.` are same-site, so the cookies are _sent_.
It does not follow that they are _readable_ — that is a different rule.

Nothing caught it. The integration helper copies the CSRF cookie out of the
response into the header, which no browser on another host can do, and in
development both hosts are `localhost`, where cookies are shared across ports.

**Options.** (A) Return the token in the sign-in response for the client to
hold. Only its hash is stored, so it could not be handed back after a reload;
that needs browser storage and a reissue path — a redesign of a mechanism that
works. (B) Serve the app and the API from one host behind a proxy: a deployment
change to fix a cookie attribute. (C) Give the CSRF cookie, and only that
cookie, the parent domain.

**Decision.** (C), as `CSRF_COOKIE_DOMAIN=neemtelehealth.com`. The session
cookie stays httpOnly and host-only on the API.

A cookie on the parent domain is also readable on the apex, which is the
marketing site: another codebase, on another host. The token is worthless
without the session cookie — but CORS allowed credentials for every listed
origin, so a script on that site could already send the session cookie and
lacked only the token. In the same change, credentials are allowed for the
app's origin alone, which is what `security.md` §6 already claimed. The pilot
form sends no cookies and is unaffected.

**Guards.** Production refuses to boot when the app and API hosts differ and no
domain is set; any environment refuses a domain that does not cover both
hosts. The sign-out button now stays put and shows the error when sign-out
fails, instead of reporting a success that did not happen.

**Sessions from before the change** hold a CSRF cookie the app still cannot
read. Once the tab is closed they end at the idle timeout
(`SESSION_IDLE_TIMEOUT_MINUTES`, 30), or at once if the browser's cookies for
the site are cleared. The next sign-out after signing in again removes the
stale host-only cookie as well.

---

### D48 — Paystack checkout opens on the pharmacy device, and the patient code can be shown again · 2026-09-14 · **DECIDED**

**Issue.** In production no patient code ever appeared. The code is shown only
once payment is verified, and with Paystack no payment could be made:
`/transaction/initialize` charges nothing, it returns a hosted checkout link,
and the pharmacy's payment step never showed that link. It said "Waiting for
payment" for a payment nobody had a way to make. The mock provider's simulate
buttons had hidden this in every local run, and the earlier Paystack round trip
was driven from a script rather than this screen.

Separately, the code was shown once, at the end of "New consultation", and
nowhere else. The API has always issued a replacement (D6), but a pharmacist
who left that screen, a code that expired, or a patient who lost their phone
had no way to reach it.

**Options** for the checkout: (A) open it on the pharmacy device, where the
patient enters their Mobile Money number and approves the prompt on their own
phone; (B) show the checkout link as a second QR for the patient to scan.

**Decision.** (A). The patient scans exactly one code in a visit, the
consultation's, and the counter flow matches how a Ghanaian pharmacy takes
Mobile Money. Confirmation is unchanged: the server re-verifies with Paystack
while the screen polls, and nothing the checkout tab does counts (spec §34).

The consultation page now offers **Show patient code** while the consultation
waits for the patient (`ACTIVATED`, `WAITING_FOR_PATIENT`, the states the API
accepts). Nothing is minted until it is pressed, because each code revokes the
one before.

**Known gap, not fixed here.** A payment attempt already in progress is reused
rather than charged twice, and its checkout link is not stored — so if the
checkout is lost, the screen can only say a payment is in progress. Storing the
link would be a schema change. Likewise the Mobile Money number field on the
payment step is not sent to Paystack; the patient enters it at checkout.

---

### D49 — Paystack "abandoned" is not final, and nothing expires a consultation without asking the provider · 2026-09-14 · **DECIDED**

**Issue.** The first live payment expired the consultation it paid for. A patient
paid GHS 30 by Mobile Money; Paystack confirmed it at 02:18:52; the payment
window closed at 02:21:37; the consultation was expired at 02:22:02 with the
payment written off as abandoned. The money had to be refunded by hand.

Traced against production, three faults lined up:

1. **Paystack's "abandoned" was read as final.** Paystack reports a checkout
   that has been opened but not completed _yet_ as `abandoned`. The pharmacy
   screen's first checks, made before the patient had approved the prompt, got
   that answer, and the adapter mapped it to `ABANDONED`.
2. **The status route then stopped checking.** It skipped any payment already
   `ABANDONED`, so the success two minutes later was never asked about. Its
   failures were also discarded with `.catch(() => undefined)`, which would
   have hidden any other cause just as well.
3. **The expiry sweep did not ask the provider.** It expired every consultation
   past its deadline in `PAYMENT_PROCESSING`, contrary to its own comment that a
   slow provider "can never expire one that was in fact paid". Once expired,
   `EXPIRED → PAID` is not a transition, so a later confirmation failed quietly
   with no refund raised.

No webhook arrived either; the live Paystack webhook had not been configured,
and would have rescued this case.

**Decision.**

- `abandoned` maps to PENDING. A checkout that really was abandoned never
  succeeds, and the window closes it; the cost of the old mapping was a paid
  consultation lost.
- The status route re-verifies whenever the consultation is still awaiting
  payment, whatever the last answer was, and logs verification failures.
- The sweep verifies before expiring a consultation with a payment in progress:
  paid means settled and activated; not paid means expired; unreachable means
  held and retried for up to an hour past the deadline, then expired.
- A confirmation for a consultation that has already closed does what
  `payment-flow.md` §4 always said: the payment is recorded as SUCCESS, the
  consultation is not revived, a `PAID_AFTER_CLOSE` anomaly is audited, and a
  refund request is raised by SYSTEM for an administrator to decide. No revenue
  is allocated. The refund is requested, never made automatically.
- Reconciliation includes ABANDONED payments, so a patient who pays after the
  sweep is found within the hour even without a webhook.
- A confirmation for a consultation whose last attempt was reported failed
  moves it back to PAYMENT_PROCESSING before PAID, rather than failing the
  transition.

**Still required outside the code:** the live Paystack dashboard's webhook URL
must be set to `https://api.neemtelehealth.com/api/v1/webhooks/payment`.

---

### D50 — No consultation is started without a doctor on duty, and none waits for ever · 2026-09-14 · **DECIDED**

**Issue.** The first end-to-end live payment worked — and then the patient sat in
the queue at 04:00 with no doctor to take them. Nothing stopped a pharmacy
taking money when nobody was on shift, and nothing ended the wait: the queue
raised an admin delay alert after five minutes and otherwise waited
indefinitely. The pilot runs 08:00–20:00, so every night the counter could
charge a patient for a consultation that could not happen.

A second fault surfaced in the same code. Cancelling a paid consultation told
the pharmacy "a refund request has been raised for Neem administration to
review", and nothing raised one. `cancelConsultation` returned `refundOwed:
true` and stopped.

**Decision.**

- **A hard block, enforced by the API.** Creating a consultation, and asking
  for payment on one, are refused unless at least one doctor is on duty:
  ACTIVE, subscription usable, licence valid, and on a CONFIRMED shift covering
  now. Checked at both moments because a shift can end between them; after the
  reuse of an in-flight payment, so an attempt already under way is never
  stranded. The pharmacy sees the refusal as an ordinary error on the screen it
  is on. Not a warning: a counter under pressure clicks through warnings, and
  the cost of doing so falls on a patient.
- **Presence and capacity are not part of it.** Those change minute to minute.
  Requiring the doctor's queue screen to be open would block every pharmacy the
  moment a doctor's phone locked mid-shift. `checkStandingEligibility` holds the
  four standing gates, and `checkEligibility` runs it first, so the block and the
  queue cannot disagree about what "on duty" means.
- **A wait limit.** A consultation still WAITING_FOR_DOCTOR or REASSIGNING after
  `queue.maxWaitSeconds` (default 1200, 20 minutes; 0 turns it off) is cancelled
  by SYSTEM and its queue entry marked ABANDONED. ASSIGNED is left alone, so an
  offer already in a doctor's hands is not pulled from under them.
- **Cancelling a paid consultation now raises the refund request** it always
  claimed to — recorded against whoever cancelled (SYSTEM for the wait limit) —
  and an already-open request is left as it is. The refund is still an
  administrator's decision.
- Both are settings (`consultation.requireDoctorOnDuty`, requiring a reason to
  change; `queue.maxWaitSeconds`), not literals.

**Testing.** The integration suite turns the block off in `resetDatabase` —
almost no test is about duty cover — and `consultation-availability.test.ts`
turns it on. The end-to-end suite runs with the rule as production has it: a
worker-scoped fixture puts one doctor on shift and never brings them online,
which lifts the block without that doctor ever receiving an offer.

**Operational consequence.** Outside confirmed shifts, pharmacies cannot start
consultations. NIGHT is seeded inactive; a pilot running 08:00–20:00 needs
MORNING and AFTERNOON assigned and _confirmed_ by the doctors each day, or the
counter is closed. The two new settings fall back to their defaults until a
`db:seed` creates their rows, which it does without touching any value already
set.

---

### D51 — Doctors can confirm their shift from the dashboard · 2026-09-14 · **DECIDED**

**Issue.** With D50 in place a pharmacy can only start a consultation while a
doctor holds a _confirmed_ shift — and no doctor could confirm one. The
dashboard showed "You have an unconfirmed shift today. Confirm it to receive
consultations." with nothing to press. `POST /doctor/shifts/:id/confirm`, the
service behind it and the `useConfirmShift` hook all existed; no screen called
them. An unconfirmed shift has never counted for the queue either, so before
D50 this already meant a doctor could not be offered a consultation, silently.

The same warning chose "today's shift" as the first assignment dated today in
whatever order the list returned, cancelled and declined ones included.

**Decision.** The warning carries a **Confirm shift** button that calls the
existing route, and reports a refusal in place. Today's shift is the one
covering now, else the next to start, ignoring cancelled and declined
assignments. The wording and styling of the dashboard are otherwise unchanged.

Covered end to end by `e2e/shift-confirmation.spec.ts`: an assigned shift shows
the warning, the button clears it, and a reload proves it was the server that
changed rather than the screen.

---

### D52 — Demo data is refused on any database that is not on this machine · 2026-09-14 · **DECIDED**

**Issue.** Seeding the two D50 settings into production meant running
`npm run db:seed` locally with production's database URLs set in the shell.
Everything else came from the local `.env` — including `NODE_ENV=development`
and `SEED_DEMO_DATA=true`, which are exactly the two flags the seed used to
decide whether to write demo data. Forgetting to override `SEED_DEMO_DATA` would
have put demo pharmacies, demo doctors and demo sign-in accounts, with passwords
printed in the README, into the live database. It was caught by reading the
seed before running it, not by anything in the seed.

`NODE_ENV=production` could not be the safeguard either: setting it locally
makes the config loader apply production's checks to the development `.env`,
and the seed refuses to start.

**Decision.** The destination gets the last word. After reference data is
seeded, and after the existing `NODE_ENV` and `SEED_DEMO_DATA` checks, the seed
refuses demo data unless both `DATABASE_URL` and `DIRECT_DATABASE_URL` (when
set) point at a loopback host — `localhost`, `127.0.0.1` or `::1`. A hostname
that only contains "localhost" does not count, and a URL that cannot be parsed
is refused.

- **Reference data is unaffected**, so `db:seed` remains the way to add new
  settings rows to production.
- **Not an error exit.** Reference seeding succeeded; a non-zero exit would
  break `npm run setup`'s chain on a misdetection while protecting nothing more.
  The refusal is printed plainly instead.
- **Loopback only.** The development database is published on `localhost` by
  `docker/docker-compose.yml`, no container runs the seed, and CI does not seed,
  so there is no legitimate remote target to allow for.

Covered by `tests/unit/seed-demo-guard.test.ts`.

---

### D53 — Counter doctors are paid by share, and the membership fee is dropped · 2026-09-18 · **DECIDED**

**Issue.** v2 pays its professionals a share of each consultation. The counter
paid its doctors a salary — GHS 8,000 a month full-time, pro rata below 40
hours — and charged them a six-month membership fee. Running both side by side
meant two ways of paying the same doctor for the same kind of work, and a
counter price (GHS 30 in production) that differed from v2's GHS 50 for the
same general consultation.

**Decision, by the operator.**

- **Price.** A counter consultation is GHS 50, the same as a general
  consultation booked directly.
- **Split.** The pharmacy keeps **20% of what the patient paid**, on the same
  basis as before. The provider's fee comes off what is left, and the doctor and
  Neem **split the remainder 50/50**. On GHS 50 with a GHS 1 fee: pharmacy 10,
  doctor 19.50, Neem 19.50.
- **Cut-over.** Counter doctors are salaried to the end of September and paid by
  share from **1 October 2026**. Payroll shows no salary from October; a counter
  consultation earns a share only if it completes on or after the cut-over.
- **Membership.** Dropped. Not sold, not warned about, and nobody suspended for
  a lapsed one — **effective on deploy, not at the cut-over**. A membership runs
  six months and a lapsed one suspends the doctor, so keeping it until the 1st
  would have forced anyone lapsing in late September to buy six months of a fee
  that no longer exists, or be suspended. Existing records are kept; the switch
  is `doctor.membershipRequired`.

**How it is held.**

- The pharmacy's share is read from the settlement snapshot, not recomputed —
  the doctor is paid out of the same figure the pharmacy was credited.
- `revenue.counterShareFrom` must be the first of a month. The salary is
  monthly; a cut-over on the 15th would pay the second half of that month twice.
- Price and pharmacy share are seeded defaults for new environments. A live
  environment keeps what its administrator set until they change it — in
  production that is two admin-setting changes, and telling pharmacies first.

**Found on the way.** A patient-direct consultation was being split as though a
pharmacy took part, recording a 30% pharmacy share that belonged to no one.
Payouts skip rows without a pharmacy, so no money went astray, but the finance
summary would have reported it as paid to pharmacies. Direct consultations now
record none. No production data was affected; none exists yet.

Covered by `tests/integration/counter-doctor-share.test.ts`.

### D54 — Membership is GHS 100 a renewal, and off for the pilot · 2026-09-24 · **DECIDED**

**Issue.** D53 dropped the membership fee six days ago, on the reasoning that a
doctor paid by share should not also pay to be on the platform. The operator
wants a membership kept, at a price that is a commitment to Neem rather than a
source of revenue, and wants it to apply to dietitians and personal trainers as
well — they use the same platform on the same terms.

**Decision, by the operator.**

- **Fee.** GHS 100 per renewal, `doctor.membershipFeeMinor` = 10000. Briefly
  set at GHS 5 the same day, before the operator settled on 100.
- **Off for the pilot.** `doctor.membershipRequired` is false. The fee is
  recorded so it is ready, and nobody is charged it while Neem is asking its
  first professionals to try the platform. Switching it on is a later decision,
  taken when Neem judges the platform worth paying for.
- **Period.** Six months, unchanged, so about GHS 10 a year.
- **Who.** Every professional, not only doctors. The machinery never looked at
  discipline, so nothing in it changes; the Membership tab, hidden from
  dietitians and trainers when the fee was dropped, comes back for them.
- **Everything else unchanged.** Warned 14 days before expiry, 7 days' grace
  after, then suspended until the renewal is paid.
- **Nobody is blocked overnight.** Before the fee is switched on, every
  professional is granted a free period to the end of the following month, so
  the first thing anyone is asked to pay is a renewal rather than a debt they
  were never told about. `npm run membership:grant` writes an ACTIVE
  subscription of zero, records it in the audit log as a grant, and skips
  anyone already covered. It creates no payment row: no money moved, and an
  invented payment would appear in the day's takings.

**How it is held.** The seeded defaults are `doctor.membershipRequired` false
and `doctor.membershipFeeMinor` 10000. Staging and production keep whatever an
administrator set, so charging it later is three deliberate acts, in this order:
run the grant, confirm the fee, then switch the requirement on.

Anyone already suspended for a lapsed membership stays suspended until an
administrator reinstates them; the grant deliberately touches no account's
status, because a suspension is an administrator's decision to reverse.

The test suite turns the requirement off for itself, as it does the on-duty
rule, because almost no test is about membership and almost none creates a
subscription. `tests/integration/membership.test.ts` and
`counter-doctor-share.test.ts` turn it on and are what prove it blocks.

### D55 — The professional takes 50% either way, and every change takes effect now · 2026-09-24 · **DECIDED**

**Issue.** [D53](#d53) set the counter split at pharmacy 20% of the gross, with
the doctor and Neem halving what was left after the provider's fee, from
2026-10-01. It also left a professional earning less at a counter than online
for the same consultation, because the pharmacy's share came out of the pool the
doctor was paid from.

**Decision, by the operator.**

- **The professional takes 50%** of what the patient paid less the provider's
  fee, **whichever door the patient came through**. A pharmacy's share comes out
  of Neem's, not the professional's, so the same work pays the same.
- **Pharmacy 20%** of what the patient paid, unchanged from D53.
- **Neem keeps the remainder**: about 30% of a counter consultation and 50% of a
  patient-direct one, carrying the provider's fee in both.
- **Now, not October.** `revenue.counterShareFrom` moves to **2026-09-01**, so
  September is paid by share and no salary is due for it. Everything else —
  price, percentages, earnings — applies as soon as an administrator sets it.

On GHS 50 with a GHS 1 provider fee:

|              | Counter | Patient-direct |
| ------------ | ------- | -------------- |
| Pharmacy     | 10.00   | —              |
| Professional | 24.50   | 24.50          |
| Neem         | 14.50   | 24.50          |
| Provider fee | 1.00    | 1.00           |

**How it is held.** `revenue.pharmacySharePctBp` 2000,
`revenue.neemSharePctBp` 8000, `revenue.professionalSharePctBp` 5000,
`revenue.counterShareFrom` 2026-09-01, and
`revenue.professionalEarningsEnabled` now defaults on — the share is agreed, so
the guard that existed while it was not no longer has anything to guard. A live
deployment keeps whatever an administrator set; these are the values a fresh one
starts from.

In `earnings.service.ts` the professional's share is taken from the gross less
the fee, and Neem's is the remainder after the pharmacy's share rather than a
percentage of its own — three shares and a fee that must add up to what the
patient paid, which a remainder cannot drift from however the rounding falls.

**Why September costs nobody anything.** Paying a worked month by share rather
than salary would normally be a decision to explain to the people it pays less.
It is not one here: every professional account in production today was made for
testing, the pilot has not started, and the first real doctor will be onboarded
under these terms rather than moved onto them. Payroll shows no salary from
September, and no salary was owed.

Covered by `tests/integration/counter-doctor-share.test.ts` and
`tests/integration/v2-earnings.test.ts`.
