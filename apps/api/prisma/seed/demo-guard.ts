/**
 * Demo data goes into a database on this machine, or nowhere (decision D52).
 *
 * The seed decides whether to write demo data from `NODE_ENV` and
 * `SEED_DEMO_DATA`, and both of those are read from the local `.env` — which
 * says `development` and `true`. Pointing `DATABASE_URL` at production to seed
 * reference data, and forgetting to override `SEED_DEMO_DATA`, would therefore
 * put demo pharmacies, demo doctors and demo sign-in accounts with published
 * passwords into the live database. That nearly happened once.
 *
 * So the last word belongs to where the data is actually going, not to what a
 * flag says. Only loopback hosts count as local: the development database is
 * published on `localhost` by `docker/docker-compose.yml`, nothing runs the
 * seed from inside a container, and CI does not seed at all. A hostname that
 * merely contains "localhost" is not loopback.
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Why demo data must not be seeded into these databases, or null when every
 * one of them is on this machine. Unset entries are ignored; an entry that
 * cannot be parsed is refused, because it cannot be shown to be local.
 */
export function demoDataRefusal(urls: Record<string, string | undefined>): string | null {
  for (const [name, value] of Object.entries(urls)) {
    if (!value) continue;

    let host: string;
    try {
      host = new URL(value).hostname.toLowerCase();
    } catch {
      return `${name} could not be read as a URL, so it cannot be shown to be a local database.`;
    }

    if (!LOOPBACK_HOSTS.has(host)) {
      return `${name} points at ${host}, which is not a database on this machine.`;
    }
  }

  return null;
}
