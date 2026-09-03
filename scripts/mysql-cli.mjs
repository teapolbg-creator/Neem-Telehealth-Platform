/**
 * Locating a MySQL client, and invoking it without leaking the password.
 *
 * The development database runs in Docker and there is no `mysqldump` on the
 * host, which is normal and would otherwise make the backup scripts
 * unrunnable on the machine they most need to be rehearsed on. So: use a
 * local client if there is one, and otherwise borrow the one inside the
 * container.
 *
 * Borrowing changes the connection parameters. From inside the container the
 * server is on `127.0.0.1:3306`, not the host's published port, so the flags
 * have to be rewritten rather than passed through.
 *
 * The password travels in `MYSQL_PWD` rather than `--password=`. A password on
 * the command line is readable by every other process on the machine for as
 * long as the dump runs, which for a full database backup is a while; MySQL
 * prints a warning about it on every invocation for exactly that reason.
 */
import { spawnSync } from 'node:child_process';

const CONTAINER = process.env.NEEM_MYSQL_CONTAINER ?? 'neem-mysql';

function onPath(binary) {
  const probe = spawnSync(binary, ['--version'], { stdio: 'ignore' });
  return probe.status === 0;
}

/**
 * Builds the argv and environment for a MySQL client invocation, wrapping it
 * in `docker exec` when the host has no client of its own.
 *
 * @param {'mysql' | 'mysqldump'} binary
 * @param {{host: string, port: string, user: string, password: string, database: string}} target
 * @param {string[]} extra flags and arguments after the connection flags
 * @returns {{command: string, args: string[], env: Record<string, string>, viaDocker: boolean}}
 */
export function mysqlArgv(binary, target, extra) {
  const local = onPath(binary);

  // Inside the container the server is local, whatever the host published.
  const host = local ? target.host : '127.0.0.1';
  const port = local ? target.port : '3306';

  const connection = [`--host=${host}`, `--port=${port}`, `--user=${target.user}`];

  if (local) {
    return {
      command: binary,
      args: [...connection, ...extra],
      env: { ...process.env, MYSQL_PWD: target.password },
      viaDocker: false,
    };
  }

  if (!onPath('docker')) {
    throw new Error(
      `Neither ${binary} nor docker is available. Install a MySQL client, or ` +
        'start the development database so the container client can be used.',
    );
  }

  return {
    command: 'docker',
    args: [
      'exec',
      '-i',
      '-e',
      `MYSQL_PWD=${target.password}`,
      CONTAINER,
      binary,
      ...connection,
      ...extra,
    ],
    env: process.env,
    viaDocker: true,
  };
}
