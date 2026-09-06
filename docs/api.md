# API Design

**Status:** part design, part reference. REST/JSON over HTTPS. Base path `/api/v1`.

> **Reconciled against the router in Phase 10.** These sections were written in
> Phase 0 as a design and had never been checked against what shipped. A sweep
> found **31 paths that did not exist**. Most were provisional names the
> implementation moved past; eight named capabilities that were never built at
> all.
>
> Every listing below now matches a real route. The eight unbuilt ones are
> marked **NOT BUILT** where they stood rather than deleted — a capability that
> quietly disappears from a design reads as one nobody ever wanted, and two of
> these are absent on purpose and worth being able to point at.
>
> The router is the authority; `security.test.ts` enumerates it on every run.

---

## 1. Conventions

**Success**

```json
{ "data": {}, "meta": { "requestId": "01J...", "page": { "cursor": "…", "hasMore": true } } }
```

**Error**

```json
{
  "error": {
    "code": "INVALID_STATE_TRANSITION",
    "message": "Consultation cannot move from COMPLETED to IN_PROGRESS.",
    "details": [{ "field": "state", "issue": "…" }]
  },
  "meta": { "requestId": "01J..." }
}
```

- Machine-readable `code` first; `message` is human-facing and never leaks internals.
- All identifiers in requests and responses are `publicId`. Internal UUIDs never cross the boundary.
- Money is `{ "amountMinor": 4500, "currency": "GHS" }`. Never a formatted string, never a float.
- Timestamps are ISO 8601 UTC.
- Lists are cursor-paginated and filtered server-side.
- Every request carries a correlation id, echoed in `meta.requestId` and in logs.
- Validation is zod, shared with the web app through `packages/contracts`, so client and server cannot drift.

**Status codes:** `400` validation, `401` unauthenticated, `403` authorised principal lacking permission, `404` not found _or_ existence is itself sensitive, `409` state/uniqueness conflict, `422` business-rule violation, `429` rate limited, `503` provider unavailable.

---

## 2. Auth

```
POST   /auth/login                 { email, password }        → session or 2FA challenge
POST   /auth/2fa/verify            { challengeId, code }      → session
POST   /auth/2fa/enroll            first admin sign-in; returns the secret and recovery codes
POST   /auth/logout
GET    /auth/me                                               → principal, role, permissions
POST   /auth/password              { currentPassword, newPassword }
POST   /auth/password-reset/request
POST   /auth/password-reset/confirm
```

`POST /auth/password-reset/request` answers identically whether or not the
address has an account, and returns `deliveryConfigured` — whether a message
can actually be sent. That is a property of the deployment, not of the account,
and the screen needs it: there is no email adapter until Phase 8, so telling
someone to check an inbox would be a claim the system cannot honour (spec §93).

---

## 3. Patient (no account; device-bound session)

```
POST   /s/exchange                        { token } — one-time exchange → patient session
POST   /patient/session/identity          { fullName, age, sex, phone, paymentPhone? }
POST   /patient/session/language          { languageCode }
POST   /patient/session/mode              { type: AUDIO|VIDEO|CALL_ME }
GET    /patient/session                   status, doctor presence, timer
POST   /patient/consultation/media/join   → room + join credential (idempotent; rejoin after a drop)
POST   /patient/consultation/media/leave
GET    /patient/consultation/timer        elapsed / remaining / warning / overrun — advisory only
GET    /patient/complaint-categories      what a complaint may be about
POST   /patient/feedback                  { doctorRating, neemRating, category, complaintCategoryCode?, comment? }
POST   /patient/session/leave             ends the session on the server, not just the cookie
POST   /patient/refund-request            { reason } — recorded, never granted

NOT BUILT
GET    /patient/session/prescription      the prescription goes to the pharmacy, not the phone
GET    /patient/session/referral          same
```

**`POST`, not `GET`, on the exchange.** A GET is prefetched by scanners, chat
previews and mail clients, which would spend a single-use token before the
patient ever arrived.

**The two absent routes are absent on purpose.** A prescription reaches the
pharmacy the patient is already standing in. What the patient leaves with is
the consultation reference (D24) — their route back to their own record, and
deliberately not a copy of it on a device they may lose or hand over.

Every route is scoped to the single consultation bound to the session. No route accepts a consultation identifier from the client.

**The session outlives the consultation, for reading only.** It used to resolve
only while the consultation was live, which ended it at the instant of
completion — so the patient's phone received a 401 rather than the screen
carrying their consultation reference (D24), and there was no window in which
feedback could be given. Resolution now covers the terminal states as well;
every route that changes something asserts separately that the consultation is
still live, so a finished consultation cannot have its language or mode
rewritten.

`POST /patient/feedback` is accepted only once the consultation is COMPLETED,
once per consultation, enforced by a unique key rather than a read-then-write.
A `COMPLAINT` also opens a `complaints` row for an administrator. Nothing here
is ever returned to the doctor (spec §24, §52) — it reaches them only through
the nightly quality aggregate, which is admin-facing.

---

## 3a. Money (spec §38–§41)

```
POST   /pharmacy/consultations/:publicId/refund-request   asks on the patient's behalf
GET    /pharmacy/finance                                  this pharmacy's share only
GET    /admin/refunds                                     the decision queue
POST   /admin/refunds/:publicId/decide                    { approve, note } — the only path that returns money
GET    /admin/payouts
POST   /admin/payouts/calculate                           { periodStart, periodEnd }
POST   /admin/payouts/:publicId/mark-paid                 { paymentReference, note? }

GET    /doctor/membership                                 period, grace, what is owed
POST   /doctor/membership/payment                         returns a checkout; activates nothing
GET    /doctor/membership/payment/status                  asks the provider, then reports
GET    /doctor/earnings                                   this doctor's own figure
GET    /admin/payroll                                     every doctor's, calculated not paid

GET    /admin/promotions
POST   /admin/promotions                                  { code, type, valueBp|valueMinor, window }
POST   /admin/promotions/:code/deactivate                 withdraws; never deletes
```

**A membership fee is not a consultation fee.** It runs through the same
verification and the same idempotency, but activates no consultation and
creates no revenue allocation — no pharmacy has a share in it. Paying lifts a
suspension **only** when the doctor was suspended for non-payment; a suspension
an administrator imposed for any other reason survives the payment, and the
membership is still recorded as paid.

**Payroll is calculated and never paid.** There is no route that transfers a
salary or marks one sent, because the transfer happens outside Neem and
recording it here would imply otherwise (spec §26). A doctor with no contracted
hours is omitted from the run and counted separately, rather than assumed to be
full-time or silently treated as owed nothing.

**A promotion is withdrawn, never deleted.** Consultations reference it and the
discount they received has to stay explainable, so `deactivate` is a POST and
there is no DELETE.

**Nothing refunds automatically.** A patient or a pharmacy asks; an
administrator decides, with a reason required for either answer. Approving
calls the provider first and writes locally only if that succeeds, so the
ledger and the money cannot drift apart.

**Revenue is reversed, never deleted.** The allocation row stays and is stamped
`reversedAt`; payout calculation excludes reversed rows rather than netting
them off, so every figure still traces to the consultations behind it.

**Neem does not transfer payouts.** `mark-paid` records a transfer an
administrator has already made and demands a reference to trace it by (spec
§40). A payout already marked paid is frozen — recalculating its period leaves
it exactly as it was, because an amount someone has sent must not move
underneath them.

---

## 3b. Admin analytics, configuration and oversight (spec §54, §96, §100)

```
GET    /admin/analytics/operational | /financial | /satisfaction | /outcomes
GET    /admin/settings
PATCH  /admin/settings/:key                    { value, reason? } — reason required when sensitive
GET    /admin/settings/:key/history
GET    /admin/complaints
POST   /admin/complaints/:publicId/decide      { state, note } — note required to close
GET    /admin/quality                          scores and their breakdown
POST   /admin/quality/recompute
GET    /admin/audit-logs
GET    /admin/retention/health
POST   /admin/archived-consultations/retrieve  { consultationPublicId, purpose, reference, authorisedByUserPublicId }
GET    /admin/archived-consultations/retrievals
POST   /admin/archived-consultations/retrievals/:id/end
```

**Analytics never manufacture deleted clinical data.** No query in the module
touches a clinical record: every figure comes from the consultation row, the
queue entry, the assignment or the allocation. Where a figure could be affected
by destruction, its coverage travels with it, so a period whose records have
gone reports that fact rather than presenting a partial total as a whole one.

There is deliberately **no route reporting a diagnosis, a medication or a test
result**, in aggregate or otherwise — a "most common condition" chart is a
medical history with a bar chart on top (spec §13).

**A sensitive setting cannot be changed without a reason**, and which settings
are sensitive is a property of the setting rather than a list a screen keeps.
Every change writes the previous value to append-only history.

**A complaint is resolved or dismissed, never deleted**, and both require a
written outcome — a complaint closed with no explanation cannot be answered to
the person who raised it. Working one does not open the clinical record; a
complaint that genuinely needs it goes through archived retrieval, where it is
logged as an access.

**Archived retrieval is the narrow door counsel required (D27).** It is not a
search: the consultation reference must be known, the purpose named from a
fixed list, a request reference given, and a **different** administrator
recorded as authorising — self-authorisation is refused. There is no browse, no
consultation list and no patient search, because those would be the
longitudinal history D24 exists to prevent.

**A doctor never sees a quality score or a patient rating.** The whole area is
admin-only and a doctor principal is refused rather than filtered (spec §24,
§52).

---

## 4. Pharmacy

### Self-service and verification (spec §20)

```
GET    /pharmacy/profile                   status, documents, and what is still outstanding
POST   /pharmacy/documents                 multipart upload; magic-byte checked
GET    /pharmacy/documents/:id             streams the pharmacy own document
```

A pharmacy **cannot be activated with nothing verified** — the same rule that has always applied to doctors. `POST /admin/pharmacies/:publicId/status` refuses `ACTIVE` with 422 unless at least one document carries an administrator verification. `GET /admin/pharmacies/documents/:id` lets that administrator open the file first; without it the decision was made blind.

Neem performs no automated registration lookup, and no response here asserts a document is genuine (spec §78).

```
POST   /pharmacy/consultations                       create → PENDING_PAYMENT
POST   /pharmacy/consultations/:publicId/payment     initiate
GET    /pharmacy/consultations/:publicId/payment     authoritative; re-verifies with the provider
POST   /pharmacy/consultations/:publicId/payment/simulate   mock provider only; 404 otherwise
POST   /pharmacy/consultations/:publicId/qr          issue/reissue (audited) → data URL + link
GET    /pharmacy/consultations                       activeOnly filter, cursor-paged
GET    /pharmacy/consultations/:publicId             incl. temporary patient panel while active
POST   /pharmacy/consultations/:publicId/cancel
POST   /pharmacy/consultations/:publicId/refund-request
GET    /pharmacy/consultations/:publicId/observations
POST   /pharmacy/consultations/:publicId/vitals
POST   /pharmacy/consultations/:publicId/tests
GET    /pharmacy/prescriptions                       paginated
POST   /pharmacy/prescriptions/:publicId/substitutions      propose alternative
POST   /pharmacy/prescriptions/:publicId/dispense
GET    /documents/prescriptions/:publicId.pdf        the signed prescription
GET    /pharmacy/finance                             pharmacy share only — never gross Neem revenue
GET    /pharmacy/capabilities                        point-of-care capabilities, for the vitals form
GET    /pharmacy/profile
POST   /pharmacy/documents | GET /pharmacy/documents/:id
POST   /onboarding/pharmacy                          the public application form

NOT BUILT
POST   /pharmacy/consultations/:publicId/reassign-request   only an admin reallocates
GET    /pharmacy/referrals/:publicId/pdf             a referral is verified, never downloaded
```

---

## 5. Doctor

```
GET    /doctor/profile                               incl. status, licence, subscription, serviceHours
POST   /doctor/documents | GET /doctor/documents/:id
POST   /doctor/signature                             drawn signature capture
GET    /doctor/shifts | POST /doctor/shifts/:id/confirm
GET    /doctor/presence | POST /doctor/presence/online | /offline | /heartbeat
GET    /doctor/queue                                 current offer + countdown
POST   /doctor/consultations/:publicId/accept        (no decline endpoint exists)
GET    /doctor/consultations/:publicId               demographics, vitals, tests
GET    /doctor/consultations/:publicId/workspace     the clinical record while it is open
PUT    /doctor/consultations/:publicId/notes         temporary clinical workspace
POST   /doctor/consultations/:publicId/media/join    → room + join credential (joining starts it)
POST   /doctor/consultations/:publicId/media/leave
GET    /doctor/consultations/:publicId/timer         advisory; nothing here can end a consultation
POST   /doctor/consultations/:publicId/call          bridged voice — response carries no phone number
POST   /doctor/consultations/:publicId/complete      { outcome, … } — seals the record (D23)
POST   /doctor/consultations/:publicId/prescriptions draft
POST   /doctor/consultations/:publicId/referrals
POST   /doctor/consultations/:publicId/summary
POST   /doctor/prescriptions/:publicId/issue         signs it; generates the PDF
POST   /doctor/prescriptions/:publicId/revoke        blocked once DISPENSED
GET    /doctor/substitutions | POST /doctor/substitutions/:id/decide   { APPROVE | REJECT, note }
GET    /doctor/earnings
GET    /doctor/membership | POST /doctor/membership/payment | GET .../payment/status

NOT BUILT
GET    /doctor/consultations/history                 a doctor has no list of past consultations
```

No route returns a doctor's own ratings or quality score (spec §24, §52).

---

## 6. Admin

```
GET    /admin/doctors | GET /doctors/:publicId | POST /admin/doctors/:publicId/status
GET    /admin/doctors/:publicId/transitions          only the moves the machine permits
PATCH  /admin/doctors/:publicId/compensation
POST   /admin/doctors/:publicId/subscription
GET    /admin/doctors/documents/:id | POST /admin/doctors/documents/:id/verify
GET    /admin/doctors/licences/expiring
GET    /admin/pharmacies | :publicId | POST :publicId/status | GET :publicId/transitions
GET    /admin/pharmacies/documents/:id | POST /admin/pharmacies/documents/:id/verify
GET    /admin/queue     | POST /admin/queue/:publicId/reallocate
POST   /admin/shifts    | DELETE /admin/shifts/:id   enforces the 40h rule
GET    /admin/shifts/definitions | PATCH /admin/shifts/definitions/:code
GET    /admin/refunds   | POST /admin/refunds/:publicId/decide
GET    /admin/payouts   | POST /admin/payouts/calculate | POST /admin/payouts/:publicId/mark-paid
GET    /admin/payroll
GET    /admin/settings  | PATCH /admin/settings/:key | GET /admin/settings/:key/history
GET    /admin/promotions | POST | POST /admin/promotions/:code/deactivate
GET    /admin/notification-templates | PATCH /admin/notification-templates/:code/:channel
GET    /admin/complaints | POST /admin/complaints/:publicId/decide
GET    /admin/quality   | POST /admin/quality/recompute
GET    /admin/audit-logs                             filterable, read-only, cursor-paged
GET    /admin/system-health                          providers, demo mode, database

NOT BUILT
GET    /admin/dashboard/realtime                     live figures arrive over Socket.IO
GET    /admin/consultations                          deliberately absent — see below
GET    /admin/payments                               money is read through analytics/refunds/payouts
GET    /admin/reconciliation                         the sweep runs hourly into the audit log
GET    /admin/languages | POST | PATCH               the seeded six are all there are
```

**Those five absences are not all the same kind of thing**, and collapsing them
into one list would hide the difference. One is a design decision, one is a
gap, and one was never more than a line in this file.

`GET /admin/consultations` is not missing — it is refused by design. An
administrator who can list consultations can build the longitudinal patient
history D24 exists to prevent. Reaching one archived consultation takes a known
reference, a stated purpose and a second administrator (D27); there is no
browse, and adding one would undo the whole retrieval design.

`GET /admin/reconciliation` names a real capability that runs but cannot be
read as a report. `reconcilePayments` sweeps hourly and writes its findings to
the audit log, so payment drift is recorded and searchable by action — but
there is no screen that puts it in front of an administrator. That is a gap,
not a design decision, and it is listed here so it stays visible.

`GET /admin/languages` was listed from Phase 0 and no route was ever
registered. A language cannot be added or activated through the product: the
seeded six are what there are, and three of them are inactive.

**Health is split by audience, and the split is the point.** `/health` and
`/health/ready` are unauthenticated probes and say only whether this instance
can serve traffic. Until Phase 10 `/health/ready` also returned the
environment, the database latency, every configured provider by name, which of
them were mocked, and a `demoMode` flag — to anyone who asked. None of that is
needed to route traffic and all of it names the integrations worth attacking.
It lives at `/admin/system-health` now, where an administrator can see at a
glance whether this deployment can actually take money and send messages.

---

## 7. Public

```
GET    /verify/:code    prescription verification
```

Returns **only**: prescription id, issuing doctor name, issue date, status (`VALID` / `REVOKED` / `DISPENSED`). No patient name, age, sex, or medication (spec §44, §102). Rate-limited and non-enumerable — `verificationCode` is a high-entropy random string, not a sequence.

---

## 8. Webhooks

```
POST   /webhooks/payment      raw body, signature verified before parsing, idempotent

NOT BUILT
(none)                        Call Me has no provider, so there is no voice status
                              callback to receive. Whereby needs no webhook either —
                              Neem's state machine, not the video provider, decides
                              when a consultation is over (D35, D36)
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

---

## 10. Media (spec §32, §33)

**There is no recording endpoint, and there never will be one.** The absence is
structural rather than a matter of configuration: `VideoProvider` and
`VoiceProvider` expose no method that could start a recording, so no adapter
can be written against one, and `media_sessions.recordingEnabled` is written
only as `false`. An integration test greps the whole of `src/` for any call
that would ask a provider to record, and E2E asserts that the plausible route
names all 404 (decision D8).

### Joining

`POST /patient/consultation/media/join` and
`POST /doctor/consultations/:id/media/join` return:

| Field              | Meaning                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------- |
| `kind`             | `VIDEO`, `AUDIO`, or `VOICE_BRIDGE`                                                         |
| `providerRoomRef`  | The provider's room handle                                                                  |
| `joinToken`        | Credential for the provider's SDK; expires                                                  |
| `isMockProvider`   | **True today.** Surfaced on screen — the remote pane says media is simulated (decision D18) |
| `recordingEnabled` | Always `false`                                                                              |

Both are **idempotent**: rejoining after a reload or a dropped connection
returns the same room with a fresh credential, so a patient does not lose their
place. A doctor joining moves the consultation `DOCTOR_ACCEPTED → IN_PROGRESS`.

### The timer

`GET .../timer` reports `elapsedSeconds`, `remainingSeconds`, `warning`, and
`overrun`. It is **advisory in both directions**: there is no scheduled job and
no route that ends a consultation on time. Only the doctor completes one
(spec §15, §16). The `emit-timer-warnings` job emits notices and nothing else.

### Call Me

`POST /doctor/consultations/:id/call` bridges the two parties. Both numbers are
read server-side and handed to the provider; the response carries only
`callerIdShown`. Neither party's number appears in any payload either party can
reach — including the doctor's own clinical panel, which omits the patient's
number for exactly this reason (decision D19).

---

## 11. Archived Consultation Retrieval (spec §13, decisions D23, D24, D27)

**Admin only. There is no other door**, and nothing here accepts a patient name
or phone number.

```
POST /admin/archived-consultations/retrieve            one reference, one record
POST /admin/archived-consultations/retrievals/:id/end  records when access ended
GET  /admin/archived-consultations/retrievals          who opened what, and why
GET  /admin/retention/health                           records overdue for destruction
```

`retrieve` requires a consultation reference, a purpose from the closed list, a
case reference, and a **second active administrator** to authorise it — who may
not be the caller. The access log entry is written before the record is
returned; if that write fails, the retrieval does not happen.

POST rather than GET, because this constitutes a disclosure. It is an action,
not a lookup, and must never be something a browser performs by following a
link or prefetching.

**Deliberately absent:** any search, any list by patient, any endpoint
returning more than one consultation, any doctor or pharmacy route, and any
research purpose code (`data-retention.md` §4).

The retrievals listing returns who opened what and why — **never what it
said**. A screen rendering the records alongside would be the longitudinal
history by another route.

---

## 12. Clinical workflow (spec §41–§50, §82, decisions D13, D25)

Who may do what is the whole design here.

### Pharmacy — records observations, receives, dispenses

```
POST /pharmacy/consultations/:publicId/vitals       BP, pulse, temperature, weight, SpO₂
POST /pharmacy/consultations/:publicId/tests        point-of-care result, free text
GET  /pharmacy/consultations/:publicId/observations  read-back; observations only
GET  /pharmacy/prescriptions                        never returns a DRAFT
POST /pharmacy/prescriptions/:publicId/dispense     terminal and irreversible
POST /pharmacy/prescriptions/:publicId/substitutions  a proposal, not a change
```

The read-back exists so a pharmacist can see that a reading went in; without
it the natural response to doubt is to enter it twice. It returns vitals and
tests and never the doctor’s notes, which sit in the same guarded record. It
closes once the consultation is terminal, the recording pharmacy included
(D23).

**There is no route by which a pharmacy edits a prescription** (spec §47). It
proposes a substitution and the issuing doctor decides. Dispensing refuses
while a proposal is undecided, and refuses a revoked prescription outright.

### Doctor — writes, prescribes, refers, completes

```
GET  /doctor/consultations/:publicId/workspace      notes, vitals, tests for THIS consultation
PUT  /doctor/consultations/:publicId/notes
POST /doctor/consultations/:publicId/prescriptions  creates a DRAFT
POST /doctor/prescriptions/:publicId/issue          signs it; generates the PDF
POST /doctor/prescriptions/:publicId/revoke         refused once dispensed (spec §82)
GET  /doctor/substitutions                          proposals awaiting this doctor's decision
POST /doctor/substitutions/:id/decide               approve supersedes, never overwrites
POST /doctor/consultations/:publicId/referrals
POST /doctor/consultations/:publicId/summary        mandatory for advice-only (D25)
POST /doctor/consultations/:publicId/complete       the only completion path (spec §16)
```

A proposal blocks dispensing until it is answered, so `GET /doctor/substitutions`
is a work queue rather than a notification: a doctor who was offline when the
proposal arrived finds it waiting. It returns the doctor's own prescription and
the pharmacy's counter-proposal, and nothing from the clinical record.

**Deliberately absent:** any route that edits a prescription's items after
issue. A correction is a revocation plus a new prescription, so the trail
shows what actually happened.

`complete` validates everything before writing anything. It refuses an outcome
claiming a document that does not exist, refuses to complete over an unsigned
draft that would be stranded, and refuses `ADVICE_ONLY` without a summary. The
terminal transition seals the clinical record and schedules its destruction
(D23) — completion does not call sealing itself, which is the point of putting
it in `transition()`.

### Documents

```
GET /documents/prescriptions/:publicId.pdf   four permitted readers only (D13)
GET /verify/:kind/:code                      public; kind is rx | referral | summary
```

The PDF is generated **once, at issue**, and stored. Rendering per download
would let a template change silently alter a document already in a patient's
hands. Every download is audited.

The verification page is **unauthenticated by design** — a pharmacist or
hospital clerk holding a printout must be able to check it without an account
(spec §44). It returns only whether the document is genuine, who signed it, and
for a prescription whether it has been revoked or dispensed. **Never the
medication, the reason for referral, or the advice**: anyone who needs the
content is already holding it. The high-entropy code is the sole guard, so the
endpoint is rate limited against enumeration, and a DRAFT never verifies.
