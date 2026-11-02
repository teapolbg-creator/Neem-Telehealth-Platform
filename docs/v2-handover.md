# Neem V2 (CHPS): engineering handover

**Read this first.** It covers what V2 is, how to run it, and what is left to connect.
For the reasoning behind a decision, see [`decision-log.md`](decision-log.md), where
D73 to D95 are the V2 entries. For V1 (the pharmacy channel) and the deep background,
see [`engineering-handover.md`](engineering-handover.md).

## Where things stand

V2 is **complete as a local build, with no outside service connected**. All of it is
on the `v2-chps` branch. It has **never been deployed**, and **no live video call has
ever been made on it**. `main` is V1, syncs to Lovable and runs the live pilot, so
treat merging as a release (see [Merging to main](#merging-to-main)).

| Check                           | Result on the last run                        |
| ------------------------------- | --------------------------------------------- |
| API tests (`npm test`)          | All pass, against real PostgreSQL             |
| Browser tests (`test:e2e`)      | All pass except 3 skipped, against mock video |
| Fresh database (`npm run demo`) | Migrates and seeds from empty                 |

The 3 skipped browser tests are admin 2FA enrolment (needs a freshly seeded admin),
Call Me (no phone provider exists) and membership expiry (covered by the API tests
with a fixed clock).

## Run it

You need Node 22 or later and Docker Desktop.

```bash
npm run demo
```

That starts the databases, migrates, seeds the demo data and runs the app with every
outside service mocked, whatever `.env` says. It prints the demo accounts. The app is
at <http://localhost:8080> and the consultation station at `/station`.

```bash
npm test
```

```bash
npm run test:e2e
```

**Run the browser tests against an API with everything mocked.** Playwright's mock
settings do not reach a server it reuses, and `.env` may name a real SMS provider. The
CHPS tests stop if messages are not mocked; the older tests do not check. `npm run
demo` is a safe way to have one running. The tests also add "E2E" facilities to the
local database.

## What V2 is

Five interfaces on the existing monorepo (Fastify, Prisma, PostgreSQL, TanStack
Start). See [`v2-chps-plan.md`](v2-chps-plan.md) for the slices.

| Interface            | Route       | Role                     |
| -------------------- | ----------- | ------------------------ |
| CHPS facility        | `/facility` | `FACILITY` (the CHO)     |
| Doctor               | `/doctor`   | `DOCTOR`                 |
| Consultation station | `/station`  | A paired device, no user |
| Neem administration  | `/admin`    | `ADMIN`, `OPS_ADMIN`     |
| District             | `/district` | `DISTRICT`, read only    |

The pharmacy and patient-direct channels still exist alongside it. Nothing was removed.

## What is left to connect

Each provider has an adapter behind an interface, selected by an environment variable,
and the API refuses to start in production on a mock. A `*:check` script tests each
real credential without using the rest of the app.

| Service      | State                          | What to do                                                                                                           | Check                           |
| ------------ | ------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| **Video**    | Adapter built, never run on V2 | `VIDEO_PROVIDER=whereby`, `WHEREBY_API_KEY`, `WHEREBY_WEBHOOK_SECRET`. Then do the [tablet test](#first-real-call)   | `npm run whereby:check`         |
| **SMS**      | Adapters built, off            | Choose a provider, then `SMS_PROVIDER=arkesel` or `hubtel` with its keys. D46 keeps SMS off until then               | `arkesel:check`, `hubtel:check` |
| **Email**    | Adapter built                  | `EMAIL_PROVIDER=smtp` and the `SMTP_*` values                                                                        | `npm run smtp:check`            |
| **Payments** | Adapter built                  | Paystack, for V1 only. CHPS consultations are free and never touch it (D74)                                          | none                            |
| **Hosting**  | Config in the repo             | API on Render (`render.yaml`), web on Netlify (`netlify.toml`), database on Supabase. See [`staging.md`](staging.md) | `/api/v1/health/ready`          |

**Three of these need more than keys:**

1. **Phone calls have no provider.** `VOICE_PROVIDER` only accepts `none` in production:
   Twilio was removed (D36) and nothing replaced it. This affects V1's "Call Me", where
   a doctor rings a patient's phone. CHPS audio-only calls run through Whereby and do
   not need it. A telephone bridge means writing an adapter.
2. **WhatsApp is only a mock.** No real adapter exists.
3. **File storage is local disk.** `STORAGE_DRIVER=s3` is accepted by the config and has
   no adapter. Visit files and prescriptions are permanent records, which is why
   `render.yaml` attaches a disk and allows only one API instance.

**DHIMS2 is not integrated, and nothing may say it is.** An empty adapter is at
`apps/api/src/adapters/reporting/`, and `reportIndicators()` names the report's figures.
Connecting it needs Ghana Health Service's approval, data elements and test access (D94).

CHPS notifications are in-app (D92). They do not send SMS yet. Adding that means adding
templates in `modules/notification/templates.ts` and calling `notify()` where
`publishFeedEvent()` is called.

## First real call

This is the other half of the Phase 1 milestone and has never been done. You need a
tablet for the station, a second device for the doctor, a CHO on a third screen, and
ideally a phone hotspot. It creates real Whereby rooms.

- [ ] The station joins by itself when the doctor accepts, and both sides see and hear
- [ ] Low-data mode (the checkbox under Consultation stations): is the picture good enough?
- [ ] Audio only: the camera stays off on both sides
- [ ] Turn off the station's Wi-Fi mid-call: it shows as interrupted, both sides can
      rejoin, and the notes are still there
- [ ] The tablet's camera and microphone work in kiosk mode ([`station-setup.md`](station-setup.md))
- [ ] After completion, the station returns to the welcome screen with nothing left on it
- [ ] Monitoring shows the station's line and device, as real figures

## Merging to main

`main` syncs to Lovable and runs the live pilot. **Do not rewrite pushed history**
(`AGENTS.md`).

1. Try `v2-chps` on staging first ([`staging.md`](staging.md)).
2. The branch adds about 20 database migrations. All are additive, but `render.yaml`
   runs `migrate deploy` before each deploy, so back up first ([`launch-runbook.md`](launch-runbook.md)).
3. Check the live pharmacy flow after deploying. The queue changed: **a doctor now holds
   one open offer at a time** (D91), which applies to the pharmacy channel too.
4. Existing pilot behaviour is otherwise untouched, and CHPS is off until a facility is
   registered and activated.

Two fixes on this branch would also help the pilot, and could go to `main` on their own:
the one-open-offer fix, and the refunds list showing newest decisions (both in D91).

## Before any clinical use

These are not engineering tasks, and the product must not imply they are done.

- [ ] **Clinical protocol.** Which approved triage protocol, and who enters it. The
      table ships empty (D93), and nothing flags until someone does.
- [ ] **Data protection.** Registration and review under Act 843, and of telemedicine
      guidance. Nothing in the product says Neem is approved by GHS, the MDC or the
      Data Protection Commission, and nothing should until it is.
- [ ] **Regions and districts.** Seeded from a public list (D74). Confirm against the
      official one, and add sub-districts.
- [ ] **Doctors.** Salaried by government (D74), so CHPS consultations record no fee.
      The rota and shifts must exist, or requests are refused as "no doctor on duty".

## Known limits

- **Offline.** New walk-ins and their triage only, on a page that has already loaded
  since sign-in. No service worker, so the app cannot open with no connection (D88).
- **Doctor capacity.** One API instance only: background jobs and Socket.IO live in
  the process (`render.yaml`).
- **Duplicates.** Compared by phone, NHIS number and name words, within a facility.
  Patients are per facility, with no national identity.
- **Reports.** Presenting complaints are listed as written, never counted, until
  someone supplies a category list (D79).
- **Station connection figures** measure the line to Neem's server, not to Whereby (D89).
- **Secrets.** `.env.example` holds development placeholders, and production refuses
  them. Generate real ones. The demo passwords are public, and demo data is refused
  outside a local database (D52).

## Where things are

| Looking for               | Go to                                                                  |
| ------------------------- | ---------------------------------------------------------------------- |
| Every route               | [`api.md`](api.md); a test fails if one is missing                     |
| Why something is as it is | [`decision-log.md`](decision-log.md)                                   |
| Tables and retention      | [`database.md`](database.md), [`data-retention.md`](data-retention.md) |
| Roles and permissions     | `packages/contracts/src/permissions.ts`, [`security.md`](security.md)  |
| CHPS back end             | `apps/api/src/modules/facility/`                                       |
| Doctor's CHPS screens     | `apps/web/src/features/chps/`                                          |
| Offline queue             | `apps/web/src/features/offline/`                                       |
| Demo data                 | `apps/api/prisma/seed/demo-chps.ts`                                    |
| End-to-end scenarios      | `e2e/chps.spec.ts`                                                     |
| Showing it to people      | [`presentation-script.md`](presentation-script.md)                     |
