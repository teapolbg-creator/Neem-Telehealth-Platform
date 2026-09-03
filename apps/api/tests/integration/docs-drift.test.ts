import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { closeTestApp, getTestApp } from '../helpers/app.ts';
import { disconnectPrisma } from '../../src/db/prisma.ts';

/**
 * `docs/api.md` against the router (Phase 10).
 *
 * The API reference was written in Phase 0 as a design and nobody ever checked
 * it against what got built. By Phase 10 it listed **31 paths that did not
 * exist**: `/webhooks/paystack` for what became `/webhooks/payment`,
 * `/auth/login/2fa` for `/auth/2fa/verify`, and eight capabilities never built
 * at all. A reference that confidently names routes you cannot call is worse
 * than no reference, because it is trusted.
 *
 * Reconciling it once fixes today. This keeps it fixed: every path the
 * document names must either exist in the live router or sit under a
 * `NOT BUILT` marker saying so. Renaming a route without touching the docs now
 * fails a test rather than quietly widening the gap again.
 *
 * The same argument as decision D33, applied to prose: a claim nobody
 * re-executes decays, and the only reliable re-reader is the build.
 */

afterAll(async () => {
  await closeTestApp();
  await disconnectPrisma();
});

/** Path-ish tokens belonging to the API rather than to a file or a heading. */
const API_PATH = /^\/(admin|doctor|doctors|pharmacy|patient|auth|onboarding|webhooks|documents|verify|s|health)\b/;

/** `:publicId` and `:id` differ only in taste; compare shapes, not names. */
function normalise(path: string): string {
  return path.replace(/:[A-Za-z]+/g, ':x').replace(/\/$/, '');
}

/** Every path the live Fastify router serves, prefix-joined from its tree. */
async function liveRoutes(): Promise<Set<string>> {
  const app = await getTestApp();
  const printed = app.printRoutes({ commonPrefix: false });

  const paths: string[] = [];
  const stack: string[] = [];

  for (const line of printed.split('\n')) {
    const marker = line.indexOf('── ');
    if (marker === -1) continue;

    const depth = Math.floor(marker / 4);
    const match = line.slice(marker + 3).match(/^(\S*)\s+\(([^)]+)\)\s*$/);
    if (!match) continue;

    stack.length = depth;
    stack[depth] = match[1]!;
    paths.push(stack.slice(0, depth + 1).join('').replace('/api/v1', ''));
  }

  return new Set(paths.map(normalise));
}

/**
 * Paths the document explicitly says are not built.
 *
 * A block begins at a `NOT BUILT` line and ends at the next blank line or
 * fence, so the marker has to sit immediately above what it describes.
 */
function declaredAbsent(doc: string): Set<string> {
  const absent = new Set<string>();
  let inside = false;

  for (const line of doc.split('\n')) {
    if (/^NOT BUILT/.test(line)) {
      inside = true;
      continue;
    }
    if (inside && (line.trim() === '' || line.startsWith('```'))) {
      inside = false;
      continue;
    }
    if (inside) {
      for (const token of line.match(/\/[a-z0-9:$._\-/]+/gi) ?? []) absent.add(normalise(token));
    }
  }

  return absent;
}

describe('docs/api.md', () => {
  it('names no route that does not exist', async () => {
    const doc = readFileSync('../../docs/api.md', 'utf8');
    const live = await liveRoutes();
    const absent = declaredAbsent(doc);

    const documented = new Set<string>();
    for (const raw of doc.match(/\/[a-z0-9:$._\-/]+/gi) ?? []) {
      const path = raw.replace(/[.,]$/, '');
      if (API_PATH.test(path)) documented.add(path);
    }

    expect(documented.size).toBeGreaterThan(60);

    const unexplained = [...documented]
      .filter((path) => !live.has(normalise(path)))
      .filter((path) => !absent.has(normalise(path)))
      // A documented prefix of a real route is fine: the doc writes
      // `/admin/settings` where the router has `/admin/settings/:key`.
      .filter((path) => ![...live].some((route) => route.startsWith(normalise(path))))
      .sort();

    expect(unexplained).toEqual([]);
  });

  it('keeps no NOT BUILT marker over a route that now exists', async () => {
    const doc = readFileSync('../../docs/api.md', 'utf8');
    const live = await liveRoutes();

    // The other direction. Building something and leaving it marked absent
    // sends the next reader looking for a workaround they do not need.
    const wrong = [...declaredAbsent(doc)].filter((path) => live.has(path)).sort();

    expect(wrong).toEqual([]);
  });
});
