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
 * On question 2, HTTP 200 is a failure whatever the body says. An empty array
 * means the API answered and RLS filtered the rows: PostgREST is still live,
 * and one table gaining a permissive policy later is enough. This wants the
 * request refused, not answered politely.
 *
 * Only a refusal passes, and only an unambiguous one. A rejected key, a 5xx,
 * anything that merely failed — none of them say the Data API is off, they say
 * this request did not work, and the difference is the whole point of asking.
 * Everything short of a clear "nothing is served here" is reported as unknown
 * and fails the run, because on this question a wrong pass is worse than a
 * wrong failure.
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
    } else if (verdict === 'key-rejected') {
      line(false, `Data API: the key was refused, so nothing was established (${seen})`);
      console.log(`    body: ${body}`);
      problems.push(
        'The anon key was rejected, which says nothing about what a good key would see. ' +
          'Check it in Project Settings → API Keys and run again.',
      );
    } else {
      line(false, `Data API: no clear answer (${seen})`);
      console.log(`    body: ${body}`);
      problems.push(
        `The Data API answered ${seen}, which does not settle the question. A 5xx is as ` +
          'likely to be a bad minute as a disabled API, and treating the two alike is how ' +
          'a live API gets a tick. Run it again in a few minutes; if it stays, confirm in ' +
          'the dashboard that the Data API is off rather than assuming it from this.',
      );
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
