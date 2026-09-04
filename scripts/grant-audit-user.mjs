/**
 * Grants the append-only audit account its table-level privileges.
 *
 * These cannot be issued by `docker/mysql-init`, which runs before any table
 * exists: MySQL will not grant on a table it cannot see. So the account is
 * created there and its privileges are granted here, after migrations.
 *
 *   npm run db:grants
 *
 * The account holds INSERT and SELECT on `audit_logs` and nothing else — no
 * UPDATE, no DELETE, and no access to any other table. Someone holding these
 * credentials cannot rewrite history and cannot read patient or clinical data
 * either (docs/security.md §6, spec §61).
 *
 * **What this does not do.** Nothing in the application connects as this
 * account today. Audit rows are written on the same connection and inside the
 * same transaction as the business change they record, which is deliberate —
 * an audit entry and the thing it describes commit together or not at all, and
 * a second connection cannot join that transaction. So the append-only
 * property is enforced by the service surface (no update or delete method, no
 * route) and asserted by test, while this account exists for the operator and
 * for anything reading the log out of band. Making it the application's own
 * writer would mean giving up transactional audit, which is the worse trade.
 *
 * The database names come from the environment rather than being hard-coded,
 * so an installation that renamed its schema still grants against the right
 * one.
 */
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { mysqlArgv } from './mysql-cli.mjs';
import { loadDotEnv } from './load-env.mjs';

function main() {
  loadDotEnv();

  const rootPassword = process.env.MYSQL_ROOT_PASSWORD;
  if (!rootPassword) {
    console.error(
      'MYSQL_ROOT_PASSWORD is not set. Granting privileges needs an account\n' +
        'that holds GRANT OPTION, and the application user deliberately does not.',
    );
    process.exit(1);
  }

  const appDb = process.env.MYSQL_DATABASE ?? 'neem';
  const testDb = testDatabaseName();

  const auditUser = auditUserName();
  const databases = testDb && testDb !== appDb ? [appDb, testDb] : [appDb];

  /**
   * One statement per database, each allowed to fail on its own.
   *
   * MySQL will not grant on a table that does not exist, and the databases
   * here are not migrated together — so a single script would abort the whole
   * grant, and with it `npm run setup`, because of one schema that happens not
   * to be ready. That is exactly what a clean checkout did.
   */
  const statements = databases.map((db) => ({
    db,
    sql:
      `GRANT INSERT, SELECT ON \`${db}\`.\`audit_logs\` TO '${auditUser}'@'%';\n` +
      'FLUSH PRIVILEGES;\n',
  }));

  const { command, args, env } = mysqlArgv(
    'mysql',
    {
      host: '127.0.0.1',
      port: process.env.MYSQL_PORT ?? '3307',
      user: 'root',
      password: rootPassword,
      database: appDb,
    },
    [],
  );

  let granted = 0;

  for (const statement of statements) {
    const result = spawnSync(command, args, {
      env,
      input: statement.sql,
      stdio: ['pipe', 'inherit', 'pipe'],
    });

    if (result.status === 0) {
      console.log(
        `  ✓ ${auditUser} may INSERT and SELECT on ${statement.db}.audit_logs, and nothing else`,
      );
      granted += 1;
      continue;
    }

    /**
     * A schema with no `audit_logs` has not been migrated yet, which is a
     * state to report rather than fail on: the application database is the one
     * that matters, and the test database is migrated separately.
     */
    console.log(
      `  · skipped ${statement.db} — no audit_logs table there yet. ` +
        'Run `npm run db:migrate` (or `db:migrate:test`) and this again.',
    );
  }

  if (granted === 0) {
    console.error(
      '\nNothing was granted. `audit_logs` has to exist before MySQL will\n' +
        'grant on it — run `npm run db:migrate` first.',
    );
    process.exit(1);
  }
}

/** The audit account's name, read from its URL so the two cannot drift apart. */
function auditUserName() {
  const raw = process.env.AUDIT_DATABASE_URL;
  if (!raw) return 'neem_audit';
  try {
    return decodeURIComponent(new URL(raw).username) || 'neem_audit';
  } catch {
    return 'neem_audit';
  }
}

/** The test schema, if this installation has one. */
function testDatabaseName() {
  const raw = process.env.TEST_DATABASE_URL;
  if (!raw) return null;
  try {
    return new URL(raw).pathname.replace(/^\//, '') || null;
  } catch {
    return null;
  }
}

// `pathToFileURL` rather than string-building: on Windows a path compared as a
// raw string never matches `import.meta.url`, and the script silently does
// nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
