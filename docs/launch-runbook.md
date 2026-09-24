# Launch runbook — putting the counter and patient-direct systems together

Written 2026-09-24. This is the order in which v1 (a consultation started by a
pharmacy) and v2 (a patient booking for themselves) become one live system, and
what each step does to people who are already using Neem.

Nothing here happens on its own. Every step is a deliberate act by the operator,
and the stages are separated so that each can be judged, and undone, on its own.

## What is already true

- **One codebase, one database, one queue.** v2 is not a separate product: it is
  the same platform with a second way in. The `staging` branch carries both and
  has been exercised end to end; `main` is what production runs.
- **Every v2 behaviour is behind a switch**, and every switch is off in
  production: patient booking (`channels.directEnabled`) and professional
  earnings (`revenue.professionalEarningsEnabled`). The counter pay cut-over
  (`revenue.counterShareFrom`) is dated 2026-09-01, so shares apply from the
  moment earnings are switched on rather than from a future date (D55).
- **Prices and shares are stored settings**, not code. A deploy never changes
  them.

## Before anything reaches production

The staging walkthrough is the gate. All of it, on `app.staging`:

1. A dietitian registers, uploads CV, AHPC licence and government ID, captures a
   signature, and is activated by an administrator.
2. They are given clinic services (Admin → Verification) and bookable hours.
3. A patient books and pays with Paystack **test** money, once with "Book now"
   and once with "Choose a time".
4. A consultation is completed, and **My care** shows what was issued.
5. Admin → Professional pay calculates the period and records a payout as sent.

If any of that fails, it fails on staging, where it costs nothing.

## Stage A — the code, with every switch still off

**What it does.** Puts 22 commits and 12 migrations onto production. The
migrations add tables and columns and relax three `NOT NULL` constraints;
nothing is dropped, renamed or rewritten, and v1's data is untouched.

**What changes for people using Neem that day.** Effectively nothing. Patient
booking stays off, earnings stay off, the counter price stays at what production
has stored, pharmacy payouts are calculated exactly as before, and pharmacy
staff see small wording changes.

**Before merging**, read two settings in the production admin console:

| Setting                     | If it exists                       | If it is missing                                                        |
| --------------------------- | ---------------------------------- | ----------------------------------------------------------------------- |
| `doctor.membershipRequired` | Nothing to do — your value is kept | The code default is now **on**; see the membership stage before seeding |
| `doctor.membershipFeeMinor` | Nothing to do — your value is kept | The code default is now **500** (GH₵5)                                  |

A setting an administrator has set is never overwritten, by a deploy or by a
seed. A setting that has never existed is created from the code default the
first time the seed runs, which is why the two above are worth checking.

**Steps.**

1. Merge `staging` into `main` and push. Render redeploys `neem-api` from
   `main`, running `npm run db:deploy --workspace @neem/api` before the new
   version starts; Netlify redeploys the production site.
2. Watch Render until the deploy is **Live**. Brief 502s during the switch-over
   are normal.
3. Check `https://api.neemtelehealth.com/api/v1/health/ready` answers 200.
4. Run a real counter consultation end to end: create it, pay, see a doctor,
   issue a prescription. This is the check that matters — v1 must be exactly as
   it was.
5. **Seed the new reference data** (the v2 service catalogue and any missing
   settings rows) with the production `DATABASE_URL`:

   ```bash
   npm run db:seed --workspace @neem/api
   ```

   It creates what is missing and overwrites nothing. Demo accounts are refused
   on a remote database.

**Rollback.** Redeploy the previous commit in Render. The migrations stay —
they are additive, and v1 does not read the new columns.

## Stage B — the money, as soon as people have been told (D55)

One commercial decision, applied together rather than on a future date:

| Setting                               | To           | Meaning                                               |
| ------------------------------------- | ------------ | ----------------------------------------------------- |
| `consultation.priceMinor`             | `5000`       | A counter consultation costs GH₵50                    |
| `revenue.pharmacySharePctBp`          | `2000`       | The pharmacy keeps 20% of what the patient paid       |
| `revenue.neemSharePctBp`              | `8000`       | The complement; Neem's pool before the professional's |
| `revenue.professionalSharePctBp`      | `5000`       | The professional takes 50% after the provider's fee   |
| `revenue.counterShareFrom`            | `2026-09-01` | Counter consultations earn a share from September     |
| `revenue.professionalEarningsEnabled` | on           | Earnings are recorded at all                          |

On GH₵50 with a GH₵1 provider fee: pharmacy GH₵10, professional GH₵24.50, Neem
GH₵14.50 at a counter, and professional GH₵24.50, Neem GH₵24.50 online. The
professional is paid the same either way; the pharmacy's share comes out of
Neem's.

**Order matters.** Set the share and the price before switching earnings on.
Nothing is recorded for anybody while earnings are off, and a consultation that
completes in that window earns its professional nothing, retrospectively or
otherwise.

**Before it, not after:**

- Tell every pharmacy the price becomes GH₵50 and their share stays 20% of what
  the patient pays — GH₵10 a consultation, against GH₵9 today.
- Tell every counter doctor that **September is paid by share, not salary**, and
  what that means for a quiet month. This is the change that costs somebody
  money, and it should not arrive as a surprise in a payslip.

**Verification.** Complete one counter consultation and check Admin → Payouts
shows GH₵10 to the pharmacy, and Admin → Professional pay shows the doctor's
GH₵24.50.

**Rollback.** Set the settings back. Consultations already booked keep the price
they were booked at, and earnings already recorded stand — a rollback changes
what happens next, not what was earned.

## Stage C — membership at GH₵5 (D54)

In this order, or the first professional to renew is charged the old fee:

1. With the production `DATABASE_URL`:

   ```bash
   npm run membership:grant --workspace @neem/api -- --dry-run
   ```

   then the same without `--dry-run`. Every professional is given a free period
   to the end of the following month, recorded in the audit log as a grant of
   zero.

2. Set `doctor.membershipFeeMinor` to `500`.
3. Set `doctor.membershipRequired` to on.
4. Reinstate, by hand, anyone suspended earlier for a lapsed membership. The
   grant deliberately changes nobody's status.

## Stage D — patient booking on

**What it does.** `/book` starts working, and Neem begins taking patients who
have never been to a pharmacy.

1. Set `channels.directEnabled` to on.
2. Check Admin → Services: the general consultation at GH₵50, the three
   weight-loss services at GH₵100, and each one switched on or off deliberately.
3. Have at least one professional per offered service, each with bookable hours.
   A service nobody delivers is a service that takes money and finds nobody.
4. Confirm Paystack's **live** webhook points at production.
5. Book one consultation as a patient, with real money, and complete it. Refund
   it afterwards if you would rather not keep the charge.
6. Publish the "Book a consultation" button on the marketing site, which is a
   separate repository. Until it is published, `/book` is reachable only by
   typing the address and from the sign-in page.

**Rollback.** Set `channels.directEnabled` off. Bookings already paid for are
honoured; the page stops taking new ones.

## What is still open at launch

These are decisions, not defects, and they are worth taking before v2 is public
rather than after the first patient asks:

- **Cancellation, rescheduling and no-shows** for booked appointments: what a
  patient gets back if they cancel, and what happens if the professional does
  not appear. There is no policy in the system today.
- **Weight-loss prices** are GH₵100 for the doctor, the dietitian and the
  trainer alike.
- **Refunds for patient-direct bookings** use machinery written for a counter,
  where staff are part of the decision.
- **Prescriptions from an online consultation** go to the patient, who may take
  them to any pharmacy. No pharmacy is notified, and no substitution can be
  proposed.
