# Staging

A second, complete Neem — API, app and database — that runs the code before production does and
cannot touch anything real. It is where v2 is exercised against Paystack test mode before any of it
reaches a patient (v2 plan §9).

## What makes it safe, and who enforces it

The API refuses to boot as staging unless every one of these holds. They are checked by the config
loader when `DEPLOY_ENV=staging`, not left to whoever copies the settings.

| Rule                                       | Why                                                                                                                              |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Paystack `sk_test_` / `pk_test_` keys only | Test and live keys differ only by prefix. On live keys every test booking charges a real account.                                |
| `STAGING_EMAIL_REDIRECT` set               | Staging is a production build, which refuses the mock, so it sends real email. Every message goes to that one inbox instead.     |
| `SMS_PROVIDER=none`                        | A text message cannot be redirected.                                                                                             |
| A `CSRF_COOKIE_NAME` of its own            | Production sets its CSRF cookie on the whole parent domain (D47); sharing the name, staging refuses signed-in changes at random. |

Production is guarded the other way: it refuses a `sk_test_` key (it would take no money while
activating consultations as paid) and refuses `STAGING_EMAIL_REDIRECT` (it would swallow every doctor
offer). Production needs no new settings — an unset `DEPLOY_ENV` on a production build is
production.

Separately, the demo-data guard (D52) refuses demo seeding on any database that is not local, so
staging starts empty of fake people, as production does.

## Setting it up

Everything below happens in your accounts and none of it has been done. Each step is outward-facing
— it creates a service, a record or a branch other people can reach — so it is yours to take.

1. **Database.** Create a second Supabase project in the same region as production (Frankfurt). Note
   its transaction-pooler and session-pooler connection strings; `render.yaml` explains which host
   and port each needs. Never point staging at production's project.

2. **Branch.** Create a `staging` branch from `main` and push it. Staging deploys from that branch, so
   v2 can live there without being on `main`, which is what production deploys.

3. **API.** In Render, create a new Blueprint from this repository and give it the path
   `render.staging.yaml`. When prompted, enter:
   - the two staging database URLs;
   - **new** `SESSION_SECRET`, `CSRF_SECRET` and `ENCRYPTION_KEY` — not copies of production's;
   - the Paystack **test** secret and public keys;
   - `WHEREBY_API_KEY` and `SMTP_PASSWORD`;
   - `STAGING_EMAIL_REDIRECT` — one inbox you read, e.g. a `staging@` alias.

   The first deploy runs every migration against the staging database. This is the first time the v2
   migrations run anywhere but a laptop; production's database is untouched by it.

4. **App.** In Netlify, add a second site from the same repository on the `staging` branch, with the
   same build settings as production (they come from `netlify.toml`). Set two environment variables
   in the Netlify UI:

   ```
   VITE_API_URL          = https://api.staging.neemtelehealth.com
   VITE_CSRF_COOKIE_NAME = neem_staging_csrf
   ```

   The second must match `CSRF_COOKIE_NAME` on the staging API, or every signed-in change is refused.

5. **DNS.** Point `app.staging.neemtelehealth.com` at the Netlify site and
   `api.staging.neemtelehealth.com` at the Render service. Both sit under `staging.`, which is the
   staging cookie domain.

6. **Paystack.** In the Paystack dashboard, in **test** mode, set the webhook URL to
   `https://api.staging.neemtelehealth.com/api/v1/webhooks/payment`. The live-mode webhook stays as it
   is.

7. **Reference data and an administrator.** With `DATABASE_URL` pointing at the staging database,
   run the reference-data seed (settings, languages, shifts, the service catalogue) and create an
   administrator:

   ```bash
   npm run db:seed
   ```

   ```bash
   npm run admin:create
   ```

   Demo accounts will not be created — the seed refuses them on a remote database. Professionals are
   onboarded through the real flows, which is the point: a dietitian registers, is approved, and is
   given their discipline and clinic with `PATCH /admin/doctors/:publicId/profession`.

8. **Switch v2 on — on staging only.** In the staging admin console, set `channels.directEnabled` to
   on. To exercise earnings, set `revenue.professionalEarningsEnabled` on as well (the 50% share is
   already the default). Production's switches stay off.

## Checking it

Before trusting staging with a test run:

- `https://api.staging.neemtelehealth.com/api/v1/health/ready` answers 200.
- A patient booking reaches Paystack's **test** checkout — the page says test mode — and a test card
  or test mobile-money number completes it.
- The sign-in code arrives in the `STAGING_EMAIL_REDIRECT` inbox with `[staging → …]` in its subject,
  and nowhere else.
- Signing in and then changing something (signing out is enough) works in a browser that has also
  used production.

## Moving a change from staging to production

Staging proving a change is not authorisation to ship it. Merging to `main` deploys production and
runs its migrations; that stays a decision made explicitly, each time.
