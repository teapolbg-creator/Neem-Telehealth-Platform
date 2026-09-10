/**
 * Locating a PostgreSQL client, and invoking it without leaking the password.
 *
 * The development database runs in Docker and there is usually no `pg_dump` on
 * the host, which would otherwise make the backup scripts unrunnable on the
 * machine they most need to be rehearsed on. So: use a local client if there
 * is one, and otherwise borrow the one inside the container.
 *
 * Borrowing changes the connection parameters. From inside the container the
 * server is on `127.0.0.1:5432`, not the host's published port, so the flags
 * have to be rewritten rather than passed through.
 *
 * **Version matters more here than it did with MySQL.** `pg_dump` refuses to
 * dump a server newer than itself, so a host with an older client and a newer
 * server fails with a version error rather than a bad dump. Borrowing the
 * container's client sidesteps that, and the check below prefers a local
 * client only when it is at least as new as the server.
 *
 * The password travels in `PGPASSWORD` rather than in the connection URL. A
 * password in argv is readable by every other process on the machine for as
 * long as the dump runs, which for a full database backup is a while.
 */
import { spawnSync } from 'node:child_process';

const CONTAINER = process.env.NEEM_POSTGRES_CONTAINER ?? 'neem-postgres';

function onPath(binary) {
  const probe = spawnSync(binary, ['--version'], { stdio: 'ignore' });
  return probe.status === 0;
}

/** The major version a client reports, or undefined when it cannot be read. */
function clientMajor(binary) {
  const probe = spawnSync(binary, ['--version'], { encoding: 'utf8' });
  if (probe.status !== 0) return undefined;

  const match = /(\d+)/.exec(probe.stdout ?? '');
  return match ? Number.parseInt(match[1], 10) : undefined;
}

/**
 * The major version the server is running, asked of the container.
 *
 * Only consulted to decide whether a local client is new enough; if it cannot
 * be determined the local client is used anyway and any incompatibility
 * surfaces as pg_dump's own, clearer, error.
 */
function serverMajor() {
  if (!onPath('docker')) return undefined;

  const probe = spawnSync('docker', ['exec', CONTAINER, 'psql', '--version'], { encoding: 'utf8' });
  if (probe.status !== 0) return undefined;

  const match = /(\d+)/.exec(probe.stdout ?? '');
  return match ? Number.parseInt(match[1], 10) : undefined;
}

/**
 * Builds the argv and environment for a PostgreSQL client invocation, wrapping
 * it in `docker exec` when the host has no usable client of its own.
 *
 * @param {'psql' | 'pg_dump' | 'pg_restore'} binary
 * @param {{host: string, port: string, user: string, password: string, database: string}} target
 * @param {string[]} extra flags and arguments after the connection flags
 * @returns {{command: string, args: string[], env: Record<string, string>, viaDocker: boolean}}
 */
export function psqlArgv(binary, target, extra) {
  const server = serverMajor();
  const client = onPath(binary) ? clientMajor(binary) : undefined;

  // A local client is used when it exists and is not older than the server.
  const useLocal = client !== undefined && (server === undefined || client >= server);

  // Inside the container the server is local, whatever the host published.
  const host = useLocal ? target.host : '127.0.0.1';
  const port = useLocal ? target.port : '5432';

  const connection = [
    `--host=${host}`,
    `--port=${port}`,
    `--username=${target.user}`,
    `--dbname=${target.database}`,
  ];

  if (useLocal) {
    return {
      command: binary,
      args: [...connection, ...extra],
      env: { ...process.env, PGPASSWORD: target.password },
      viaDocker: false,
    };
  }

  if (!onPath('docker')) {
    throw new Error(
      `Neither a usable ${binary} nor docker is available. Install a PostgreSQL ` +
        `client of at least version ${server ?? 17}, or start the development ` +
        'database so the container client can be used.',
    );
  }

  return {
    command: 'docker',
    args: [
      'exec',
      '-i',
      '-e',
      `PGPASSWORD=${target.password}`,
      CONTAINER,
      binary,
      ...connection,
      ...extra,
    ],
    env: process.env,
    viaDocker: true,
  };
}
