import { test } from './support/fixtures.ts';

/**
 * The 16 end-to-end scenarios the specification requires (spec §80).
 *
 * Each one is declared here from the start and marked `fixme` until the phase
 * that makes it possible has landed. That is deliberate: a scenario that is
 * simply absent looks like coverage nobody thought about, whereas a scenario
 * reported as pending is a visible, countable gap. Running the suite prints
 * exactly how much of the required coverage exists.
 *
 * As each phase lands, the corresponding `test.fixme` becomes a real test in
 * its own spec file, and the placeholder here is deleted.
 *
 * Progress: 11 of 16 implemented.
 *   3, 4, 5           queue.spec.ts       (Phase 4)
 *   6, 7, 8, 9, 10,
 *   11, 12, 13        clinical.spec.ts    (Phase 6)
 *
 * Scenario 11 was restated by decision D23: clinical notes are NOT deleted at
 * completion, because Ghanaian law does not permit that. It now asserts the
 * three things that replace it — the record still exists, no role can read it,
 * and it is destroyed at the end of its retention period.
 *
 * Also present but not among the 16: media.spec.ts covers the no-recording and
 * no-phone-number guarantees, and pharmacy-onboarding.spec.ts the verification
 * path.
 *
 * The five remaining await Phase 7 (payments and refunds) and Phase 2's
 * membership expiry.
 */

test.describe('required scenarios (spec §80)', () => {
  // Scenarios 3, 4 and 5 are implemented in queue.spec.ts (Phase 4).

  test.fixme(
    'Scenario 1 — pharmacy → payment → QR → patient → doctor → consultation → completion',
    async () => {
      // Needs: Phase 3 (consultation engine), Phase 4 (queue), Phase 5 (media).
    },
  );

  test.fixme('Scenario 2 — payment fails, patient retries, payment succeeds', async () => {
    // Needs: Phase 3 payment orchestration; Phase 7 for the real provider.
  });


  test.fixme('Scenario 14 — a doctor cannot be scheduled beyond 40 hours', async () => {
    // NOTE: this rule is already built and covered by the Vitest integration
    // suite, including the concurrent-assignment race. It is listed here
    // because §80 asks for it end to end; it needs an admin scheduling UI,
    // which arrives with the Phase 9 admin console.
  });

  test.fixme('Scenario 15 — membership expires and the account is suspended', async () => {
    // Lifecycle is built (subscription sweep); needs Phase 7 payment to drive
    // it end to end rather than by manipulating dates.
  });

  test.fixme('Scenario 16 — patient requests a refund and an admin approves it', async () => {
    // Needs: Phase 3 (consultation), Phase 7 (refunds).
  });
});
