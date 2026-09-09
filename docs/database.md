# Neem — Database Design

**Status:** Proposed (Phase 0). MySQL 8 + Prisma. Not yet implemented.

---

## 1. Principles

1. **Two identifiers per externally-visible entity.** `id` is a UUIDv7 primary key (time-ordered, index-friendly). `publicId` is a short opaque string used in URLs and printed documents. Auto-increment integers are never exposed (spec §65).
2. **Money is an integer.** All amounts are `Int` in **pesewas** (GHS minor units), with a `currency` column. No `FLOAT`, no `DOUBLE`, no `DECIMAL` arithmetic in application code (spec §38, §98).
3. **Percentages are basis points.** `pharmacySharePctBp = 3000` means 30.00%. Splits are computed with integer arithmetic and the remainder is assigned deterministically so the parts always sum to the whole.
4. **Retention class is a schema-level fact.** Every table below is tagged **PERMANENT**, **TEMPORARY**, or **OPERATIONAL**. Temporary tables hold nothing the system needs after completion, so purging is a `DELETE`, not a nullification sweep.
5. **History is append-only where integrity matters.** Prescription states, consultation states, settings changes, and audit entries are never updated in place (spec §47, §97).
6. **Sensitive at-rest fields are encrypted** with application-level AES-256-GCM using a key from the environment: patient name/phone, doctor signature, pharmacy payout details, TOTP secrets. Column names below carry an `Enc` suffix where this applies.
7. **Every foreign key is explicit,** with `RESTRICT` on anything financial or clinical and `CASCADE` only where the child is genuinely a component of the parent (e.g. `prescription_items` under `prescriptions`).

---

## 2. ERD — logical view

```
                    ┌──────────┐
                    │  users   │──1:1──▶ admins / doctors / pharmacy_users
                    └────┬─────┘
                         │ 1:N
                    ┌────▼──────┐        ┌────────────┐
                    │ sessions  │        │ languages  │
                    └───────────┘        └─────┬──────┘
                                               │
   ┌────────────┐                    ┌─────────▼─────────┐
   │ pharmacies │◀───────────────────│  consultations    │──────────┐
   └─────┬──────┘  1:N               └────┬────┬────┬────┘  1:N     │
         │                                │    │    │               │
   pharmacy_hours                         │    │    │          ┌────▼─────────┐
   pharmacy_capabilities                  │    │    │          │  payments    │
   pharmacy_payout_details                │    │    │          └────┬─────────┘
   pharmacy_payouts                       │    │    │               │
                                          │    │    │        ┌──────▼────────────┐
   ┌─────────┐    1:N                     │    │    │        │ revenue_allocations│
   │ doctors │◀────────────────────────────┘    │    │        └───────────────────┘
   └────┬────┘                                  │    │        refunds
        │                                       │    │        payment_webhook_events
   doctor_documents                             │    │
   doctor_languages          ┌──────────────────▼──┐ │
   doctor_signatures         │ SEALED AT COMPLETION│ │
   doctor_subscriptions      │ patient_sessions    │ │
   doctor_shift_assignments  │ clinical_notes      │ │
   doctor_service_hours      │ consultation_vitals │ │
   doctor_performance_events │ consultation_tests  │ │
   doctor_quality_scores     └─────────────────────┘ │
                                                     │
                  ┌──────────────────────────────────┼───────────────┐
                  │                                  │               │
          ┌───────▼────────┐               ┌─────────▼──────┐  ┌─────▼─────┐
          │ prescriptions  │               │   referrals    │  │ feedback  │
          └───┬────────┬───┘               └────────────────┘  └─────┬─────┘
              │        │                                             │
   prescription_items  prescription_versions                     complaints
   substitution_requests

   Cross-cutting: audit_logs · notifications · notification_templates ·
                  system_settings · system_setting_history · promotions ·
                  promotion_redemptions · consultation_queue_entries ·
                  consultation_assignments · consultation_state_events ·
                  media_sessions · retention_jobs
```

---

## 3. Tables

### 3.1 Identity and access — OPERATIONAL

**`users`** — `id`, `publicId`, `email` UNIQUE, `passwordHash` (argon2id), `role` ENUM(`ADMIN`,`DOCTOR`,`PHARMACY`), `status`, `twoFactorSecretEnc`, `twoFactorEnabledAt`, `failedLoginCount`, `lockedUntil`, `lastLoginAt`, `passwordChangedAt`, timestamps.
There is no patient row here — patients have no account (spec §8.1).

**`sessions`** — `id`, `userId` FK, `tokenHash` (SHA-256 of an opaque 256-bit token; the raw token exists only in the cookie), `expiresAt`, `absoluteExpiresAt`, `ipHash`, `userAgent`, `revokedAt`, `createdAt`. Indexed on `tokenHash`, `userId`.

**`password_reset_tokens`** — `id`, `userId`, `tokenHash`, `expiresAt`, `usedAt`. Single use.

**`admins`** — `userId` PK/FK, `fullName`, `title`.

### 3.2 Pharmacies — OPERATIONAL

**`pharmacies`** — `id`, `publicId`, `name`, `councilRegistrationNo` UNIQUE, `ownerName`, `responsiblePharmacistName`, `responsiblePharmacistLicenceNo`, `addressLine1/2`, `city`, `region`, `latitude`, `longitude`, `phone`, `email`, `status` ENUM(`PENDING`,`UNDER_REVIEW`,`APPROVED`,`ACTIVE`,`SUSPENDED`,`REJECTED`), `statusReason`, `approvedAt`, `approvedByAdminId`, `isDemo`, timestamps.
Only `ACTIVE` may initiate consultations — enforced in the service layer and asserted by test (spec §84).

**`pharmacy_users`** — `pharmacyId`, `userId` UNIQUE. One account per pharmacy in the MVP; the join table exists so multiple accounts need no migration later. No staff-role column — the answers document is explicit that there are no separate pharmacy roles.

**`pharmacy_hours`** — `pharmacyId`, `dayOfWeek` 0–6, `opensAt`, `closesAt`.

**`pharmacy_capabilities`** — `pharmacyId`, `kind` ENUM(`SERVICE`,`TEST`,`EQUIPMENT`), `code`, `label`. Drives which point-of-care tests the pharmacy screen offers.

**`pharmacy_payout_details`** — `pharmacyId`, `method`, `accountNameEnc`, `accountNumberEnc`, `bankOrNetwork`, `verifiedAt`. Encrypted; never returned in full over the API.

**`pharmacy_documents`** — `pharmacyId`, `type`, `storageKey`, `mimeType`, `sizeBytes`, `uploadedAt`, `verifiedAt`, `verifiedByAdminId`, `note`.

### 3.3 Doctors — OPERATIONAL

**`doctors`** — `id`, `publicId`, `userId` UNIQUE, `fullName`, `mdcNumber` UNIQUE, `mdcIssuedAt`, `mdcExpiresAt`, `qualifiedAt`, `yearsExperience`, `specialty`, `bio`, `photoStorageKey`, `status` ENUM(`PENDING`,`UNDER_REVIEW`,`APPROVED`,`ACTIVE`,`SUSPENDED`,`EXPIRED`,`REJECTED`), `statusReason`, `approvedAt`, `approvedByAdminId`, `employmentType` ENUM(`FULL_TIME`,`PART_TIME`,`CONTRACT`), `contractedHoursPerWeek`, `hourlyRateMinor`, `monthlySalaryMinor`, `isDemo`, timestamps.
Compensation fields are configurable and **nullable** — the part-time formula is undecided, so nothing computes salary automatically (spec §26).
`mdcExpiresAt` drives the daily expiry-warning job. **The system performs no automated MDC verification** and the UI must not imply otherwise (spec §22).

**`doctor_documents`** — `doctorId`, `type` ENUM(`MDC_LICENCE`,`GOVERNMENT_ID`,`EMPLOYMENT_VERIFICATION`,`PRACTICE_EVIDENCE`,`OTHER`), `storageKey`, `mimeType`, `sizeBytes`, `uploadedAt`, `verifiedAt`, `verifiedByAdminId`, `note`. Files are stored outside the web root and served only through an authorised, audited endpoint.

**`doctor_languages`** — `doctorId`, `languageId`, PK on the pair.

**`doctor_signatures`** — `id`, `doctorId`, `signatureDataEnc` (the drawn signature, encrypted), `capturedAt`, `capturedIpHash`, `isActive`. Never exposed at a public URL; the PDF generator reads it in-process only after confirming the requesting doctor is the authenticated, `ACTIVE`, verified owner (spec §23).

**`doctor_subscriptions`** — `id`, `doctorId`, `periodStart`, `periodEnd`, `amountMinor`, `currency`, `status` ENUM(`PENDING`,`ACTIVE`,`EXPIRED`,`CANCELLED`,`GRACE`), `paymentId` FK, `graceEndsAt`, `renewedFromId`. Expiry flips the doctor `ACTIVE → SUSPENDED` unless an admin overrides (spec §27).

**`doctor_performance_events`** — `id`, `doctorId`, `type` ENUM(`RATING`,`COMPLAINT`,`MISSED_RESPONSE`,`COMPLETED`,`ABANDONED`,`AUDIT`,`RX_ISSUE`), `consultationId` NULL, `numericValue`, `occurredAt`. The raw material for the quality score; carries no clinical content.

**`doctor_quality_scores`** — `doctorId`, `periodStart`, `periodEnd`, `score`, `breakdown` JSON, `computedAt`. Never exposed to doctors (spec §52).

### 3.4 Scheduling — OPERATIONAL

**`shift_definitions`** — `id`, `code`, `label`, `startsAt` TIME, `endsAt` TIME, `crossesMidnight`, `isActive`. Seeded with MORNING 08:00–14:00 and AFTERNOON 14:00–20:00; NIGHT 20:00–08:00 seeded inactive.

**`doctor_shift_assignments`** — `id`, `doctorId`, `shiftDefinitionId`, `serviceDate`, `status` ENUM(`ASSIGNED`,`CONFIRMED`,`DECLINED`,`CANCELLED`), `assignedByAdminId`, `confirmedAt`, `minutesPlanned`. UNIQUE(`doctorId`,`serviceDate`,`shiftDefinitionId`).

**`doctor_service_hours`** — `doctorId`, `isoYear`, `isoWeek`, `minutesScheduled`, `minutesServed`, `updatedAt`. UNIQUE(`doctorId`,`isoYear`,`isoWeek`). The 40-hour ceiling is checked inside the assignment transaction against this row, so a race cannot exceed it (spec §25).

**`doctor_presence`** — `doctorId`, `onlineSince`, `lastHeartbeatAt`, `currentLoad`. Live availability, distinct from scheduled shifts.

**`languages`** — `id`, `code` UNIQUE, `label`, `subtitle`, `isActive`, `sortOrder`. Seeded with English/Twi/Ga active and Ewe/Hausa/Dagbani inactive.

### 3.5 Consultations

**`consultations`** — PERMANENT (operational fields only)
`id`, `publicId`, `pharmacyId` FK, `doctorId` FK NULL, `state`, `type` ENUM(`AUDIO`,`VIDEO`,`CALL_ME`) NULL until chosen, `languageId` FK NULL until chosen, `priceMinor`, `discountMinor`, `netMinor`, `currency`, `promotionId` NULL, `createdAt`, `paymentDeadlineAt`, `activatedAt`, `patientJoinedAt`, `queuedAt`, `assignedAt`, `startedAt`, `completedAt`, `durationSeconds`, `outcome` ENUM(`ADVICE_ONLY`,`PRESCRIPTION`,`REFERRAL`,`EMERGENCY_REFERRAL`,`OTHER`) NULL, `hasPrescription`, `hasReferral`, `cancellationReason`, `isDemo`.
Indexes: (`pharmacyId`,`createdAt`), (`doctorId`,`createdAt`), (`state`), (`publicId` UNIQUE).
**No clinical column lives here.** Once the sealed record has been destroyed, this row is a complete, honest operational record and nothing more (spec §12).

**`consultation_state_events`** — PERMANENT, append-only
`id`, `consultationId`, `fromState`, `toState`, `actorType`, `actorId`, `reason`, `occurredAt`. Every transition, including rejected ones, is recorded.

**`consultation_access_tokens`** — TEMPORARY
`id`, `consultationId`, `tokenHash` UNIQUE, `sequence`, `issuedByUserId`, `expiresAt`, `consumedAt`, `revokedAt`, `createdAt`. The raw token exists only inside the QR image and is never stored, logged, or returned twice. Single use, expiring, invalidated on completion (spec §10).

**`patient_sessions`** — RETAINED UNDER SEAL
`id`, `consultationId` UNIQUE, `fullNameEnc`, `age`, `sex`, `phoneEnc`, `paymentPhoneEnc`, `deviceSessionTokenHash`, `deviceBoundAt`, `createdAt`, `purgedAt`.
Destroyed when the retention period expires, not at completion (D23). It has to survive completion for a second reason as well as the legal one: the patient reads their consultation reference off this session, and it is the only copy they get. Name, age, and sex are additionally **copied by value** onto any prescription or referral issued, so those documents outlive the destruction (spec §11).

**`consultation_clinical_notes`** — RETAINED UNDER SEAL
`id`, `consultationId` UNIQUE, `notesEnc`, `diagnosisEnc`, `treatmentEnc`, `updatedAt`. Sealed the instant the doctor completes — unreachable by any clinician, retrievable only through the four-eyes archive route (D27) — and hard-deleted when the retention period expires.

**`consultation_vitals`** — TEMPORARY
`id`, `consultationId`, `bpSystolic`, `bpDiastolic`, `pulseBpm`, `temperatureC`, `weightKg`, `spo2Percent`, `recordedByUserId`, `recordedAt`.

**`consultation_tests`** — TEMPORARY
`id`, `consultationId`, `testCode`, `resultText`, `recordedByUserId`, `recordedAt`. Free-typed results; no device integration (spec §50).

**`media_sessions`** — OPERATIONAL
`id`, `consultationId`, `provider`, `kind`, `providerRoomRef`, `providerCallRef`, `startedAt`, `endedAt`, `endReason`, `recordingEnabled` BOOLEAN NOT NULL DEFAULT FALSE with a CHECK constraint pinning it to false. Content is never touched; only connection metadata is stored (spec §32).

### 3.6 Queue — OPERATIONAL

**`consultation_queue_entries`** — `id`, `consultationId` UNIQUE, `languageId`, `state` ENUM(`WAITING`,`OFFERING`,`ASSIGNED`,`RESOLVED`,`ABANDONED`), `enqueuedAt`, `resolvedAt`, `offerAttempts`, `noMatchAlertedAt`, `priority`.

**`consultation_assignments`** — `id`, `consultationId`, `doctorId`, `offeredAt`, `respondByAt`, `acceptedAt`, `missedAt`, `result` ENUM(`PENDING`,`ACCEPTED`,`MISSED`,`WITHDRAWN`,`REASSIGNED`), `score`, `scoreBreakdown` JSON, `attemptNumber`. Retains why a doctor was chosen, which is what makes fairness auditable.

### 3.7 Prescriptions — PERMANENT

**`prescriptions`** — `id`, `publicId`, `verificationCode` UNIQUE, `consultationId` FK, `doctorId` FK, `pharmacyId` FK, `state` ENUM(`DRAFT`,`ISSUED`,`ACTIVE`,`PENDING_SUBSTITUTION`,`SUBSTITUTION_APPROVED`,`SUBSTITUTION_REJECTED`,`DISPENSED`,`REVOKED`), `patientName`, `patientAge`, `patientSex`, `patientRemark` NULL _(pending decision Q2)_, `issuedAt`, `dispensedAt`, `dispensedByUserId`, `revokedAt`, `revokedReason`, `revokedByDoctorId`, `signatureId` FK, `pdfStorageKey`, `currentVersion`, `isDemo`.
Patient identity is stored **by value**, not by reference — the source `patient_sessions` row is gone by then. A DB-level rule plus a service-layer guard prevent `DISPENSED → REVOKED` (spec §46, §82).

**`prescription_items`** — `id`, `prescriptionId` FK CASCADE, `version`, `medication`, `strength`, `form`, `dose`, `frequency`, `durationText`, `quantity`, `instructions`, `sortOrder`, `isActive`, `supersededByItemId` NULL.

**`prescription_versions`** — append-only. `id`, `prescriptionId`, `version`, `state`, `changedByType`, `changedById`, `reason`, `snapshot` JSON, `createdAt`. Nothing overwrites history (spec §47).

**`substitution_requests`** — `id`, `prescriptionId`, `prescriptionItemId`, `pharmacyId`, `requestedByUserId`, `proposedMedication`, `proposedStrength`, `proposedForm`, `reason`, `state` ENUM(`PENDING`,`APPROVED`,`REJECTED`,`WITHDRAWN`), `decidedByDoctorId`, `decidedAt`, `decisionNote`, `createdAt`.
Only a doctor transitions this out of `PENDING`; the pharmacy can never mutate `prescription_items` directly (spec §48, §104).

### 3.8 Referrals — PERMANENT

**`referrals`** — `id`, `publicId`, `consultationId`, `doctorId`, `pharmacyId`, `hospitalName`, `department`, `reasonText`, `urgency`, `patientName`, `patientAge`, `patientSex`, `signatureId`, `pdfStorageKey`, `issuedAt`, `isDemo`.
`reasonText` is clinical information the doctor deliberately commits to a permanent referral document — an explicit, doctor-authored exception, exactly as the prescription is.

### 3.9 Financial — PERMANENT

**`payments`** — `id`, `publicId`, `consultationId` FK NULL, `doctorSubscriptionId` FK NULL, `provider`, `providerReference` UNIQUE, `amountMinor`, `currency`, `status` ENUM(`PENDING`,`PROCESSING`,`SUCCESS`,`FAILED`,`ABANDONED`,`REVERSED`), `channel`, `paidAt`, `verifiedAt`, `idempotencyKey` UNIQUE, `failureReason`, `isDemo`.
CHECK: exactly one of `consultationId` / `doctorSubscriptionId` is set. **No card data, ever** (spec §63).

**`payment_webhook_events`** — `id`, `provider`, `providerEventId` UNIQUE, `eventType`, `signatureValid`, `payloadHash`, `receivedAt`, `processedAt`, `processingResult`, `error`. The UNIQUE constraint is the idempotency mechanism: a duplicate webhook fails to insert and is acknowledged without re-processing (spec §68, §103).

**`revenue_allocations`** — `id`, `consultationId`, `paymentId` UNIQUE, `grossMinor`, `discountMinor`, `netMinor`, `pharmacySharePctBp`, `pharmacyShareMinor`, `neemShareMinor`, `calculatedAt`, `settingsVersion`.
UNIQUE on `paymentId` makes double-counting structurally impossible. `pharmacyShareMinor + neemShareMinor = netMinor` is asserted in the transaction and in a unit test. The rate in force at calculation time is stored, so historical splits stay reproducible after an admin changes the setting.

**`refunds`** — `id`, `consultationId`, `paymentId`, `requestedByType`, `requestedByRef`, `reason`, `amountMinor`, `state` ENUM(`REQUESTED`,`APPROVED`,`REJECTED`,`PROCESSING`,`COMPLETED`,`FAILED`), `reviewedByAdminId`, `decidedAt`, `decisionNote`, `providerRefundRef` UNIQUE NULL, `completedAt`. Never auto-approved (spec §41).

**`pharmacy_payouts`** — `id`, `pharmacyId`, `periodStart`, `periodEnd`, `amountDueMinor`, `amountPaidMinor`, `status` ENUM(`PENDING`,`PROCESSING`,`PAID`,`FAILED`,`RECONCILED`), `paidAt`, `paymentReference`, `markedByAdminId`, `reconciledAt`, `note`. Manual during MVP; the service interface is shaped for automation later (spec §40).

**`promotions`** — `id`, `code` UNIQUE, `type` ENUM(`PERCENT`,`FIXED`), `valueBp`, `valueMinor`, `startsAt`, `endsAt`, `maxUses`, `usedCount`, `pharmacyId` NULL, `campaign`, `minAmountMinor`, `isActive`.

**`promotion_redemptions`** — `id`, `promotionId`, `consultationId` UNIQUE, `discountMinor`, `redeemedAt`. Validated server-side; a discount can never drive the net below zero (spec §42).

### 3.10 Feedback and quality — PERMANENT

**`feedback`** — `id`, `consultationId` UNIQUE, `doctorRating` 1–5, `neemRating` 1–5, `category` ENUM(`COMPLAINT`,`COMPLIMENT`,`SUGGESTION`), `comment`, `submittedAt`. Immutable once written; no pharmacy or doctor write path exists (spec §51).

**`complaint_categories`** — `id`, `code`, `label`, `isActive`, `sortOrder`.

**`complaints`** — `id`, `feedbackId` NULL, `consultationId` NULL, `categoryId`, `description`, `state` ENUM(`OPEN`,`UNDER_REVIEW`,`RESOLVED`,`DISMISSED`), `assignedAdminId`, `resolutionNote`, `resolvedAt`, `createdAt`.

### 3.11 Platform — OPERATIONAL

**`system_settings`** — `key` PK, `value` JSON, `valueType`, `description`, `category`, `updatedByAdminId`, `updatedAt`.
Seeded keys include `consultation.priceMinor`, `consultation.durationSeconds` (default 300), `consultation.paymentWindowSeconds` (300), `revenue.pharmacySharePctBp` (3000), `revenue.neemSharePctBp` (7000), `queue.responseWindowSeconds` (90), `queue.weights.*`, `quality.weights.*`, `doctor.membershipFeeMinor`, `doctor.maxServiceHoursPerWeek` (40).

**`system_setting_history`** — append-only: `key`, `oldValue`, `newValue`, `adminId`, `reason`, `changedAt`. Revenue and pricing changes require confirmation in the UI and land here (spec §96).

**`notification_templates`** — `id`, `code`, `channel`, `locale`, `subject`, `body`, `isActive`, `updatedByAdminId`.

**`notifications`** — `id`, `recipientType`, `recipientRef`, `channel`, `templateCode`, `renderedPayloadHash`, `status`, `providerRef`, `attempts`, `lastError`, `sentAt`, `deliveredAt`, `readAt`.
Stores a **hash**, not the rendered body, so notification history never becomes a shadow copy of clinical or personal data (spec §60).

**`audit_logs`** — append-only: `id`, `occurredAt`, `correlationId`, `actorType`, `actorId`, `action`, `entityType`, `entityId`, `ipHash`, `userAgent`, `metadata` JSON, `outcome`.
No INSERT-only enforcement exists in MySQL itself. What enforces it, precisely: the audit service exposes no update or delete method, no route reaches one, and a test asserts the metadata sanitiser. A dedicated `neem_audit` account holding `INSERT`+`SELECT` on this table and nothing else is created by `docker/mysql-init` and granted by `npm run db:grants`.

**That account is not the application's writer, and the distinction matters.** Audit rows are written on the same connection and inside the same transaction as the business change they record, so the entry and the thing it describes commit together or not at all. A second connection cannot join that transaction. Transactional audit was judged the better property; the consequence is that the application's own account can still reach this table, and the append-only guarantee in the running system rests on the service surface rather than on MySQL. The `neem_audit` account is for the operator and for anything reading the log out of band.

`metadata` is schema-restricted to non-clinical fields — the audit log must not become a back-door medical history (spec §61).

**`retention_jobs`** — `id`, `consultationId`, `scheduledFor`, `startedAt`, `completedAt`, `status`, `rowsPurged` JSON, `verifiedAt`, `error`. Proves deletion happened and lets §101 be demonstrated rather than asserted.

### 3.12 Pilot applications — OPERATIONAL

**`pilot_applications`** — `id`, `publicId` UNIQUE, `role` (`DOCTOR`/`PHARMACY`), `fullName`, `phone`, `email`, `specialty`, `yearsOfPractice`, `organisation`, `location`, `additionalInfo`, `status`, `statusNote`, `consentAt`, `sourceIp`, `createdAt`, `updatedAt`, `reviewedAt`, `reviewedByAdmin`, `isDemo`. UNIQUE on (`email`, `role`).

Expressions of interest submitted from the public marketing site, which is a separate application on a separate origin.

**A row here is a lead, not an account.** It has no foreign key to `users`, `doctors` or `pharmacies`, and deliberately so: most leads never convert, and joining them would leave half-built accounts behind for the ones that do not. When someone is actually onboarded, a real `doctors` or `pharmacies` row is created through the normal path and this row is marked `ONBOARDED` — a record that it happened, not a link.

**This is contact information about a professional, not a patient record.** Nothing clinical may be written here. `additionalInfo` is the one place someone might paste something else; it is capped and never treated as anything but a note.

Two columns are worth explaining:

- **`consentAt` is a timestamp, not a boolean.** Consent is the lawful basis for holding these details and for calling this person, and "did they agree" is a question that gets asked eighteen months later. A flag cannot answer it.
- **`sourceIp` exists to recognise a flood**, and nothing else. It is not returned by the list endpoint and does not appear on the admin screen.

The UNIQUE on (`email`, `role`) is what makes a resubmission an update. People submit twice on a slow connection; two rows means somebody is called twice, or the newer details are never seen.

---

## 4. Retention summary

**Revised by D23.** This table said "hard-deleted immediately" for everything clinical, because that was the design through Phase 5. Ghanaian law does not permit it. Completion now **seals** and schedules; destruction happens when the retention period expires.

| Class                       | Tables                                                                                                                                                               | Fate at consultation completion                                                                                                                                                            |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **SEALED, THEN DESTROYED**  | `patient_sessions`, `consultation_clinical_notes`, `consultation_vitals`, `consultation_tests`                                                                       | Sealed at completion and unreachable by any clinician; hard-deleted when `retention_jobs.scheduledFor` passes, with the row counts recorded                                                |
| **DESTROYED AT COMPLETION** | `consultation_access_tokens`                                                                                                                                         | Deleted immediately. A token is a credential, not a record: nothing about record-keeping requires keeping a key, and a live one would let a photographed QR reopen a finished consultation |
| **PERMANENT**               | `consultations`, `consultation_state_events`, `prescriptions` (+items/versions), `referrals`, `payments`, `revenue_allocations`, `refunds`, `feedback`, `audit_logs` | Retained                                                                                                                                                                                   |
| **OPERATIONAL**             | users, pharmacies, doctors, scheduling, settings, notifications, queue, `pilot_applications`                                                                         | Retained; subject to their own lifecycles                                                                                                                                                  |

Backups will transiently contain purged rows. That is stated plainly in `data-retention.md` rather than pretended away (spec §62).

---

## 5. Indexing and performance

Beyond the primary and unique keys: composite indexes on `consultations(pharmacyId, createdAt)`, `consultations(doctorId, createdAt)`, `consultations(state)`, `consultation_assignments(doctorId, offeredAt)`, `payments(status, paidAt)`, `audit_logs(entityType, entityId)`, `audit_logs(occurredAt)`, `notifications(status, createdAt)`.

All list endpoints paginate (cursor-based on `publicId` + `createdAt`) and filter server-side. Analytics run against pre-aggregated daily rollups rather than scanning the consultation table (spec §89).

## 6. Transactions

These must be single transactions, and each has a test that asserts atomicity: payment confirmation, consultation activation, doctor assignment, prescription state change, substitution approval, revenue calculation, refund processing, and shift assignment under the 40-hour rule (spec §65).
