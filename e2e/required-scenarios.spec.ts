import {
  test,
  expect,
  API,
  DEMO,
  csrfHeaders,
  gotoHydrated,
  signIn,
  signInAdminOnPage,
} from './support/fixtures.ts';

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
 * Progress: 12 of 16 implemented.
 *   3, 4, 5           queue.spec.ts       (Phase 4)
 *   6, 7, 8, 9, 10,
 *   11, 12, 13        clinical.spec.ts    (Phase 6)
 *   16                below              (Phase 7)
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

  /**
   * Scenario 16, end to end through the real screens.
   *
   * The API-level behaviour is covered thoroughly in the Vitest suite. What
   * this adds is the part that suite cannot see: that an administrator can
   * actually reach the decision, and that the money and the ledger move
   * together when they press the button.
   */
  test('Scenario 16 — patient requests a refund and an admin approves it', async ({
    page,
    playwright,
    run,
  }) => {
    const pharmacyApi = await playwright.request.newContext();
    const csrf = await signIn(pharmacyApi, DEMO.pharmacy);

    const created = await pharmacyApi.post(`${API}/pharmacy/consultations`, {
      headers: csrfHeaders(csrf),
      data: {},
    });
    const publicId = (await created.json()).data.publicId as string;

    await pharmacyApi.post(`${API}/pharmacy/consultations/${publicId}/payment`, {
      headers: csrfHeaders(csrf),
      data: {},
    });
    await pharmacyApi.post(`${API}/pharmacy/consultations/${publicId}/payment/simulate`, {
      headers: csrfHeaders(csrf),
      data: { outcome: 'SUCCESS' },
    });

    // The pharmacy asks on the patient's behalf — the patient has left.
    const requested = await pharmacyApi.post(
      `${API}/pharmacy/consultations/${publicId}/refund-request`,
      {
        headers: csrfHeaders(csrf),
        data: { reason: `No doctor was available (run ${run}).` },
      },
    );
    expect(requested.ok()).toBeTruthy();

    // The administrator decides, on the screen built for it.
    await signInAdminOnPage(page);
    await gotoHydrated(page, '/admin/refunds');

    // Scoped to this run's consultation: the queue legitimately holds other
    // pharmacies' requests, and a locator that matched any card would pass
    // while approving somebody else's refund.
    const card = page
      .locator('section')
      .filter({ hasText: publicId })
      .filter({ has: page.getByRole('button', { name: 'Approve and refund' }) });
    await expect(card).toBeVisible();

    // A reason is required for either answer.
    await expect(card.getByRole('button', { name: 'Approve and refund' })).toBeDisabled();
    await card.getByRole('textbox').fill('Nobody was available. Refunding in full.');
    await card.getByRole('button', { name: 'Approve and refund' }).click();

    /**
     * Asserted at the API rather than in the DOM.
     *
     * What matters is that pressing the button moved the money and the ledger
     * together; that the card then rerenders is presentation. Polling here
     * because approval calls the provider before writing, so the state change
     * lands a moment after the click.
     */
    await expect
      .poll(
        async () => {
          const response = await pharmacyApi.get(`${API}/pharmacy/consultations/${publicId}`);
          return (await response.json()).data.state as string;
        },
        { timeout: 15_000 },
      )
      .toBe('REFUNDED');

    /**
     * The decision is recorded and shown back, not merely applied.
     *
     * Asserted at page level rather than scoped to the card. A `section`
     * locator matches ancestors as well as the card itself, so filtering it
     * was ambiguous — and once approval removed the card's buttons, a filter
     * defined by one of those buttons stopped matching the very row it had
     * just acted on. This sentence appears once on the page, and the poll
     * above has already pinned which refund it belongs to.
     */
    await expect(page.getByText('Nobody was available. Refunding in full.')).toBeVisible();

    await pharmacyApi.dispose();
  });
});
