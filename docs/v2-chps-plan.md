# Neem V2 (CHPS): assessment and migration plan

**Status: Phases 1–3 built (D73, D75–D87); Phase 4 under way: 4a–4b built (D88–D89).** Written 2026-10-31 against `main` at
`3964406`.

"V2" already names something else in this repository: the patient-direct channel
([v2-patient-direct-plan.md](v2-patient-direct-plan.md)), which is built and live. To avoid mixing
them up, this document calls the new model **CHPS** throughout, and the code should too
(`ConsultationChannel.CHPS`, not `V2`).

Every "Exists" claim below was read from the code. Everything under "Proposed" is design only.

---

## 1. Summary

The existing platform does most of the hard work V2 needs. It has a live queue that matches the
best eligible doctor, offers the consultation with a response window and reassigns it, Whereby video
behind a provider abstraction (recording ruled out by the interface itself), safe handling of
interrupted calls (D57, D61, D63, D67), MDC-verified doctors with credential-expiry checks (D70),
signed prescriptions with the statutory fields, referrals, consent records, an audit log and
role-based access control (RBAC). **CHPS is best built as a third consultation channel on this
foundation, not as a rewrite.** The stack stays the same: Fastify + Prisma + Postgres on Supabase,
TanStack Start, Whereby.

Four things genuinely conflict with the brief and need decisions before the matching work starts
(§4). The biggest is **D23**: clinical records are currently sealed when a consultation ends and
**no clinician can read them again**. That makes the longitudinal patient record (A6, B5) impossible
until the decision is reversed, and reversing it needs a legal and clinical-governance answer, not
an engineering one.

---

## 2. What exists (verified)

| Area          | Exists                                                                                                                                                                                                                                   | Where                                                 |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Shape         | npm-workspaces monorepo: `apps/api` (Fastify 5, Prisma 6, Socket.IO), `apps/web` (TanStack Start, React 19, Tailwind 4), `packages/contracts` (zod schemas, enums, permissions)                                                          | `package.json`                                        |
| Hosting       | Web on Netlify, API on Render, Postgres on Supabase with PostgREST roles revoked (D43–D45)                                                                                                                                               | `netlify.toml`, `render.yaml`                         |
| Data          | 111 models and enums, 21 migrations                                                                                                                                                                                                      | `apps/api/prisma/schema.prisma`                       |
| Auth          | Own sessions (argon2, TOTP 2FA, lockout, CSRF). **Not Supabase Auth, and no RLS.** Everything is enforced in the API, which is the only thing that connects to the database                                                              | `modules/auth`, D45                                   |
| Roles         | `ADMIN \| DOCTOR \| PHARMACY`, with permissions in `ROLE_PERMISSIONS` plus per-resource ownership checks                                                                                                                                 | `contracts/src/permissions.ts`                        |
| Facility      | `Pharmacy` + `PharmacyUser`, onboarding and verification state machine, opening hours, capabilities                                                                                                                                      | schema `Pharmacy`                                     |
| Patient       | **No persistent patient.** Counter patients exist only as a per-consultation `PatientSession` (encrypted name, age, sex, phone, address). Direct patients have a `PatientAccount` keyed by a hashed phone or email                       | schema `PatientSession`, `PatientAccount`             |
| Clinical      | `ConsultationVitals` (BP, pulse, temperature, weight, SpO₂ in encrypted JSON), `ConsultationTest`, `ConsultationClinicalNotes` (notes, diagnosis, treatment, encrypted), `ConsultationSummary`, multiple outcomes per consultation (D56) | schema; `ClinicalWorkspace.tsx`, `ClinicalIntake.tsx` |
| Queue         | Eligibility (active, licence, confirmed shift, presence heartbeat, language, capacity), scoring, offer window, reassignment, admin alerts, "no doctor on duty" refusal (D50), declared presence (D72)                                    | `domain/queue-scoring.ts`, `modules/queue`            |
| Video         | `MediaProvider` abstraction, Whereby and mock implementations, room URLs persisted (D57), attendance events, interruption and rejoin budget                                                                                              | `adapters/media`, `modules/media`                     |
| Documents     | Prescriptions (versions, PDF, verification QR, dispensing), referrals (hospital name as free text, PDF), signatures                                                                                                                      | `modules/prescription`, `modules/documents`           |
| Governance    | `AuditLog`, `ClinicalRecordAccessLog`, `Consent`, `DisclosureLog`, retention jobs                                                                                                                                                        | schema; `docs/data-retention.md`                      |
| Notifications | Provider abstraction (SMTP, Arkesel, Hubtel, mock). In-app is real-time only, with no stored inbox (D32). SMS is switched off for the pilot (D46)                                                                                        | `adapters/notification`                               |
| Tests         | 42 integration suites, 25 unit suites, 11 Playwright specs. `docs-drift.test.ts` fails if a route is missing from `docs/api.md`                                                                                                          | `apps/api/tests`, `e2e`                               |
| Design        | Plus Jakarta Sans (body), Nunito (display), teal-green `--brand oklch(0.58 0.13 175)`, shadcn-style tokens in `styles.css`, Neem components (`AppShell`, `CallStage`, `Chip`, `Logo`…)                                                   | `apps/web/src/styles.css`, `components/neem`          |

---

## 3. Reuse, change, build

### Reuse as is

- Queue engine, offer and reassignment, presence. CHPS consultations enter the same queue. The brief's "declined or unanswered goes back for reassignment by configurable rules" is exactly what the engine already does with its settings.
- Doctor onboarding, MDC verification, credential expiry, suspension. "No unverified clinician consults" is already enforced in `checkEligibility`.
- The Whereby adapter and all the interruption logic. Scenario 4 (network interruption) is already the D57/D61/D63/D67 behaviour: `INTERRUPTED` is not a failure, only a professional or a sweep ends a consultation, and nothing is marked completed by a dropped connection.
- Prescriptions with the statutory fields (D60), consultation summaries, signatures, verification.
- Auth, 2FA, CSRF, rate limits, audit log, settings with change history, the admin console.

### Change

| Today                                              | CHPS change                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UserRole` has three values                        | Add `SUPER_ADMIN`, `OPS_ADMIN`, `DISTRICT_ADMIN`, `SUBDISTRICT_ADMIN`, `FACILITY` (CHO / facility admin), `REPORTER`. Existing `ADMIN` maps to `OPS_ADMIN` permissions. Add a **geographic scope** (region, district, sub-district or facility) checked alongside the permission, the same way ownership checks work today |
| `Consultation.pharmacyId`                          | Add nullable `facilityId`, `patientId` and `visitId`, and a `CHPS` channel. Pharmacy and direct consultations keep working untouched                                                                                                                                                                                       |
| Patient joins on their own phone via a QR code     | The patient joins on the **facility station**: a paired device with its own credential, scoped to one facility, which can only show "waiting" or the live call for the consultation it is currently given                                                                                                                  |
| Vitals: six readings                               | Add respiratory rate, height and blood glucose, plus free-text observations. Recorded against the visit, so they exist before any doctor is involved                                                                                                                                                                       |
| Doctor presence is online or on a break            | Add **Busy**, which is distinct from being at capacity                                                                                                                                                                                                                                                                     |
| Referral: free-text hospital, issued and forgotten | Destination facility (from the registry, with free text as a fallback), transport, status `ISSUED → ACKNOWLEDGED → ATTENDED / NOT_ARRIVED`, feedback, follow-up. **Never "received" until someone records it**                                                                                                             |
| Consultation fee                                   | CHPS consultations are created with the fee waived (a `feeEnabled.chps` setting, as in D71). Paystack never enters the CHPS flow                                                                                                                                                                                           |

### Build

- **Geography and facilities**: `Region`, `District`, `SubDistrict`, `Facility` (type `CHPS`, with health centre and district hospital as referral destinations), `FacilityUser`, equipment and connectivity status.
- **Patient registry**: `Patient` (Neem patient number as the identifier that always exists; encrypted name and contacts; optional NHIS number held under its own access rule), `PatientIdentifier`, a guardian or representative, duplicate search on a hashed name, date-of-birth and community key, plus allergies, medications and history.
- **Visit and triage**: `PatientVisit` (one walk-in, carrying the status board's states), `TriageRecord`, vitals. The **emergency escalation** action takes a visit out of the queue path entirely and opens an emergency referral record.
- **Station / kiosk**: device pairing by a one-time code shown in the facility dashboard, a `/station` route with no navigation, and server-driven content that clears on end, reload or timeout.
- **Dashboards**: CHPS overview and queue board, doctor overview additions, Neem ops overview and monitoring, district aggregate reporting with CSV export.
- **Reports**: daily and monthly per facility and per district, computed only from operational fields.

### Not proposed

- **Automated triage thresholds or emergency flags.** Built as a configurable protocol table that ships **empty**. Flags appear only once a clinically approved protocol has been entered (§4.5).
- **DHIMS2.** Reports keep the indicator definitions separate, so an approved integration can be added later. The product will not claim one exists.
- **Offline-first clinical capture.** Phase 1 saves non-sensitive drafts in memory, refuses duplicate requests with idempotency keys, and shows connection state clearly. Queued sync of clinical data needs an encrypted local store and a conflict design, so it belongs in Phase 4.

---

## 4. Decisions needed

> **Answered 2026-10-31 (D74):** past records readable by the patient's clinicians (CHPS only);
> consultations free, doctors salaried by government; red/orange/yellow/green triage assigned by
> the CHO; districts from the official online list. Q4 (notifications) is still open.

1. **D23: may clinicians read past records?** Today: retained, encrypted, readable by no one. The brief: a longitudinal record for authorised staff. Reversing this needs a lawful basis under Act 843 (Data Protection), a statement of who may read what, an access-logging rule (`ClinicalRecordAccessLog` already exists) and someone qualified to sign it off. **Phase 1 can go ahead without it**: the doctor sees the current visit's CHO assessment, which is live data. A6 and B5 history views wait for the answer.
2. **Do the pharmacy and direct channels keep running?** The pilot is live at a pharmacy. Proposed: CHPS is added alongside both, nothing is removed, and retiring the pharmacy channel is a separate, explicit decision later. Removing it now would also rewrite 20 modules for no gain.
3. **Who pays for a CHPS consultation?** Proposed: free to the patient and the fee is waived at creation, as D71 already does. Doctor pay then needs a basis. D55's 50% share of nothing is nothing, so is it salaried, paid per consultation from a grant, or something else?
4. **In-app notifications (D32).** The brief asks for an in-app notification feed. D32 deliberately stores no message bodies. Proposed: a feed of _events_ (type, reference, time) rendered from live records, with no stored text. That is consistent with D32.
5. **Clinical protocol source.** Which approved triage and emergency protocol (for example a GHS CHPS standing-orders document), and who enters it.
6. **Administrative geography.** The 16 regions are public. Districts and sub-districts should be imported from an official GHS list the operator supplies, not typed in by hand here.

---

## 5. Phased plan

Every slice ships to `main` working, because `main` syncs to Lovable and the pilot is live. Each slice
adds a migration (additive only), its routes in `docs/api.md`, a decision-log entry where something
was chosen, and tests.

### Phase 1: core CHPS operations

| Slice | Delivers                                                                                                                                                                                                                                                                                                                                                                              | Depends on                            |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 1a    | **Built (D73).** Geography, `Facility`, `FacilityUser` and the `FACILITY` role. Admin registers a CHPS and creates CHO accounts. The other admin roles and geographic scope moved to Phase 3                                                                                                                                                                                          | Q6 for real data (regions are seeded) |
| 1b    | **Built (D75).** Patient registry with search, consent, walk-in visits, red/orange/yellow/green triage with vital signs, emergency escalation, closing a visit at the facility. CHO dashboard with today's counts and board                                                                                                                                                           | —                                     |
| 1c    | **Built (D76).** Requesting a doctor from a triaged visit into the ordinary queue, free; honest "no doctor on duty" refusal (Scenario 2); request state and accepting doctor on the board; withdrawing; emergencies leave the queue                                                                                                                                                   | —                                     |
| 1d    | **Built (D77).** Station pairing by code, `/station` kiosk screen (welcome, waiting, call, thank-you), joins by itself once a doctor accepts, wipes itself after each patient. CHO stations panel and Send to station. Setup guide: `docs/station-setup.md`                                                                                                                           | —                                     |
| 1e    | **Built (D78).** Doctor sees the CHO's triage, readings, note and earlier visits; structured encounter record, never sealed, versioned amendments; completion needs assessment and plan; CHO sees the doctor's advice. Emergency escalation was built in 1b–1c. **Not built:** a separate Busy status (the existing capacity limit already stops offers to a doctor mid-consultation) | —                                     |

**Milestone:** Scenarios 1, 2, 3, 4 and 6 pass end to end in Playwright against the mock media
provider (done, D90: `e2e/chps.spec.ts`), and once by hand against Whereby on a real tablet (not
done yet).

### Phase 2: referrals and continuity

Patient history is already built (D74, D78). What remains, in four slices:

| Slice | Delivers                                                                                                                                                                                                                                                                                                                   | Depends on |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 2a    | **Built (D80).** Tracked referrals: registry or free-text destination, urgency, reason, clinical summary, transport; issued → acknowledged → attended or did not arrive, each recorded by the CHO with how they learned it; feedback; emergency referrals from escalated visits; visits end as Referred; referral register | —          |
| 2b    | **Built (D81).** Follow-ups set by the CHO from the doctor's advice or a referral's feedback, with a due date; overdue shown but never marked missed by itself; resolved as seen (linked to the return visit), missed or cancelled; due list and count on the Today page                                                   | —          |
| 2c    | **Built (D82).** Facility report for a day, a month or any range up to 92 days: attendance, triage, emergencies, doctor requests and waiting times, per-doctor completions, referrals, follow-ups, complaints as written, visits per day; CSV download                                                                     | —          |
| 2d    | **Built (D83).** CHPS prescriptions shown to the CHO, printable, and markable as given from facility stock (once); files on a visit, checked and encrypted, readable by the facility and the consultation's doctor                                                                                                         | —          |

**Milestone:** Scenario 5 end to end (done, D90).

**Questions for Phase 2** (answered 2026-11-01, D79: the CHO records referral acknowledgement and
feedback; complaints stay free text; prescriptions are printed and may be dispensed at the facility):

7. **Receiving facilities have no Neem accounts.** How is a referral acknowledged and fed back?
   Proposed: both. A printed referral slip carries a code that opens a public page, where the
   receiving facility confirms arrival and writes feedback without an account, as prescriptions are
   verified today; and the CHO can record either one after a phone call.
8. **"Common presenting complaints" cannot be counted from free text.** Proposed: a short list of
   complaint categories chosen at registration alongside the free text, editable by an
   administrator, seeded from a list the operator supplies.
9. **Who receives a CHPS prescription?** Proposed: printed for the patient with its verification
   code, to collect at a pharmacy, and marked "dispensed at the facility" when the compound has the
   medicine in stock.

### Phase 3: administration and analytics

| Slice | Delivers                                                                                                                                                                                                                                                                                      | Depends on |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 3a    | **Built (D84).** `ADMIN` becomes the super administrator; `OPS_ADMIN` holds everything but staff accounts, settings, money and the audit log; `DISTRICT` officers read one region, district or sub-district. Staff accounts page with one-time set-up links; district officer's facility list | —          |
| 3b    | **Built (D85).** District dashboard: the slice 2c report summed across the facilities in scope, compared facility by facility, filtered by sub-district, facility and date range, with CSV                                                                                                    | 3a         |
| 3c    | **Built (D86).** Neem CHPS operations overview: every facility's live state (stations online, waiting requests, emergencies, CHO activity today) and doctor utilisation across channels                                                                                                       | 3a         |
| 3d    | **Built (D87).** System monitoring: sessions, presence, station heartbeats, failed calls and security events (failed sign-ins, lockouts, refused pairings)                                                                                                                                    | 3c         |

**Operator decisions (2026-11-01, D84):** district officers view only; the administrator is split
into super and operations administrators.

### Phase 4: infrastructure

| Slice | Delivers                                                                                                                                                                                                                                    | Depends on |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 4a    | **Built (D88).** Walk-ins and their triage recorded with no connection, encrypted on the device under a key held by the API, sent by themselves when the connection returns; possible duplicates decided by the CHO; device times corrected | —          |
| 4b    | **Built (D89).** Stations measure their connection to Neem when idle and the CHO sees it; the CHO can turn on lower video quality (Whereby low-data mode) for the facility's calls; an unstable call offers to turn the camera off          | —          |

Still proposed: device monitoring, SMS once D46 is lifted, DHIMS2 through an approved interface, multi-region.

---

## 6. Risks

- **Shared screens.** The station is the riskiest new surface. It gets no patient identifier beyond a first name or Neem number, never shows records, and its credential cannot call any route but its own two.
- **Rural bandwidth.** Whereby needs roughly 300–500 kbps for usable video. The station should offer audio-only before the call fails, and facility connectivity should be measured during pairing.
- **Scope creep across phases.** The brief lists about 28 entities. Building them all before a single CHPS consultation works end to end is the failure mode §12 of the brief warns against.
- **Regulatory.** Nothing in the product will say Neem is approved by GHS, the MDC or the Data Protection Commission. Clinical deployment needs a review of telemedicine guidance and the Act 843 registration status.
