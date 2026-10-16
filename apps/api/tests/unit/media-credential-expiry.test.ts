import { afterEach, describe, expect, it } from 'vitest';
import {
  mediaCredentialStatus,
  warnExpiringMediaCredential,
} from '../../src/modules/media/credential-expiry.service.ts';
import {
  MockVideoProvider,
  setMediaProvidersForTesting,
  type VideoProvider,
} from '../../src/adapters/media/index.ts';

/**
 * The video credential's own expiry (D70).
 *
 * Whereby issues its API key as a JWT with a thirty-day life. One expired on
 * 7 October 2026 at 16:00:11 UTC; at 16:11 a patient paid, a doctor accepted,
 * and no room could be created for either of them. The date was readable from
 * the key the whole time, and nothing read it.
 *
 * The decisive test here is the last one: the real incident, replayed.
 */

/** A provider whose credential expires when we say it does. */
function providerExpiring(at: Date | null): VideoProvider {
  const provider = new MockVideoProvider();
  (provider as VideoProvider).credentialExpiresAt = () => at;
  return provider;
}

const clockAt = (iso: string) => ({ now: () => new Date(iso) });

describe('the video provider credential', () => {
  afterEach(() => {
    setMediaProvidersForTesting(undefined);
  });

  it('reports nothing to warn about when the credential carries no expiry', () => {
    setMediaProvidersForTesting({ video: providerExpiring(null) });

    const status = mediaCredentialStatus();

    expect(status.expiresAt).toBeNull();
    expect(status.daysRemaining).toBeNull();
    /*
     * Not expired, and that is not the same as working. A key can be revoked
     * at any moment; only whereby:check tests whether one is accepted.
     */
    expect(status.expired).toBe(false);
  });

  it('counts the days left while the credential is still good', () => {
    setMediaProvidersForTesting({ video: providerExpiring(new Date('2026-11-07T16:00:11Z')) });

    const status = mediaCredentialStatus(clockAt('2026-10-14T10:00:00Z'));

    expect(status.expired).toBe(false);
    expect(status.daysRemaining).toBe(24);
  });

  it('says so once the credential has expired, and counts backwards', () => {
    setMediaProvidersForTesting({ video: providerExpiring(new Date('2026-10-07T16:00:11Z')) });

    const status = mediaCredentialStatus(clockAt('2026-10-13T16:00:11Z'));

    expect(status.expired).toBe(true);
    expect(status.daysRemaining).toBe(-6);
  });

  it('stays quiet while the expiry is further off than the warning window', async () => {
    setMediaProvidersForTesting({ video: providerExpiring(new Date('2026-11-07T16:00:11Z')) });

    // 24 days out, against a 7-day window.
    expect(await warnExpiringMediaCredential(undefined, clockAt('2026-10-14T10:00:00Z'))).toBe(0);
  });

  it('warns once the expiry comes inside the window', async () => {
    setMediaProvidersForTesting({ video: providerExpiring(new Date('2026-11-07T16:00:11Z')) });

    expect(await warnExpiringMediaCredential(undefined, clockAt('2026-11-03T10:00:00Z'))).toBe(1);
  });

  it('keeps warning after it has expired, rather than falling silent', async () => {
    setMediaProvidersForTesting({ video: providerExpiring(new Date('2026-10-07T16:00:11Z')) });

    /*
     * The window is "within 7 days", and an expired credential is at -6, -30,
     * -90 … A naive range check would stop warning the moment the thing it
     * warns about actually happened.
     */
    expect(await warnExpiringMediaCredential(undefined, clockAt('2026-11-20T10:00:00Z'))).toBe(1);
  });

  it('says nothing about a provider that has no expiry to report', async () => {
    // The mock has no `credentialExpiresAt` at all — the method is optional.
    setMediaProvidersForTesting({ video: new MockVideoProvider() });

    expect(await warnExpiringMediaCredential(undefined, clockAt('2026-10-14T10:00:00Z'))).toBe(0);
  });

  /*
   * The replacement key, issued 16 October, carries exp: 9007199254740991 —
   * MAX_SAFE_INTEGER. That is how Whereby says "this does not expire", and it
   * is finite, so a naive check passes it through as an Invalid Date: every
   * comparison against NaN is false, so the range check lets it reach the
   * warning, and toISOString() throws there.
   *
   * The monitor broken by the fix for the thing it monitors.
   */
  it('treats an unrepresentable expiry as no expiry, rather than crashing on it', async () => {
    setMediaProvidersForTesting({
      video: providerExpiring(new Date(Number.MAX_SAFE_INTEGER * 1000)),
    });

    const status = mediaCredentialStatus();
    expect(status.expiresAt).toBeNull();
    expect(status.daysRemaining).toBeNull();
    expect(status.expired).toBe(false);

    // And the job neither warns nor throws.
    await expect(
      warnExpiringMediaCredential(undefined, clockAt('2026-10-16T10:00:00Z')),
    ).resolves.toBe(0);
  });

  it('would have warned a week before the 7 October outage', async () => {
    // The key that actually expired, and the day it took the service down.
    setMediaProvidersForTesting({ video: providerExpiring(new Date('2026-10-07T16:00:11Z')) });

    // Issued 7 September. Silent in the middle of its life.
    expect(await warnExpiringMediaCredential(undefined, clockAt('2026-09-20T09:00:00Z'))).toBe(0);

    // Seven days out: the first warning, with time to act on it.
    expect(await warnExpiringMediaCredential(undefined, clockAt('2026-09-30T17:00:00Z'))).toBe(1);

    // The morning of the day it expired.
    expect(await warnExpiringMediaCredential(undefined, clockAt('2026-10-07T09:00:00Z'))).toBe(1);

    // And eleven minutes after it did — when the patient paid.
    const atTheIncident = mediaCredentialStatus(clockAt('2026-10-07T16:11:27Z'));
    expect(atTheIncident.expired).toBe(true);
  });
});
