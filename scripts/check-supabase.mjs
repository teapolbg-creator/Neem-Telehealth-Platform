/**
 * Confirms a Supabase project is ready to be this API's database.
 *
 *   node scripts/check-supabase.mjs
 *
 * Reads DIRECT_DATABASE_URL (or DATABASE_URL) and SUPABASE_ANON_KEY from the
 * environment. SUPABASE_URL is worked out from the connection string and only
 * needs setting if that fails. It never prints a connection string or a key —
 * only the host, which is not the secret part.
 *
 * Two questions, and the second is the one that is easy to skip:
 *
 *   1. Did the migration actually land? `prisma migrate deploy` printing "no
 *      pending migrations" means the same thing whether the database is up to
 *      date or Prisma was pointed at somewhere else that happens to be.
 *      Counting what is there tells them apart — the same reasoning, and the
 *      same bug, as `migrate-test-db.mjs`.
 *
 *   2. Is the schema reachable without going through the API? Supabase exposes
 *      tables in `public` through PostgREST, reachable with the anon key, and
 *      Row Level Security is what normally stands in front of that. Tables
 *      created by Prisma have no RLS. Neem's authorisation — sessions, RBAC,
 *      ownership checks — lives entirely in the application, and none of it is
 *      in front of PostgREST. So an exposed Data API is a route to
 *      `consultation_clinical_notes` that bypasses every guard the system has.
 *
 * Question 2 is asked of the database, not over HTTP, and that took three
 * attempts to get right. Probing the REST endpoint can only distinguish "the
 * Data API is off" from "that request failed" by reading status codes, and it
 * twice reported safety it had not established — once for a placeholder key's
 * 503, once for a rejected key's 401. The database has no such ambiguity:
 * `has_table_privilege('anon', ...)` is a fact.
 *
 * It is also the better question. Whether the Data API is switched on is a
 * toggle somebody can flip back; whether `anon` holds SELECT is a grant. If
 * the grants are gone the toggle stops mattering, because there is nothing
 * behind the door. Both are checked — grants, and PostgREST's own
 * `pgrst.db_schemas` setting — and the HTTP probe stays as corroboration that
 * cannot pass the run on its own.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadDotEnv } from './load-env.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** What the committed migrations create. Read from the SQL, not remembered. */
async function expectedCounts() {
  const { readFile, readdir } = await import('node:fs/promises');
  const dir = path.join(ROOT, 'apps', 'api', 'prisma', 'migrations');
  const names = (await readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  let tables = 0;
  let enums = 0;
  for (const name of names) {
    const sql = await readFile(path.join(dir, name, 'migration.sql'), 'utf8');
    tables += (sql.match(/^CREATE TABLE /gm) ?? []).length;
    enums += (sql.match(/^CREATE TYPE /gm) ?? []).length;
  }
  return { tables, enums, migrations: names.length };
}

/** First column of the first row, or null — including when the query is refused. */
async function scalar(prisma, sql) {
  try {
    const rows = await prisma.$queryRawUnsafe(sql);
    const row = rows[0];
    return row ? (Object.values(row)[0] ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * How many tables in `public` the named role may SELECT.
 *
 * Three outcomes, kept apart on purpose: `ok` with a count, `absent` when the
 * role does not exist, and `error` when the question could not be asked. On a
 * database that is not Supabase there is no `anon` at all, and reporting "0
 * tables readable by anon" there would be a reassurance about a role that was
 * never the risk — while an unanswerable query must not read as a zero either.
 *
 * The existence check is a separate statement because SQL does not promise to
 * short-circuit `AND`, and `has_table_privilege` on a role that does not exist
 * raises rather than returning false.
 */
export async function readableBy(one, role) {
  try {
    const exists = await one(`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = '${role}'`);
    if (exists === 0) return { state: 'absent' };

    const count = await one(
      'SELECT count(*)::int AS n FROM information_schema.tables t ' +
        "WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE' " +
        `AND has_table_privilege('${role}', ` +
        "quote_ident(t.table_schema) || '.' || quote_ident(t.table_name), 'SELECT')",
    );
    return { state: 'ok', count };
  } catch (error) {
    /*
     * Whether a role may inspect another role's privileges varies with who is
     * connected, and `pg_db_role_setting` is not readable everywhere either.
     * Losing this answer is acceptable; losing the four checks above it
     * because of it is not — an unreadable catalog would otherwise take the
     * whole run down and report nothing at all.
     */
    return { state: 'error', why: String(error?.message ?? error).split('\n')[0] };
  }
}

async function inspect(url) {
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  const one = async (sql) => Number((await prisma.$queryRawUnsafe(sql))[0]?.n ?? 0);

  try {
    return {
      tables: await one(
        "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' " +
          "AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations'",
      ),
      enums: await one(
        'SELECT count(*)::int AS n FROM pg_type t JOIN pg_namespace ns ON ns.oid = t.typnamespace ' +
          "WHERE t.typtype = 'e' AND ns.nspname = 'public'",
      ),
      applied: await one(
        'SELECT count(*)::int AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL ' +
          'AND rolled_back_at IS NULL',
      ),
      failed: await one(
        'SELECT count(*)::int AS n FROM _prisma_migrations WHERE finished_at IS NULL ' +
          'OR rolled_back_at IS NOT NULL',
      ),
      /*
       * A fresh production database has no accounts. This is here because the
       * plausible mistake is not a missing migration but an extra step:
       * copying the local database across, which carries the demo seed with
       * it. Demo doctors nobody remembers creating, who can be signed in as,
       * are worse than an empty schema — and invisible unless something looks.
       */
      users: await one('SELECT count(*)::int AS n FROM users'),

      /*
       * How many tables the PostgREST roles can actually read.
       *
       * This is the question the HTTP probe was trying to answer and kept
       * failing to: that probe can only distinguish "off" from "broken" by
       * guessing at status codes, and it reported a placeholder key's 503 as
       * safety. This asks Postgres instead, and Postgres does not have moods.
       *
       * It is also the better control of the two. "Is the Data API switched
       * on?" is a platform toggle somebody can flip back; "can `anon` read
       * this table?" is a grant, and if the answer is no then the toggle does
       * not matter — there is nothing behind the door. Supabase ships
       * `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon`, so tables
       * Prisma creates may well be granted without anyone choosing it.
       */
      anonReadable: await readableBy(one, 'anon'),
      authenticatedReadable: await readableBy(one, 'authenticated'),

      /*
       * Whether `anon` may enter the schema at all.
       *
       * This is the control the advice above leans on and the check did not
       * look at, which is its own kind of wrong: a script that recommends
       * REVOKE USAGE and then never verifies it is taking the fix on trust.
       *
       * It is also the durable half. Table grants can come back — default
       * privileges hand them out to whatever the next migration creates —
       * but `USAGE` on an existing schema is not covered by any default, so
       * once it is revoked it stays revoked. Without it no table grant in the
       * schema can be exercised, whatever else gets handed out later.
       *
       * Note that has_table_privilege above does NOT account for this: it
       * reads the table's own ACL. The two are genuinely separate facts and
       * both are worth having.
       */
      anonSchemaUsage: await scalar(
        prisma,
        "SELECT has_schema_privilege('anon', 'public', 'USAGE') AS v",
      ),
      authenticatedSchemaUsage: await scalar(
        prisma,
        "SELECT has_schema_privilege('authenticated', 'public', 'USAGE') AS v",
      ),

      /* Who Prisma connects as, and therefore who creates our tables. */
      currentRole: await scalar(prisma, 'SELECT current_user AS v'),

      /*
       * PostgREST's own configuration, which Supabase stores on the
       * `authenticator` role rather than in a file. When `public` is absent
       * from `pgrst.db_schemas`, the Data API is not exposing our schema —
       * read from the database rather than inferred from a status code.
       */
      restSchemas: await scalar(
        prisma,
        "SELECT (SELECT s FROM unnest(setconfig) AS s WHERE s LIKE 'pgrst.db_schemas=%') AS v " +
          'FROM pg_db_role_setting st JOIN pg_roles r ON r.oid = st.setrole ' +
          "WHERE r.rolname = 'authenticator'",
      ),

      /*
       * Which roles have standing instructions to grant `anon` on new tables.
       *
       * Revoking fixes the tables that exist. This is what decides whether the
       * problem comes back: `ALTER DEFAULT PRIVILEGES` is recorded per
       * creating role, so the next migration's tables are granted again unless
       * the default is removed for the role that owns it — and a REVOKE run
       * without `FOR ROLE` only touches the defaults of whoever runs it. The
       * failure is silent and arrives one migration later, which is the worst
       * moment to discover it.
       */
      defaultGrantors: await scalar(
        prisma,
        "SELECT string_agg(DISTINCT r.rolname, ', ') AS v " +
          'FROM pg_default_acl d ' +
          'JOIN pg_namespace n ON n.oid = d.defaclnamespace ' +
          'JOIN pg_roles r ON r.oid = d.defaclrole ' +
          "WHERE n.nspname = 'public' AND d.defaclobjtype = 'r' " +
          'AND EXISTS (SELECT 1 FROM unnest(d.defaclacl) a ' +
          'WHERE a::text ~ \'^"?(anon|authenticated)"?=\')',
      ),
    };
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * The project reference, dug out of the connection string.
 *
 * Supabase puts it in two places this script already has: the pooler user is
 * `postgres.<ref>`, and the direct host is `db.<ref>.supabase.co`. The project
 * URL is `https://<ref>.supabase.co`, so there is nothing to look up — which
 * matters because the dashboard page that displays it is the same page you go
 * to in order to switch the Data API off, and it is not obvious afterwards.
 */
export function projectRef(connectionString) {
  const url = new URL(connectionString);

  const direct = /^db\.([a-z0-9]+)\.supabase\.(co|com)$/.exec(url.hostname);
  if (direct) return direct[1];

  const pooled = /^postgres\.([a-z0-9]+)$/.exec(decodeURIComponent(url.username));
  if (pooled) return pooled[1];

  return null;
}

/**
 * Whether a key is worth sending at all.
 *
 * Written after a run that passed while SUPABASE_ANON_KEY held the literal
 * text `<anon or publishable key>`, copied straight out of an instruction. The
 * request went out, came back an error, and the error was read as good news.
 * A key that is obviously not a key should stop the check, not feed it.
 */
export function keyLooksReal(key) {
  if (!key) return { ok: false, why: 'it is not set' };
  if (/[<>]/.test(key))
    return { ok: false, why: 'it still contains < >, so it is placeholder text' };
  if (/\s/.test(key))
    return { ok: false, why: 'it contains whitespace — probably a stray newline' };
  if (key.length < 20) return { ok: false, why: `it is only ${key.length} characters` };
  return { ok: true };
}

async function request(target, key) {
  const response = await fetch(target, {
    headers: { apikey: key, authorization: `Bearer ${key}` },
  });
  return { status: response.status, body: (await response.text()).slice(0, 200) };
}

/**
 * Asks PostgREST for a clinical table, as an anonymous caller would, and asks
 * its root as well.
 *
 * The root probe is the control, and it is here because the first version had
 * no way to tell "the Data API is off" from "this request failed". It read any
 * non-200 as proof of safety, then reported a tick for an HTTP 503 produced by
 * a placeholder key — a false pass on the one check standing between an anon
 * key and `consultation_clinical_notes`.
 *
 * `/rest/v1/` answers 200 with the OpenAPI description when PostgREST is
 * serving this project. So:
 *
 *   * the table answers 200         -> exposed, and that is the bad one
 *   * the root answers 200          -> the Data API is live; this table is not
 *                                      exposed, but the API is, and the next
 *                                      table might be
 *   * 401 or 403                    -> the key was refused, which says nothing
 *                                      about what a good key would see
 *   * 404 everywhere                -> nothing is being served. Off.
 *   * anything else, 5xx especially -> unknown. A 503 is as likely to be a bad
 *                                      minute as a disabled API, and the two
 *                                      must not share an answer.
 */
export async function probeDataApi(supabaseUrl, anonKey) {
  const table = await request(
    new URL('/rest/v1/consultation_clinical_notes?select=*&limit=1', supabaseUrl),
    anonKey,
  );
  const root = await request(new URL('/rest/v1/', supabaseUrl), anonKey);
  const seen = `table HTTP ${table.status}, root HTTP ${root.status}`;

  if (table.status === 200) return { verdict: 'exposed', seen, body: table.body };
  if (root.status === 200) return { verdict: 'live', seen, body: root.body };
  if ([401, 403].includes(table.status) || [401, 403].includes(root.status)) {
    return { verdict: 'key-rejected', seen, body: table.body };
  }
  if (table.status === 404 && root.status === 404) {
    return { verdict: 'refused', seen, body: table.body };
  }
  return { verdict: 'unclear', seen, body: table.body };
}

async function main() {
  loadDotEnv();

  const url = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) {
    console.error('Set DIRECT_DATABASE_URL (or DATABASE_URL) to the Supabase connection string.');
    process.exit(1);
  }

  const expected = await expectedCounts();
  console.log(`Database: ${new URL(url).host}\n`); // host:port only, no credentials

  let actual;
  try {
    actual = await inspect(url);
  } catch (error) {
    /*
     * The first run is the one most likely to fail here, and Prisma's own
     * error is a stack trace with a connection string in it. Three causes
     * cover almost every case, and none of them is guessable from "P1001".
     */
    console.error(`✗ Could not connect to ${new URL(url).host}.\n`);
    console.error('  The usual causes, in the order they happen:\n');
    console.error(
      "    * The host is Supabase's DIRECT connection (db.PROJECT.supabase.co).\n" +
        '      That name resolves to IPv6 only without the IPv4 add-on. Use the\n' +
        '      Session pooler instead — port 5432 on the ...pooler.supabase.com host.\n' +
        '    * The password contains a character that needs URL-encoding (@ : / ? # &).\n' +
        '      It has to be percent-encoded inside a connection string.\n' +
        '    * ?sslmode=require is missing. Supabase will not accept a plaintext\n' +
        '      connection.\n',
    );
    /*
     * Prisma's message opens with blank lines and an "Invalid `prisma...`"
     * banner, so the first line is empty and taking [0] printed nothing at
     * all — a prompt to check the driver's message followed by no message.
     * Take the first line that says something, and drop the banner.
     */
    const detail = (error?.message ?? String(error))
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith('Invalid `'));
    console.error(`  What the driver said: ${detail ?? 'nothing useful.'}`);
    process.exit(1);
  }

  const problems = [];
  const line = (ok, text) => console.log(`  ${ok ? '✓' : '✗'} ${text}`);

  const tablesOk = actual.tables === expected.tables;
  line(tablesOk, `tables: ${actual.tables} (expected ${expected.tables})`);
  if (!tablesOk) {
    problems.push(
      actual.tables === 0
        ? 'No tables. The migration did not reach this database — check which URL Prisma used.'
        : `Table count does not match the committed migration (${actual.tables} vs ${expected.tables}).`,
    );
  }

  const enumsOk = actual.enums === expected.enums;
  line(enumsOk, `enums: ${actual.enums} (expected ${expected.enums})`);
  if (!enumsOk) problems.push('Enum count does not match the committed migration.');

  const migrationsOk = actual.applied === expected.migrations && actual.failed === 0;
  line(
    migrationsOk,
    `migrations: ${actual.applied} of ${expected.migrations} applied, ${actual.failed} failed or rolled back`,
  );
  if (!migrationsOk) problems.push('The migration history is incomplete or holds a failed entry.');

  const emptyOk = actual.users === 0;
  line(emptyOk, `user accounts: ${actual.users} (expected 0 on a fresh database)`);
  if (!emptyOk) {
    problems.push(
      `${actual.users} user accounts already exist. If this database was meant to be fresh, ` +
        'local data has been copied in — the demo seed included. Check before going further.',
    );
  }

  /*
   * The decisive one. Everything above is "is the schema right"; this is "can
   * anyone read it without going through the API", asked of the database
   * rather than of an HTTP status code.
   */
  const { anonReadable, authenticatedReadable } = actual;

  if (anonReadable.state === 'absent') {
    console.log('  — No `anon` role, so this is not a Supabase database. Nothing to check.');
  } else if (anonReadable.state === 'error') {
    line(false, `PostgREST roles: could not be checked — ${anonReadable.why}`);
    problems.push(
      'The grants held by `anon` could not be read, so the question this script exists to ' +
        'answer is open. Run it by hand in the SQL editor:\n' +
        "      SELECT has_table_privilege('anon', 'public.consultation_clinical_notes', 'SELECT');\n" +
        '    It must return false.',
    );
  } else {
    const anonCount = anonReadable.count;
    const authCount = authenticatedReadable.state === 'ok' ? authenticatedReadable.count : '?';
    const grantsOk = anonCount === 0 && authenticatedReadable.count === 0;
    line(
      grantsOk,
      `PostgREST roles: anon can read ${anonCount} tables, authenticated ${authCount} ` +
        `(expected 0 and 0)`,
    );
    if (!grantsOk) {
      problems.push(
        `The anon role can SELECT ${anonCount} of your tables. Whether that is reachable ` +
          'today depends entirely on the Data API toggle, which is a switch somebody can flip ' +
          'back — and clinical notes should not be one setting away from public. Revoke the ' +
          'grants as well, in the SQL editor:\n' +
          '      REVOKE USAGE ON SCHEMA public FROM anon, authenticated;\n' +
          '      REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;\n' +
          '      REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;\n' +
          '      REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;\n' +
          '    The first line is the decisive one: without USAGE on the schema, no grant on ' +
          'any table in it can be exercised. The API connects as postgres and is unaffected, ' +
          'because Neem uses neither PostgREST nor Supabase Auth — nothing of ours runs as ' +
          'anon or authenticated.',
      );
    }

    /*
     * Checked separately from the table grants because it is a separate fact —
     * has_table_privilege reads the table's ACL and knows nothing about
     * whether the role can enter the schema at all.
     */
    const usage = actual.anonSchemaUsage || actual.authenticatedSchemaUsage;
    if (actual.anonSchemaUsage === null) {
      console.log('  — schema USAGE could not be read.');
    } else {
      line(
        !usage,
        `schema USAGE on public: anon ${actual.anonSchemaUsage ? 'yes' : 'no'}, ` +
          `authenticated ${actual.authenticatedSchemaUsage ? 'yes' : 'no'} (expected no and no)`,
      );
      if (usage) {
        problems.push(
          'anon or authenticated can still enter the `public` schema, so any table grant ' +
            'handed out later — by a default privilege, or by hand — becomes readable ' +
            'immediately. This is the durable half of the fix, because no default privilege ' +
            'can restore USAGE on a schema that already exists:\n' +
            '      REVOKE USAGE ON SCHEMA public FROM anon, authenticated;',
        );
      }
    }

    if (actual.restSchemas) {
      const exposesPublic = /(^|=|,\s*)public(\s*,|$)/.test(actual.restSchemas);
      line(
        !exposesPublic,
        `PostgREST config: ${actual.restSchemas}${exposesPublic ? ' — public IS exposed' : ''}`,
      );
      if (exposesPublic) {
        problems.push(
          'PostgREST is configured to expose the `public` schema. Project Settings → API → ' +
            'Data API, and remove `public` from the exposed schemas.',
        );
      }
    } else {
      console.log('  — PostgREST schema configuration not set on the authenticator role.');
    }

    /*
     * Revoking fixes today. This decides whether tomorrow's migration undoes
     * it again, so it is reported even when the grants are currently clean.
     */
    const grantors = actual.defaultGrantors ? actual.defaultGrantors.split(', ') : [];
    const mine = grantors.filter((role) => role === actual.currentRole);
    const others = grantors.filter((role) => role !== actual.currentRole);

    line(
      mine.length === 0,
      `default privileges granting anon, for ${actual.currentRole ?? 'this role'}: ` +
        `${mine.length === 0 ? 'none' : mine.join(', ')}`,
    );
    if (mine.length > 0) {
      problems.push(
        `${actual.currentRole} carries default privileges granting anon on new tables in ` +
          '`public`. Migrations run as this role, so every table the next migration creates ' +
          'is granted again. Clear it:\n' +
          `      ALTER DEFAULT PRIVILEGES FOR ROLE ${actual.currentRole} IN SCHEMA public ` +
          'REVOKE ALL ON TABLES FROM anon, authenticated;',
      );
    }

    /*
     * Other roles' defaults are reported but do not fail the run, and the
     * distinction is not cosmetic. A default privilege applies to tables
     * created BY that role — `supabase_admin` creates Supabase's own objects,
     * not ours — and altering another role's defaults generally requires
     * membership in it, which the application role does not have. Failing on
     * something the operator cannot fix and does not need to teaches them to
     * ignore the whole check, which costs more than it saves.
     */
    if (others.length > 0) {
      console.log(
        `  — also set for [${others.join(', ')}], which covers only tables created by those\n` +
          '    roles, not ours. Altering them needs membership in the role and will likely be\n' +
          '    refused; that is expected, and schema USAGE above is what holds regardless.',
      );
    }
  }

  console.log('');

  const ref = projectRef(url);
  const supabaseUrl = process.env.SUPABASE_URL || (ref ? `https://${ref}.supabase.co` : null);
  const anonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl) {
    console.log(
      '  — Data API not checked: no SUPABASE_URL, and the project reference could not\n' +
        '    be read out of the connection string. Set SUPABASE_URL to test it.',
    );
  } else if (!keyLooksReal(anonKey).ok) {
    line(false, `Data API not checked: SUPABASE_ANON_KEY ${keyLooksReal(anonKey).why}.`);
    problems.push(
      `SUPABASE_ANON_KEY ${keyLooksReal(anonKey).why}, so the Data API was not tested. ` +
        'Unchecked is not the same as safe: PostgREST exposes tables in `public`, and ' +
        'these tables have no RLS. Take the key from Project Settings → API Keys.',
    );
  } else {
    const { verdict, seen, body } = await probeDataApi(supabaseUrl, anonKey);
    const TURN_OFF =
      'Turn it off: Project Settings → API → Data API, and remove `public` from the ' +
      'exposed schemas.';

    if (verdict === 'refused') {
      line(true, `Data API: not serving this project (${seen})`);
    } else if (verdict === 'exposed') {
      line(false, `Data API: consultation_clinical_notes is readable (${seen})`);
      console.log(`    body: ${body}`);
      problems.push(
        'The Data API returned 200 for a clinical table. It is reachable with the anon ' +
          'key, outside every check the API performs. An empty array is not safety — it ' +
          `means PostgREST is live and RLS filtered the rows. ${TURN_OFF}`,
      );
    } else if (verdict === 'live') {
      line(false, `Data API: live, though this table is not exposed (${seen})`);
      problems.push(
        'PostgREST answered its root, so the Data API is switched on. This one table is ' +
          'not exposed, but the API is, and nothing stops the next table from being ' +
          `reachable. ${TURN_OFF}`,
      );
    } else {
      /*
       * key-rejected and unclear both mean the same thing: this request did
       * not establish anything. They no longer fail the run, because the
       * grants check above answers the same question from the database and
       * does not depend on holding a working key. Printed, not silent — an
       * unanswered question should still be visible.
       */
      console.log(`  — Data API: no answer from HTTP (${seen}). The grants check above stands.`);
      console.log(`    body: ${body}`);
    }
  }

  console.log('');
  if (problems.length === 0) {
    console.log('Ready. The schema matches the committed migration, and nothing else can read it.');
    return;
  }
  for (const problem of problems) console.error(`✗ ${problem}`);
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
