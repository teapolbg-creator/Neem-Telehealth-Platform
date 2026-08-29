# Data Retention and Deletion

**Status:** Revised 2026-08-29 following the G7 regulatory answer. This document is the authority on what Neem keeps, for how long, who may read it, and what it destroys.

**This revision reverses the original design.** Phases 0–5 were built on the assumption that clinical information is deleted the moment a consultation completes. That assumption was wrong in Ghanaian law. See decision D23.

---

## 1. The rule

> Clinical records are **retained under legal obligation** for a configured period, encrypted at rest, and **readable by no one through the product**. They are destroyed when that period expires. Operational and financial records are permanent. Prescriptions and referrals are permanent because a doctor deliberately issued them as documents.

Two obligations sit behind this, and they are not the same:

| Obligation | Source | What it requires |
| --- | --- | --- |
| **Record-keeping** | Health Professions Regulatory Bodies Act, 2013 (Act 857); MDC ethical code; the 3-year civil-action window for medical negligence | The records must **exist** and be producible |
| **Continuity of care** | Clinical practice standards | A future clinician should be able to **read** them |

**Neem satisfies the first and declines the second** (decision D23). The record exists; no clinician can reach it. That is the most protective position that still discharges the statutory duty.

Destruction still means `DELETE` from the primary tables — not hiding a row, not setting a flag (spec §62). What changed is *when*, not *how*.

---

## 2. Classification

### Deleted at consultation completion

| Data | Table | Why it goes immediately |
| --- | --- | --- |
| Consultation access token | `consultation_access_tokens` | A credential, not a record. Nothing about record-keeping requires keeping a key |
| Live audio/video stream | — | Never captured. Recording is structurally impossible (D8), and purging transient media is explicitly endorsed by the G7 finding |

### Retained for the clinical retention period, then destroyed

Encrypted at rest. **No product surface reads these.** Default period: **3 years from consultation completion**, configurable via `retention.clinicalRecordYears`.

| Data | Table |
| --- | --- |
| Clinical notes | `consultation_clinical_notes` |
| Diagnosis | `consultation_clinical_notes` |
| Treatment information | `consultation_clinical_notes` |
| Vitals (BP, pulse, temperature, weight, SpO₂) | `consultation_vitals` |
| Point-of-care test results | `consultation_tests` |
| Patient full name, age, sex | `patient_sessions` |
| Patient phone number | `patient_sessions` |
| Payment phone number (when different) | `patient_sessions` |

Patient identity is retained because a clinical record nobody can attribute to a patient discharges no duty at all — it could not be produced for an MDC inquiry, a negligence claim, or the patient's own access request.

### Retained permanently

| Data | Why |
| --- | --- |
| Consultation id, pharmacy, doctor, date, time, language, duration, type, outcome | Operational record (spec §12) |
| `hasPrescription` / `hasReferral` flags and status | Operational record |
| Prescription: id, doctor, patient **name, age, sex**, medications, dates, state, versions | Explicit exception (spec §11) |
| Referral: id, doctor, destination, doctor-authored reason, patient name/age/sex | Doctor-issued permanent document |
| Payment id, provider reference, amount, currency, status, timestamps | Financial record (spec §63) |
| Revenue allocation, refunds, payouts | Financial record |
| Patient feedback and ratings | Permanent, immutable (spec §51) |
| Audit log entries | Compliance (spec §61) |
| Consultation state history | Operational integrity |

### The prescription exception, stated precisely

A prescription permanently contains the patient's name, age, and sex — **copied by value** at issue time. It does not carry the phone number, the vitals, the test results, the clinical notes, or the diagnosis. Retaining a prescription is not a licence to retain everything that sat beside it (spec §11).

Referral `reasonText` is clinical text the doctor chose to commit to a permanent, patient-carried document. That is a deliberate act of documentation, distinct from working notes.

---

## 3. What spec §13 now means

The specification says a medical history must never appear — "whether as a feature, a convenience cache, an analytics table, or an over-broad audit log."

**That can no longer be a guarantee about the data.** If records persist for three years, and must be producible for a named patient on request, then a patient index has to exist. There is no way to service a subject-access request, an MDC inquiry, or a negligence claim against per-consultation islands with no way to find them.

So §13 is preserved as an **access** guarantee instead:

- No doctor sees any consultation but the one in front of them. There is no route, no query, and no screen that returns a patient's prior records to a clinician.
- No pharmacy sees clinical data at all beyond the active consultation.
- The audit log remains schema-restricted against clinical content, with a test enforcing it. It is not a back-door history, and that matters more now, not less.
- Retained records are reachable only by an **audited break-glass action** (§4).

This is a real reduction in the original promise, and it is stated here rather than glossed.

---

## 4. Break-glass access

The only path to a retained clinical record.

**Permitted purposes, and no others:**
1. A Medical & Dental Council inquiry.
2. A medical negligence claim or the credible threat of one.
3. A patient's own subject-access request under the Data Protection Act, 2012 (Act 843).
4. A lawful order compelling production.

**Controls:**
- Two-person authorisation — a single admin cannot unseal a record alone.
- A stated purpose and reference, recorded before access, not after.
- Every access written to `clinical_record_access_log` with actor, purpose, reference, and the exact records reached. That log is append-only and is itself never purged.
- Access produces an export, not a browsable screen. There is deliberately no UI that renders a patient's clinical past.

---

## 5. Mechanism

Completion no longer purges clinical data. It **schedules** its destruction:

```
POST /doctor/consultations/:id/complete
  BEGIN
    validate outcome present and state = IN_PROGRESS
    write consultation operational fields (duration, outcome, timestamps)
    if prescription: copy patientName/Age/Sex by value onto the prescription
    if referral:     copy patientName/Age/Sex by value onto the referral
    seal clinical record   (encrypt any field not already encrypted)
    DELETE consultation_access_tokens WHERE consultationId = ?   -- credential, goes now
    end media session (no recording ever existed)
    write retention_jobs row: scheduledFor = now + retention.clinicalRecordYears
    write audit entry (no content)
    state → COMPLETED
  COMMIT
```

A `purge-expired-clinical-records` job then runs on schedule, deleting records whose `retention_jobs.scheduledFor` has passed and recording the row counts destroyed.

If any step fails, the whole transaction rolls back. **A consultation is never reported complete while its record is unsealed or its destruction unscheduled.**

---

## 6. Verification

`retention_jobs` records, per consultation, when destruction is due, what was destroyed, and when it was verified.

The spec §101 critical test changes shape. It is no longer "clinical data present during, absent after completion." It becomes three assertions:

1. After completion, clinical data **still exists** and is encrypted.
2. After completion, **no authenticated role can read it** through any route — doctor, pharmacy, admin, or patient. This is the assertion that now carries the privacy guarantee.
3. After the retention period elapses and the job runs, the rows are **gone**.

---

## 7. Backups

Backups now sit inside the retention period rather than outstripping it, which simplifies the position: a backup containing a clinical record is holding data Neem is obliged to hold anyway.

The obligation that remains is at the far end. When a record is destroyed at expiry, backups taken before that date still contain it until they age out. The backup window must therefore be **materially shorter than the retention period**, so that destruction is genuinely effective within a bounded time.

- The window is a documented, configured number of days.
- Backups are encrypted at rest with separately-managed keys.
- Restore is admin-only and audited.
- The window is stated in the privacy notice rather than concealed.

---

## 8. Consultation history — operational, not medical

Doctors and pharmacies see historical consultations as: identifier, date, duration, language, type, outcome, and whether a prescription or referral was issued.

They cannot see clinical notes, diagnoses, treatment information, vitals, or test results from past consultations. Those records exist, and neither role has any route that returns them.

---

## 9. Analytics

Aggregate analytics run only over operational and financial data: volumes, durations, wait times, outcomes, prescription and referral counts, language demand, time-of-day demand, utilisation, satisfaction, complaints.

Retained clinical records are **not** an analytics source. They are sealed for a legal purpose, and mining them for insight would be a different processing purpose requiring its own lawful basis and its own consent. Diagnoses are not aggregated, and the analytics UI says so where a user might expect otherwise (spec §54, §75).

If epidemiological reporting later becomes a business requirement, it needs a separate, consented aggregation captured **at consultation time** — not a quiet re-purposing of the sealed archive. Logged in the backlog as a post-MVP decision requiring approval.

---

## 10. Still open with counsel

| # | Question | Why it matters here |
| --- | --- | --- |
| G7a | The exact retention period. The source range is 3–6 years; 3 is configured | Three years leaves no margin if a negligence clock starts later than the consultation date |
| G7b | Whether paediatric records carry a longer rule — typically to majority plus N years | Neem captures patient age and pharmacies serve children. Nothing in the current design treats them differently |
| G7c | Whether "sealed archive, no clinician access" discharges the duty, given that the continuity-of-care argument is declined | If counsel says no, D23 reopens and a consented read path is added |
| G7d | The lawful basis and the required form of patient notice at capture | The product currently states no basis anywhere |
| G7e | How a patient exercises access and erasure rights, and how erasure interacts with a statutory retention duty | These usually conflict; the resolution has to be written down |
| G7f | An acceptable backup window against a 3-year retention period | §7 |
