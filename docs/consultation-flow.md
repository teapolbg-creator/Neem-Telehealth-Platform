# Consultation Flow and State Machine

**Status:** Proposed (Phase 0).

---

## 1. End-to-end flow

```
PHARMACY                 PATIENT (own phone)        NEEM                    DOCTOR
────────                 ───────────────────        ────                    ──────
create consultation ───▶ PENDING_PAYMENT
take payment       ───▶  PAYMENT_PROCESSING
                                              Paystack webhook +
                                              server-side verify
                                                    │
                                              PAID ─┘
                         issue token + QR ◀─── ACTIVATED
scan QR ───────────────▶ token exchange → device-bound session
                         enter name/age/sex/phone
                         choose language
                         choose audio | video | Call Me
                         WAITING_FOR_DOCTOR ──▶ smart queue scores
                                                eligible doctors
                                                      │
                                                offer ├──────────────▶ 90s window
                                                      │◀───── accept ──┘
                                                ASSIGNED → DOCTOR_ACCEPTED
                         ◀────────────── media session established ──▶
                         IN_PROGRESS · 5-min timer, warning only
vitals/tests entry ────▶ (sealed at end) ◀── doctor reads
                                                      doctor records outcome
                                                      prescription / referral
                                              COMPLETING
                                              ├─ persist permanent records
                                              ├─ seal record + schedule destruction
                                              ├─ invalidate token + QR
                                              └─ end media session
                                              COMPLETED
receive prescription ◀──────────────────────────────┘
propose substitution ──▶ doctor approves/rejects ─────────────────────▶
mark dispensed                                     patient leaves feedback
```

---

## 2. States

| State                 | Meaning                                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PENDING_PAYMENT`     | Consultation created; payment window open (default 300s)                                                                                                                 |
| `PAYMENT_PROCESSING`  | Payment initiated with the provider; awaiting confirmation                                                                                                               |
| `PAID`                | Payment verified **server-side**. Never entered on a client claim                                                                                                        |
| `ACTIVATED`           | Paid and ready; the pharmacy may now issue the QR. The token is minted when the QR is requested, because only a hash is stored and the code can be rendered exactly once |
| `WAITING_FOR_PATIENT` | Token issued, not yet consumed                                                                                                                                           |
| `PATIENT_JOINED`      | Token consumed, identity captured, language and mode chosen                                                                                                              |
| `WAITING_FOR_DOCTOR`  | In the allocation queue                                                                                                                                                  |
| `ASSIGNED`            | Offered to a specific doctor; 90s window running                                                                                                                         |
| `DOCTOR_ACCEPTED`     | Doctor accepted; media session being established                                                                                                                         |
| `IN_PROGRESS`         | Clinical interaction underway; timer running                                                                                                                             |
| `COMPLETING`          | Doctor submitted the outcome; the completion transaction is running                                                                                                      |
| `COMPLETED`           | Terminal. Permanent records written, clinical record sealed and its destruction scheduled (D23)                                                                          |

Alternate and terminal states: `PAYMENT_FAILED`, `EXPIRED`, `CANCELLED`, `REASSIGNING`, `ABANDONED`, `REFUND_REQUESTED`, `REFUNDED`.

---

## 3. Valid transitions

Any transition not listed is rejected with `409 INVALID_STATE_TRANSITION`, and both the attempt and the rejection are recorded in `consultation_state_events`.

```
PENDING_PAYMENT      → PAYMENT_PROCESSING | EXPIRED | CANCELLED
PAYMENT_PROCESSING   → PAID | PAYMENT_FAILED | EXPIRED
PAYMENT_FAILED       → PAYMENT_PROCESSING (retry) | EXPIRED | CANCELLED
PAID                 → ACTIVATED
ACTIVATED            → WAITING_FOR_PATIENT | CANCELLED | EXPIRED | REFUND_REQUESTED
WAITING_FOR_PATIENT  → PATIENT_JOINED | EXPIRED | CANCELLED | REFUND_REQUESTED
PATIENT_JOINED       → WAITING_FOR_DOCTOR | CANCELLED | REFUND_REQUESTED
WAITING_FOR_DOCTOR   → ASSIGNED | CANCELLED | REFUND_REQUESTED | ABANDONED
ASSIGNED             → DOCTOR_ACCEPTED | REASSIGNING | CANCELLED
REASSIGNING          → ASSIGNED | WAITING_FOR_DOCTOR | CANCELLED
DOCTOR_ACCEPTED      → IN_PROGRESS | REASSIGNING | ABANDONED
IN_PROGRESS          → COMPLETING | ABANDONED
COMPLETING           → COMPLETED
REFUND_REQUESTED     → REFUNDED | ACTIVATED | WAITING_FOR_PATIENT | PATIENT_JOINED
                       | WAITING_FOR_DOCTOR | COMPLETED
                       (returns to its prior state when an admin rejects)
COMPLETED            → (terminal)
EXPIRED / CANCELLED / REFUNDED / ABANDONED → (terminal)
```

Transitions are executed by a single guarded function. The service layer never assigns `state` directly.

---

## 4. Rules the state machine enforces

**Payment.** `PAID` is reachable only from a server-side verification result or a signature-verified webhook. A client POST claiming success cannot produce it (spec §34).

**The 5-minute timer never ends a consultation.** At 60s remaining, the doctor gets a warning and the patient sees a discreet indicator; at zero, the timer turns into an overrun counter. Only the doctor completes (spec §15).

**Doctors cannot decline.** There is no reject endpoint. Non-response for 90 seconds records a `MISSED_RESPONSE` performance event and returns the consultation to allocation (spec §30).

**Patients are never abandoned.** Every path out of `WAITING_FOR_DOCTOR` is either assignment, an explicit patient cancellation with a refund request, or an admin action. Queue depth and no-language-match conditions raise admin alerts (spec §29, §37).

**Completion is one transaction.** Writing permanent records, sealing the clinical record, scheduling its destruction, invalidating tokens, and ending the media session either all happen or none do. If any part fails, the transaction rolls back — a consultation is never reported complete with an unsealed record or no scheduled destruction (spec §16, §101).

> Until D23 this paragraph said the transaction **purged** clinical data, and that a failed purge rolled back so "completion is never reported while clinical data survives". Ghanaian law does not permit that deletion. What completion destroys now is the access token — a credential, not a record — and what it schedules is destruction after the retention period.

---

## 5. Failure handling

| Failure                   | Behaviour                                                                                                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Payment fails             | Patient retries within the 5-minute window; after that `EXPIRED` and the payment session is cleaned up                                                                                    |
| Webhook arrives late      | Processed if the consultation is still valid; otherwise flagged for admin reconciliation. Never creates a second consultation                                                             |
| Duplicate webhook         | Rejected by the `providerEventId` unique constraint; acknowledged 200 without re-processing                                                                                               |
| Patient never scans       | Token expires; consultation `EXPIRED`; refund path available                                                                                                                              |
| QR reused                 | Rejected. The token is consumed on first exchange; the patient's own device continues on its session cookie. A lost device requires a pharmacy-issued replacement token, which is audited |
| Doctor misses 90s         | `MISSED_RESPONSE` recorded, reassignment, patient keeps waiting with status updates                                                                                                       |
| No language match         | Patient stays queued **and** an admin alert fires. No doctor without the language is ever assigned (spec §29)                                                                             |
| Media provider failure    | Media session marked failed; patient offered the remaining modes; consultation state is untouched                                                                                         |
| Patient disconnects       | Session survives for a reconnect grace period; doctor sees "patient disconnected"; doctor decides whether to complete or wait                                                             |
| Doctor disconnects        | Consultation returns to `REASSIGNING` after a grace period; the patient is told a new doctor is being found                                                                               |
| Browser permission denied | Explicit guidance plus a fallback to audio or Call Me                                                                                                                                     |
| Prescription PDF fails    | Prescription stays `ISSUED` and the PDF is regenerated on demand; the clinical record is never lost to a rendering failure                                                                |
