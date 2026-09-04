import { API_URL } from './fixtures.ts';

/**
 * Waits for the API before any test runs.
 *
 * Playwright's `webServer` block waits for the **web** app on 8080, and that is
 * all it waits for. `npm run dev` starts two processes under `concurrently`,
 * and every test in this suite talks to the API on 4000 — which the config had
 * no opinion about. The two usually come up close enough together that it did
 * not matter, and "usually" is the word that costs an afternoon.
 *
 * The endpoint is `/api/v1/health`, and getting that wrong is easy in a way
 * worth naming: every route in this API is under `/api/v1`, so a probe against
 * `/health` returns 404. A hand-written loop using `curl -s -o /dev/null`
 * treats that 404 as success — curl exits 0 for any response it received — so
 * the loop returns immediately and the suite starts against a server that may
 * not be listening yet. That is exactly the loop I ran repeatedly while
 * chasing intermittent failures in this suite.
 *
 * `/health` rather than `/health/ready`: readiness also checks the database and
 * returns 503 when it is down, which is a different question. What the suite
 * needs to know here is whether the process is answering; a failure to reach
 * MySQL should surface as the test that needed it failing, with its own
 * message, rather than as an opaque timeout before anything ran.
 */
const HEALTH = `${API_URL}/api/v1/health`;
const TIMEOUT_MS = 120_000;
const INTERVAL_MS = 500;

export default async function waitForTheApi(): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  let lastError = 'no response';

  while (Date.now() < deadline) {
    try {
      const response = await fetch(HEALTH);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }

  throw new Error(
    `The API did not become healthy within ${TIMEOUT_MS / 1000}s.\n` +
      `Probed ${HEALTH} — last result: ${lastError}.\n\n` +
      'Start the stack with `npm run dev`, or point E2E_API_URL at a running one.',
  );
}
