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
 * Progress: 3 of 16 implemented. Scenarios 3, 4 and 5 live in queue.spec.ts.
 * Phase 5 added media.spec.ts, which is not one of the 16 but covers the
 * no-recording and no-phone-number guarantees end to end. The rest await
 * Phases 6–7 — most of them need a doctor to be able to COMPLETE a
 * consultation, which is Phase 6.
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

  test.fixme('Scenario 6 — doctor issues a prescription and the pharmacy receives it', async () => {
    // Needs: Phase 6 prescription engine.
  });

  test.fixme('Scenario 7 — pharmacy proposes a substitution and the doctor approves', async () => {
    // Needs: Phase 6 substitution workflow.
  });

  test.fixme('Scenario 8 — doctor rejects a proposed substitution', async () => {
    // Needs: Phase 6.
  });

  test.fixme('Scenario 9 — a prescription is revoked before dispensing', async () => {
    // Needs: Phase 6 prescription state machine.
  });

  test.fixme('Scenario 10 — a dispensed prescription cannot be revoked', async () => {
    // Needs: Phase 6. DISPENSED → REVOKED must be impossible (spec §82).
  });

  /**
   * PREMISE VOIDED BY DECISION D23 — needs redefining with the product owner.
   *
   * This scenario, and spec §101 behind it, assert that clinical notes are
   * deleted when the consultation completes. Ghanaian record-keeping law does
   * not permit that: notes are retained sealed for the configured period and
   * destroyed at expiry.
   *
   * As written this test cannot pass without breaking the law it was meant to
   * demonstrate compliance with. The replacement is three assertions
   * (docs/data-retention.md §6):
   *
   *   1. after completion the clinical record still exists, encrypted;
   *   2. NO authenticated role — doctor, pharmacy, admin, patient — can read
   *      it through any route (this is the assertion that now carries the
   *      privacy guarantee);
   *   3. after the retention period elapses and the job runs, the rows are
   *      gone.
   *
   * Left as one fixme rather than silently rewritten, because changing a
   * required acceptance criterion is the product owner's call, not mine.
   */
  test.fixme('Scenario 11 — clinical notes are deleted after the consultation', async () => {
    // Needs: Phase 5.5 (retention) and Phase 6 (completion), and a decision on
    // the restated criterion above.
  });

  test.fixme('Scenario 12 — a prescription stays accessible to authorised parties', async () => {
    // Needs: Phase 6.
  });

  test.fixme('Scenario 13 — one pharmacy cannot read another pharmacy’s prescription', async () => {
    // Needs: Phase 6. The seed provides a second pharmacy for exactly this.
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
