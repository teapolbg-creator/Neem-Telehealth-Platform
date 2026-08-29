# Data Retention and Deletion

**Status:** Proposed (Phase 0). This document is the authority on what Neem keeps and what it destroys.

---

## 1. The rule

> Clinical information exists only for the duration of the consultation. Operational and financial records are permanent. The prescription and referral are the only permitted clinical carry-forwards, and only because a doctor deliberately issued them as documents.

Deletion means `DELETE` from the primary tables — not hiding a row from a query, not setting a flag (spec §62).

---

## 2. Classification

### Deleted at consultation completion

| Data | Table |
| --- | --- |
| Patient full name, age, sex | `patient_sessions` |
| Patient phone number | `patient_sessions` |
| Payment phone number (when different) | `patient_sessions` |
| Clinical notes | `consultation_clinical_notes` |
| Diagnosis | `consultation_clinical_notes` |
| Treatment information | `consultation_clinical_notes` |
| Vitals (BP, pulse, temperature, weight, SpO₂) | `consultation_vitals` |
| Point-of-care test results (RDT, RBS, dipstick, pregnancy, other) | `consultation_tests` |
| Consultation access token | `consultation_access_tokens` |

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

A prescription permanently contains the patient's name, age, and sex — **copied by value** at issue time. It does **not** carry the phone number, the vitals, the test results, the clinical notes, or the diagnosis. Retaining a prescription is not a licence to retain everything that happened to sit beside it (spec §11).

Referral `reasonText` is clinical text that the doctor chose to commit to a permanent, patient-carried document. That is a deliberate act of documentation, distinct from working notes.

---

## 3. Mechanism

Deletion is part of the completion transaction, not a follow-up:

```
POST /doctor/consultations/:id/complete
  BEGIN
    validate outcome present and state = IN_PROGRESS
    write consultation operational fields (duration, outcome, timestamps)
    if prescription: copy patientName/Age/Sex by value onto the prescription
    if referral:     copy patientName/Age/Sex by value onto the referral
    DELETE consultation_clinical_notes WHERE consultationId = ?
    DELETE consultation_vitals         WHERE consultationId = ?
    DELETE consultation_tests          WHERE consultationId = ?
    DELETE patient_sessions            WHERE consultationId = ?
    DELETE consultation_access_tokens  WHERE consultationId = ?
    end media session (recording never existed)
    write retention_jobs row with the deleted row counts
    write audit entry (counts only — no content)
    state → COMPLETED
  COMMIT
```

If any delete fails, the whole transaction rolls back. **A consultation is never reported complete while clinical data survives.**

A `purge-temporary-data` job runs every 60 seconds as a safety net for crashed or abandoned consultations, and records everything it finds — so a gap is visible rather than silent.

---

## 4. Verification

`retention_jobs` records, per consultation, what was scheduled, what was deleted, and when it was verified. This makes spec §101 demonstrable: query the temporary tables for a completed consultation and get zero rows, while the operational record and any prescription remain fully intact. It is an executable test, not a claim.

---

## 5. Backups — stated honestly

Database backups taken before a purge **will** contain the deleted rows until those backups age out. Nothing in the application can change that, and pretending otherwise would be false.

What is done instead:

- The backup retention window is a documented, configured number of days.
- Backups are encrypted at rest with separately-managed keys.
- Access to restore is admin-only and audited.
- The window is stated in the privacy documentation rather than concealed.

**Open item for legal review:** whether the chosen backup window is acceptable under applicable Ghanaian data protection requirements. See `compliance/ghana-regulatory-register.md`.

---

## 6. Consultation history — operational, not medical

Doctors and pharmacies can see historical consultations. What they see is: identifier, date, duration, language, type, outcome, and whether a prescription or referral was issued.

They cannot see clinical notes, diagnoses, treatment information, vitals, or test results from past consultations — those no longer exist anywhere in the system.

**There is no hidden medical history table, and the audit log is not one.** The audit log records that an action occurred, by whom, and against which entity; its `metadata` is schema-restricted to exclude clinical content, and a test asserts that restriction (spec §13, §61).

---

## 7. Analytics

Aggregate analytics run only over retained data: volumes, durations, wait times, outcomes, prescription and referral counts, language demand, time-of-day demand, pharmacy and doctor utilisation, satisfaction, complaints.

Because diagnoses are deleted, **detailed epidemiological trend analysis over diagnoses is not available**, and the analytics UI must say so where a user might expect it. The system will not manufacture clinical history from data it does not have (spec §54, §75).

If genuine epidemiological reporting later becomes a business requirement, it needs a separate, consented, explicitly-designed aggregation captured **at consultation time** — not a quiet relaxation of the deletion rule. That is logged in the backlog as a post-MVP decision requiring your approval.
