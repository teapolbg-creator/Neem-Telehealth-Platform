# Instruction brief — five open questions on clinical-record retention and patient data

**To:** Ghanaian legal counsel (data protection and health regulation)
**From:** Neem Health, Accra — engineering
**Date:** 2026-09-04
**Subject:** Five questions arising from the retention design of a pharmacy-based telemedicine platform, two of which block launch

---

## 0. What this document is, and what we are asking for

Neem is a pharmacy-based telemedicine platform, built and functionally complete, **not yet launched and holding no real patient data**. During the build we established from Medical & Dental Council sources that a minimum retention obligation exists for clinical records. That reversed a core design assumption — the system had been deleting clinical notes the moment a consultation ended — and the architecture was rebuilt around retention. That change is done.

Five questions remain that we cannot answer from engineering judgement, and we have deliberately not guessed at any of them. Each is stated below with the decision it drives, what the product does today in the absence of an answer, and what would change once we have one.

**We are asking for:** a written answer to each of the five, with the source relied on where one exists, so that the answer can be recorded against the question and the configuration changed to match. Where the honest answer is "the law is unclear", we would rather have that, with a recommended defensible position, than a confident answer that is not.

**Two of these block launch** — Q4 (lawful basis and patient notice) and Q5 (access and erasure). We are not willing to process a first real patient's data without them.

**What we are not asking here.** A broader register of candidate instruments — licensing, e-prescription validity, electronic signatures, payment authorisation, cross-border transfer, breach notification — sits in `ghana-regulatory-register.md` and is a separate, larger instruction. This brief is confined to the retention and patient-data questions, because those are the ones with an architectural deadline.

**Nothing in this document is a legal conclusion.** Where it states a position, that is the engineering default currently in force pending your answer.

---

## 1. What the system does, in the terms these questions need

A patient walks into a participating pharmacy. The pharmacy creates and takes payment for a consultation. The patient is given a one-time QR code, opens it on **their own phone**, and enters their details there — the pharmacy never types them. They choose a language and a consultation mode, are matched to a licensed doctor, and consult by audio, video, or a platform-placed call. The doctor may issue a prescription, a referral, or a written consultation summary. The pharmacy dispenses.

Facts that bear on the questions:

| Fact                                                         | Detail                                                                                                                                                                                     |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Patients have no account**                                 | No patient record, no login, no profile, and no way to search for a patient by name or phone through any product surface.                                                                  |
| **Identity is captured once, on the patient's own device**   | At the start of one consultation: full name, age, sex, phone number, and a payment phone number if different. The pharmacy never types them.                                               |
| **Consultations are never recorded**                         | No audio or video is captured. The architecture has no recording capability to disable.                                                                                                    |
| **At completion the clinical record is sealed, not deleted** | No role can read it — not the doctor who wrote it, not the pharmacy, not an administrator browsing the console. No screen anywhere renders a past clinical record.                         |
| **The patient leaves with a consultation reference**         | In the form `NEEM-XXXX-XXXX-XXXX`, shown once on their completion screen. It is the **only** route back to their own record.                                                               |
| **Retention is 3 years from completion**                     | Configurable. At expiry the record is destroyed by a real `DELETE` — not a flag, not an archive table.                                                                                     |
| **Retrieval of a sealed record is controlled**               | Requires the reference, a stated purpose from a closed list, and authorisation by a **second** administrator. Logged as a disclosure in an append-only log that is itself never destroyed. |
| **Backups**                                                  | Encrypted with a separately-managed key, currently retained 30 days.                                                                                                                       |

### What is retained, and for how long

| Data                                                                                           | Retention               | Readable by                                              |
| ---------------------------------------------------------------------------------------------- | ----------------------- | -------------------------------------------------------- |
| Clinical notes, diagnosis, treatment                                                           | 3 years, then destroyed | Nobody through the product; four-eyes retrieval only     |
| Vitals, point-of-care test results                                                             | 3 years, then destroyed | As above                                                 |
| Patient name, age, sex, phone, payment phone                                                   | 3 years, then destroyed | As above                                                 |
| Prescriptions and referrals — including patient name, age and sex **copied onto the document** | Permanent               | The issuing doctor, the dispensing pharmacy, the patient |
| Consultation summary (doctor-authored, mandatory where the outcome is advice only)             | Permanent               | The patient, via their reference                         |
| Operational record — date, duration, pharmacy, doctor, language, outcome                       | Permanent               | Pharmacy (its own only), administrators                  |
| Payments, refunds, revenue, payouts                                                            | Permanent               | Administrators                                           |
| Audit log                                                                                      | Permanent, append-only  | Administrators                                           |

The **prescription exception** is worth stating precisely, because it is the one place patient identity is held permanently: a prescription carries the patient's name, age and sex by value, because it is a document the doctor deliberately issued and the patient carries away. It does **not** carry the phone number, the vitals, the test results, the notes, or the diagnosis. Retaining a prescription is not treated as a licence to retain what sat beside it.

### What has already been settled

Three earlier questions have been answered and the design changed to match. They are recorded here so you can see what has been relied on, and correct it if any of it is wrong.

| Question                                                                                                            | Answer relied on                                                                                                                                                                                                                           | What was built on it                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Does a minimum retention obligation exist for consultation records?                                                 | **Yes** (product owner, from MDC sources, 2026-08-29). Deleting notes at completion breaches the record-keeping duty on registered practitioners under Act 857 and destroys evidence needed during the 3-year civil window for negligence. | The completion purge was removed. Records are sealed and scheduled for destruction instead.                                                                                           |
| Does a sealed archive with **no clinician access** count as complying, given that Neem declines continuity of care? | **Yes** (2026-09-01), on the basis that Neem is a point-of-care consultation platform rather than a longitudinal medical record.                                                                                                           | Controlled administrative retrieval was built: one reference at a time, closed purpose list, two-person authorisation, disclosure logged. Explicitly _not_ a patient-history feature. |
| Does a consultation summary carry a mandated form or content?                                                       | **No** (2026-09-01).                                                                                                                                                                                                                       | The summary's fields are therefore Neem's own design decision, and are documented internally as product policy rather than legal requirement.                                         |

**Please tell us if you disagree with any of these three.** The first two are load-bearing: the whole retention architecture rests on them, and we would rather rebuild than proceed on an answer that does not survive review.

---

## 2. The five questions

### Q1 (G7a) — What is the exact retention period for a consultation record?

**Question.** Our source indicates a range of three to six years. We have configured **three**. What is the correct figure, and from what date does it run — the consultation, the last entry in the record, or the last contact with the patient?

**Why we cannot answer it.** A range is not a configuration value. Choosing three because it is the shortest is a decision about how much patient data to hold, and choosing six because it is safest is the same decision in the other direction; neither is an engineering judgement.

**What the product does today.** Three years from consultation completion, applied per consultation, set as a single configurable value.

**What turns on the answer.** A number. The retention period is a setting, not a schema decision, so a different figure is a configuration change and a re-scheduling of existing destruction jobs — no migration, no rebuild. This is the least disruptive of the five.

**What we specifically need to know.** Whether three years is defensible; if not, the correct period; and whether the clock starts at the consultation or later. We flagged internally that **three years leaves no margin if a negligence limitation period can start later than the consultation date** — for instance on discovery. If that is a real possibility, we would rather hold longer than destroy evidence a claim needs.

---

### Q2 (G7b) — Do paediatric records carry a longer rule?

**Question.** Where the patient is a child, is the retention period different — typically expressed as "until majority plus N years"? If so, what is N, and what age defines a child for this purpose?

**Why it matters here, specifically.** Neem captures patient age, and participating pharmacies serve children. **Nothing in the current design treats a child's record differently from an adult's.** If a longer rule applies, we are currently destroying paediatric records early, which is the failure mode we most want to avoid.

**What the product does today.** One period for every patient regardless of age.

**What turns on the answer.** More than Q1, but still bounded. The destruction job would need to compute an expiry from date of birth rather than a fixed offset from the consultation — and we would need to reconsider capturing **age** rather than date of birth, since "7 years old" does not let us compute a majority date years later. That is a data-capture change on the patient's own screen, and it works against data minimisation, so we would only make it if the answer requires it.

**A related question we would like your view on.** Consent and capacity for a minor. A consultation is initiated at a pharmacy counter and the patient enters their own details on their own phone. Where the patient is a child, we do not currently capture who consented, or their relationship to the child. If that is required, it changes the patient-facing flow and should be decided alongside Q4.

---

### Q3 (G7f) — What backup window is defensible against the retention period?

**Question.** When a clinical record is destroyed at expiry, backups taken before that date still contain it until those backups age out. What backup retention window is acceptable, and does a backup that still holds a destroyed record create a continuing processing obligation?

**Why we cannot answer it.** This is the gap between "we deleted it" and "it is gone", and how large that gap may be is a legal judgement, not an engineering one.

**What the product does today.** Backups are retained **30 days**, encrypted at rest with a key separate from the application's, restorable only by an administrator, and every restore is audited. The window is a documented configuration value, printed on every backup run so it cannot quietly grow, and we intend to state it in the patient notice rather than conceal it. Our position — offered for correction — is that a window materially shorter than the retention period makes destruction effective within a bounded time, and that stating the window openly is more defensible than implying deletion is instantaneous.

**What turns on the answer.** A number, and possibly a statement in the notice. Low engineering cost.

**One thing we would like confirmed rather than assumed.** That holding a clinical record in a backup **during** the retention period raises no separate issue at all — since it is data we are obliged to hold anyway. We believe the only live question is at the far end, after destruction. Please correct us if that is wrong.

---

### Q4 (G7d) — What is the lawful basis, and what must the patient be told, at capture? — **BLOCKS LAUNCH**

**Question.** On what lawful basis does Neem process a patient's personal and health data? What must the patient be told, at what moment, and in what form? Is separate explicit consent required for health data, and if so, how must it be captured and evidenced?

**Why this blocks launch.** **The product currently states no lawful basis anywhere.** At the moment a patient enters their name, age, sex and phone number on their own phone, the only thing the screen tells them is:

> "The doctor needs these to advise you safely and to write a prescription if one is needed."

That is a purpose statement and nothing more. There is no privacy notice, no controller identity, no retention period, no statement of rights, and no consent record. We are not willing to take a first real patient's data in that state, and we would rather be told what is required than invent a notice that reads convincingly and is wrong.

**Two features of the flow that we think complicate the usual answer**, and on which we would particularly like your view:

1. **The consultation is initiated by the pharmacy, not the patient.** A pharmacy staff member creates and takes payment for the consultation before the patient has entered anything or seen any notice. Does that sequencing create a problem? Should a notice appear before payment, at the counter, rather than on the patient's phone afterwards?

2. **The patient has no account, and we hold nothing to contact them with afterwards** beyond the phone number inside the sealed record. A notice shown once on a phone screen may not be adequate evidence that it was given. We can display, require acknowledgement of, and record acceptance of a versioned notice — but whether that is necessary, and what it must contain, is your call.

**What turns on the answer.** Patient-facing screens and a stored consent artefact. This is real product work — a notice, its versioning, an acknowledgement step, and a record of it — but it is additive and does not disturb the retention architecture. We would rather build it once, correctly, than ship something and revise it.

**A related decision waiting on this.** We have deliberately built **no research access** to the sealed archive, even though it appears to be permitted in principle, because research would need a lawful basis and a consent mechanism that do not exist. If Q4 establishes a basis under which consent for research could be captured **at consultation time**, we will design that separately and deliberately. We will not add it as a by-product of anything else.

---

### Q5 (G7e) — How does a patient exercise access and erasure, and how does erasure interact with a retention duty? — **BLOCKS LAUNCH**

**Question.** How does a patient exercise a right of access to their own record, and a right of erasure? Where a statutory retention duty requires us to keep a record the patient asks us to erase, which prevails, and what must we tell the patient?

**Why we cannot answer it.** These two obligations routinely conflict, and the resolution has to be written down before someone asks — not improvised in response to a complaint.

**The specific difficulty this design creates**, which we want to raise plainly rather than hide:

- There is **no patient account and no patient index**. Nothing can be found by name or phone number through any product surface. This was a deliberate privacy decision, and it has a cost.
- The patient's only key to their own record is the **consultation reference** they were shown once on their phone.
- **If they lose that reference, we currently have no way to identify their record for them.** We can service "quote your reference and we will produce that record". We cannot service "I am Ama Mensah, show me my consultations".

We think that trade is defensible — an unindexed archive is much harder to misuse, and the reference is a credential the patient holds rather than one we hold about them. **But it may not be adequate as a rights mechanism**, and if it is not, we need to know now, because the fix is architectural rather than cosmetic: it would mean building the patient index this design exists to avoid, or an identity-verification route into the archive that does not rely on the reference.

**What the product does today.** A patient's access request is serviced through the same controlled retrieval used for legal proceedings: the reference identifies the record, a second administrator authorises, the purpose is recorded as a patient data-access request, and the disclosure is logged. Erasure is not implemented at all, on the assumption that the retention duty prevails during the retention period and that the record is destroyed automatically at the end of it.

**What we specifically need to know.**

1. Is "quote your reference" an adequate access mechanism, or must we be able to identify a patient's records without it?
2. If identity verification is required instead, what standard of verification, and does it justify the patient index we have avoided building?
3. Does the retention duty override an erasure request during the period? If it does, what must we tell the patient — and are we obliged to erase anything that falls outside it, such as the phone number, while retaining the clinical record itself?
4. Does the automatic destruction at expiry satisfy erasure, if the patient is told when it will happen?

---

## 3. What we would like back

For each question: the answer, the source relied on where there is one, and the date. We will record it against the question, change the configuration or build the feature, and note in our decision log which answer drove it.

Where a question cannot be answered definitively, we would like the most defensible position and the reasoning, marked as such. We would rather hold a documented judgement call than an undocumented assumption — and our standing rule for this build is that **nothing is presented as a regulatory requirement without a source behind it**, in either direction. A Neem design choice is never described to a user or a regulator as something the law demanded.

**Please also flag anything in section 1 that we have got wrong**, whether or not it is one of the five. The three already-answered questions in particular are load-bearing, and the cost of correcting them now is far lower than the cost of discovering later that they were wrong.

---

## Appendix — where each answer lands in the system

| Question                   | Change type                    | Where                                                                                                       |
| -------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Q1 Retention period        | Configuration                  | `retention.clinicalRecordYears`; existing destruction jobs re-scheduled                                     |
| Q2 Paediatric rule         | Logic, possibly data capture   | Destruction scheduling; potentially date of birth instead of age on the patient's screen                    |
| Q3 Backup window           | Configuration + notice text    | `retention.backupWindowDays`; backup tooling already prints and enforces it                                 |
| Q4 Lawful basis and notice | New patient-facing feature     | Patient portal capture step; a versioned notice and a stored acknowledgement                                |
| Q5 Access and erasure      | Process, possibly architecture | Controlled retrieval already exists; an identity-based route would be a new and significant design decision |
