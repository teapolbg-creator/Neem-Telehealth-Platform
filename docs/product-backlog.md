# Product Backlog

Per spec §108. The purpose of this file is to hold a scope fence: nothing below the line silently moves above it.

---

## MVP — required now

**Patient.** No-account access · one-time QR · identity capture (full name, age, sex, phone) · language selection · audio / video / Call Me · waiting room · consultation · **consultation reference given at completion (D24)** · prescription, referral and consultation-summary download · feedback (doctor rating, Neem rating, category) · refund request.

**Pharmacy.** Login · initiate consultation · payment collection · QR generation · consultation monitoring · temporary patient panel during the active consultation · vitals and point-of-care test entry · cancellation · reassignment request · receive, view, print, download prescriptions · propose substitution · mark dispensed · referral print/download · pharmacy-share financials · operational consultation history · onboarding with document upload.

**Doctor.** Registration and document upload · drawn digital signature · await approval · language selection · shift view and confirmation · 40-hour ceiling · receive assignment (no decline) · 90-second response window · audio / video / Call Me · consultation timer · temporary clinical workspace · outcome capture · **consultation summary authoring, mandatory for advice-only (D25)** · prescription creation and revocation before dispensing · substitution decisions · referral creation · completion · earnings and service hours · operational history.

**Admin.** Doctor and pharmacy lifecycle management · credential verification · subscriptions · shifts · payments and refunds · pharmacy payouts · configuration (price, duration, revenue split, compensation parameters, membership fee, languages, queue weights, quality weights, notification templates, complaint categories, promotions) · complaints and quality review · analytics · audit logs · system health · manual queue intervention.

**Platform.** Smart queue · consultation state machine · prescription state machine · doctor and pharmacy state machines · payment integrity and idempotency · revenue calculation · data retention and deletion · audit logging · notifications across five channels · real-time updates · security controls · demo seed data.

---

## Post-MVP — architected for, deliberately not built

| Item | What already accommodates it |
| --- | --- |
| Native mobile apps | REST API + `publicId` contracts are client-agnostic |
| 24-hour operations / night shift | `shift_definitions` seeded inactive with `crossesMidnight` |
| Specialist consultations | `doctors.specialty` exists; the queue filter is extensible |
| Additional languages | `languages` table, admin-toggled |
| Hospital referral network | `referrals` stores destination as free text today |
| Pharmacy inventory | Explicitly out of scope (spec §19); substitution needs no stock data |
| Automated pharmacy payouts | `PayoutProcessor` interface with a manual implementation |
| Automated MDC licence verification | `doctor_documents` + manual verification; an adapter slot exists |
| Connected medical devices | `consultation_vitals` is source-agnostic |
| Insurance integration | Payment abstraction |
| Additional payment providers | `PaymentProvider` interface |
| Advanced / AI operational analytics | Aggregation layer over retained data only |
| Multi-account pharmacy staff with roles | `pharmacy_users` join table already supports N accounts |
| Patient-initiated consultations outside a pharmacy | Consultation creation is currently pharmacy-scoped by design |

---

## Deferred by decision on 2026-08-29 — post-MVP, not parked

These were raised in Phase 0 and explicitly ruled out of V1. Each would be additive, not a rewrite.

| Item | Decision | To revisit it, you need |
| --- | --- | --- |
| In-consultation text chat | D15 — cut | A retention rule for message content |
| In-consultation image upload | D15 — cut | A retention rule for uploaded images, plus storage and scanning |
| Third-party institutional prescription access | D13 — out | Consent capture, a lawful basis, and the `disclosure_log` activated |
| Prescriptions used for research / QA analytics | D13 — out | Consent, a lawful basis, and an aggregation design |
| ~~Patient-facing clinical summary or doctor remark~~ | **REINSTATED by D25** | Nothing. D14 excluded it solely to protect the deletion guarantee; D23 established that guarantee was never lawful. A doctor-authored **consultation summary** is now mandatory for advice-only outcomes and optional otherwise |
| Detailed epidemiological analysis over diagnoses | Still out | Records now persist, but sealed for a **legal** purpose. Mining them for insight is a different processing purpose needing its own lawful basis and consent. Never a quiet re-purposing of the archive (D23) |

---

## Explicitly excluded from V1

Pharmacy inventory and stock management · separate pharmacy staff roles · any consultation recording · a hospital referral network · automated MDC verification · automated doctor salary transfer · a patient medical history feature of any kind.

The last one is worth restating: **a hidden medical history must never appear**, whether as a feature, a convenience cache, an analytics table, or an over-broad audit log (spec §13, §61, §105).

**And it survives D23 intact**, which is worth spelling out because that decision retained clinical records for three years. What keeps §13 true is D24: there is **no patient profile and no patient index**. Records are located by consultation reference — a receipt number, not an identity — so no table is keyed by person and no query returns "every consultation for this phone number". A retained record is not a history unless something can assemble it, and nothing can.
