# API Design

**Status:** Proposed (Phase 0). REST/JSON over HTTPS. Base path `/api/v1`.

---

## 1. Conventions

**Success**

```json
{ "data": { }, "meta": { "requestId": "01J...", "page": { "cursor": "…", "hasMore": true } } }
```

**Error**

```json
{ "error": { "code": "INVALID_STATE_TRANSITION",
             "message": "Consultation cannot move from COMPLETED to IN_PROGRESS.",
             "details": [ { "field": "state", "issue": "…" } ] },
  "meta": { "requestId": "01J..." } }
```

- Machine-readable `code` first; `message` is human-facing and never leaks internals.
- All identifiers in requests and responses are `publicId`. Internal UUIDs never cross the boundary.
- Money is `{ "amountMinor": 4500, "currency": "GHS" }`. Never a formatted string, never a float.
- Timestamps are ISO 8601 UTC.
- Lists are cursor-paginated and filtered server-side.
- Every request carries a correlation id, echoed in `meta.requestId` and in logs.
- Validation is zod, shared with the web app through `packages/contracts`, so client and server cannot drift.

**Status codes:** `400` validation, `401` unauthenticated, `403` authorised principal lacking permission, `404` not found *or* existence is itself sensitive, `409` state/uniqueness conflict, `422` business-rule violation, `429` rate limited, `503` provider unavailable.

---

## 2. Auth

```
POST   /auth/login                 { email, password }        → session or 2FA challenge
POST   /auth/login/2fa             { challengeId, code }      → session
POST   /auth/logout
GET    /auth/me                                               → principal, role, permissions
POST   /auth/password-reset/request
POST   /auth/password-reset/confirm
POST   /auth/2fa/enroll | /verify | /recovery-codes           (admin)
```

---

## 3. Patient (no account; device-bound session)

```
GET    /s/:token                          one-time token exchange → patient session
POST   /patient/session/identity          { fullName, age, sex, phone, paymentPhone? }
POST   /patient/session/language          { languageCode }
POST   /patient/session/mode              { type: AUDIO|VIDEO|CALL_ME }
GET    /patient/session                   status, doctor presence, timer
POST   /patient/session/join              → media credentials
POST   /patient/session/leave
GET    /patient/session/prescription      → metadata + PDF download
GET    /patient/session/referral
POST   /patient/session/feedback          { doctorRating, neemRating, category, comment? }
POST   /patient/session/refund-request    { reason }
```

Every route is scoped to the single consultation bound to the session. No route accepts a consultation identifier from the client.

---

## 4. Pharmacy

```
POST   /pharmacy/consultations                       create → PENDING_PAYMENT
POST   /pharmacy/consultations/:id/payment           initiate
GET    /pharmacy/consultations/:id/payment/status
POST   /pharmacy/consultations/:id/token             issue/reissue QR token (audited)
GET    /pharmacy/consultations/:id/qr                → PNG, no data encoded but the token URL
GET    /pharmacy/consultations                       filter by state/date, paginated
GET    /pharmacy/consultations/:id                   incl. temporary patient panel while active
POST   /pharmacy/consultations/:id/cancel
POST   /pharmacy/consultations/:id/reassign-request
POST   /pharmacy/consultations/:id/vitals
POST   /pharmacy/consultations/:id/tests
GET    /pharmacy/prescriptions                       paginated
GET    /pharmacy/prescriptions/:id
GET    /pharmacy/prescriptions/:id/pdf
POST   /pharmacy/prescriptions/:id/substitution      propose alternative
POST   /pharmacy/prescriptions/:id/dispense
GET    /pharmacy/referrals/:id/pdf
GET    /pharmacy/finance/summary                     pharmacy share only — never gross Neem revenue
GET    /pharmacy/finance/transactions
GET    /pharmacy/payouts
POST   /pharmacy/onboarding                          + document upload
```

---

## 5. Doctor

```
GET    /doctor/profile | PATCH /doctor/profile
POST   /doctor/onboarding/documents
POST   /doctor/onboarding/signature                  drawn signature capture
GET    /doctor/status                                credential, licence, subscription
GET    /doctor/shifts | POST /doctor/shifts/:id/confirm
GET    /doctor/service-hours                         weekly total vs the 40h ceiling
GET    /doctor/queue                                 current offer + countdown
POST   /doctor/consultations/:id/accept              (no decline endpoint exists)
GET    /doctor/consultations/:id                     demographics, vitals, tests
PUT    /doctor/consultations/:id/notes               temporary clinical workspace
POST   /doctor/consultations/:id/join                → media credentials
POST   /doctor/consultations/:id/call-me             bridged Twilio Voice call
POST   /doctor/consultations/:id/complete            { outcome, … } — triggers purge
POST   /doctor/prescriptions
POST   /doctor/prescriptions/:id/revoke              blocked once DISPENSED
POST   /doctor/prescriptions/:id/substitution/:sid/decide  { APPROVE | REJECT, note }
POST   /doctor/referrals
GET    /doctor/consultations/history                 operational only — no clinical history
GET    /doctor/earnings
```

No route returns a doctor's own ratings or quality score (spec §24, §52).

---

## 6. Admin

```
GET    /admin/dashboard/realtime | /daily | /trends
GET    /admin/doctors | :id | POST :id/review | /approve | /activate | /suspend | /reject
GET    /admin/doctors/:id/documents/:docId           authorised, audited download
POST   /admin/doctors/:id/shifts                     enforces the 40h rule
GET    /admin/pharmacies | :id | POST :id/approve | /activate | /suspend | /reject
GET    /admin/consultations | /queue | POST /admin/consultations/:id/assign
GET    /admin/payments | /refunds | POST /admin/refunds/:id/decide
GET    /admin/payouts   | POST /admin/payouts/:id/mark-paid
GET    /admin/reconciliation
GET    /admin/settings  | PATCH /admin/settings      confirmation + impact required on sensitive keys
GET    /admin/languages | POST | PATCH
GET    /admin/promotions | POST | PATCH
GET    /admin/notification-templates | PATCH
GET    /admin/complaints | :id | POST :id/resolve
GET    /admin/quality/doctors
GET    /admin/audit-logs                             filterable, read-only
GET    /admin/system/health
```

---

## 7. Public

```
GET    /verify/:code    prescription verification
```

Returns **only**: prescription id, issuing doctor name, issue date, status (`VALID` / `REVOKED` / `DISPENSED`). No patient name, age, sex, or medication (spec §44, §102). Rate-limited and non-enumerable — `verificationCode` is a high-entropy random string, not a sequence.

---

## 8. Webhooks

```
POST   /webhooks/paystack     raw body, signature verified before parsing, idempotent
POST   /webhooks/twilio       signature verified
```

Exempt from CSRF and session auth; authenticated by provider signature only. Duplicate delivery is absorbed by unique constraints (see `payment-flow.md` §3).

---

## 9. Real-time (Socket.IO)

Handshake authenticated with the same session cookie. Server → client events carry ids and states only; authorised detail is fetched over REST.

```
consultation.state_changed · consultation.participant_joined | left
consultation.timer_warning · queue.offer | offer_expired | position_changed
prescription.issued | revoked | dispensed
substitution.requested | decided
referral.issued
admin.alert   (no_language_match · queue_delay · payment_anomaly ·
               refund_requested · complaint · licence_expiry ·
               subscription_expiry · system)
```
