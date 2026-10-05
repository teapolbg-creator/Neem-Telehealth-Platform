import { afterAll, describe, expect, it } from 'vitest';
import { closeTestApp, request } from '../helpers/app.ts';
import { disconnectPrisma } from '../../src/db/prisma.ts';

/**
 * A deploy can be verified from outside (D62).
 *
 * Before this, every build answered `/health` identically, so "is the new code
 * live?" could only be inferred from a behaviour change — and a release that
 * added no new route gave nothing to ask. That produced three wrong calls in one
 * afternoon, including reporting a deploy as live while it was serving 502s.
 *
 * The second case below is the one that matters more than it looks: this
 * endpoint is unauthenticated, so what it says about the build has to stay
 * worth nothing to a stranger.
 */

afterAll(async () => {
  await closeTestApp();
  await disconnectPrisma();
});

describe('the health endpoints name the running build', () => {
  it('reports a commit on both probes', async () => {
    const live = await request<{ status: string; commit: string }>('/health');
    const ready = await request<{ status: string; commit: string }>('/health/ready');

    expect(live.status).toBe(200);
    expect(live.body.data?.commit).toBeTruthy();
    expect(ready.body.data?.commit).toBe(live.body.data?.commit);
  });

  it('says "unknown" rather than failing when the build did not say', async () => {
    // Nothing sets RENDER_GIT_COMMIT under test, which is the same position a
    // hand-built container is in. A deployment that cannot name itself must
    // still serve patients.
    const live = await request<{ commit: string }>('/health');
    expect(live.body.data?.commit).toBe('unknown');
  });

  it('never publishes a full commit hash', async () => {
    const live = await request<{ commit: string }>('/health');
    const commit = live.body.data!.commit;

    /*
     * Seven characters, or the word "unknown". Enough for an operator to
     * compare against `git rev-parse --short HEAD`; not an exact build
     * identifier handed to anyone who asks an unauthenticated endpoint.
     */
    expect(commit.length).toBeLessThanOrEqual(7);
  });

  it('still says nothing else about the deployment', async () => {
    const ready = await request<Record<string, unknown>>('/health/ready');

    /*
     * The readiness probe gave away which providers were mocked until it was
     * narrowed; this guards that narrowing against being widened again by
     * accident. Configuration belongs behind /admin/system-health.
     */
    expect(Object.keys(ready.body.data ?? {}).sort()).toEqual(['commit', 'status']);
  });
});
