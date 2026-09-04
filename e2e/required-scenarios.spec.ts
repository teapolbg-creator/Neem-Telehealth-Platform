import {
  test,
  expect,
  API,
  DEMO,
  createActiveDoctor,
  csrfHeaders,
  gotoHydrated,
  fillField,
  openSecondPage,
  putDoctorOnShiftNow,
  signIn,
  signInAdmin,
  signInAdminOnPage,
  signInThroughUi,
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
 * Progress: 15 of 16 implemented.
 *   1, 2, 14, 16      below               (Phase 10 for 1, 2 and 14)
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
 * The one remaining is scenario 15. The note above it says exactly why a
 * browser cannot drive an hourly job, and where the mechanism is covered
 * instead. Scenarios 1, 2 and 14 were pending behind notes naming phases that
 * had already shipped — 14 for nine of them — which is its own lesson: a
 * pending marker is only honest while somebody re-reads the reason.
 */

/** Typed into the decision box and asserted afterwards; one constant, so they cannot drift. */
const DECISION_NOTE = 'Nobody was available. Refunding in full.';

test.describe('required scenarios (spec §80)', () => {
  // Scenarios 3, 4 and 5 are implemented in queue.spec.ts (Phase 4).

  /**
   * Scenario 1 — the whole product, through its own screens.
   *
   * Pending since Phase 3 behind "needs Phase 3, Phase 4, Phase 5", all of
   * which landed long ago. Every part of this has been covered piecemeal for
   * phases: the consultation engine in the integration suite, the queue in
   * queue.spec.ts, the clinical record in clinical.spec.ts. What none of them
   * do is join the parts together in one browser, in the order a real
   * afternoon at a counter happens, which is the only thing this scenario is
   * for.
   *
   * Three separate browser contexts, because the three parties are three
   * different people on three different devices, and a test that shared a
   * cookie jar between them would prove nothing about any of them. The
   * patient's runs at phone dimensions, which is the only device that portal
   * is designed for (spec §69).
   *
   * Only the doctor's rota is set up over the API. Being on a shift is a
   * precondition of the scenario rather than part of it, and Scenario 14
   * covers that screen.
   */
  test('Scenario 1 — pharmacy → payment → QR → patient → doctor → consultation → completion', async ({
    page,
    playwright,
    run,
  }) => {
    const doctorApi = await playwright.request.newContext();
    const adminApi = await playwright.request.newContext();

    const doctor = await createActiveDoctor(doctorApi, { run: `${run}s1` });
    const onShift = await putDoctorOnShiftNow(doctorApi, adminApi, doctor);
    // Printed as well as annotated: a skip whose reason is only in the JSON
    // report is a skip nobody reads, and this scenario silently not running
    // is exactly the failure worth being loud about.
    if (!onShift.ok) console.log('  skipped:', onShift.reason);
    test.skip(!onShift.ok, onShift.ok ? '' : `Could not put the doctor on shift: ${onShift.reason}`);

    // -----------------------------------------------------------------------
    // 1. The counter: create, take payment, print the code.
    // -----------------------------------------------------------------------
    await signInThroughUi(page, DEMO.pharmacy);
    await gotoHydrated(page, '/pharmacy/new');

    // The token is captured from the response the screen itself received. The
    // page renders the code as an image and puts the link on the clipboard,
    // so there is nothing in the DOM to read — and a real patient photographs
    // it rather than reading it.
    const created = page.waitForResponse(
      (response) =>
        response.url().endsWith('/pharmacy/consultations') &&
        response.request().method() === 'POST',
    );

    const qrIssued = page.waitForResponse(
      (response) => response.url().endsWith('/qr') && response.request().method() === 'POST',
    );

    await page.getByRole('button', { name: /continue to payment/i }).click();
    await expect(page.getByRole('heading', { name: /collect payment/i })).toBeVisible({
      timeout: 20_000,
    });
    await page.getByRole('button', { name: /request payment/i }).click();
    await page.getByRole('button', { name: /simulate successful payment/i }).click();

    await expect(
      page.getByRole('heading', { name: /ask the patient to scan this code/i }),
    ).toBeVisible({ timeout: 30_000 });

    const publicId = (await (await created).json()).data.publicId as string;
    const token = ((await (await qrIssued).json()).data.url as string).split('/s/')[1];
    expect(token, 'the QR step should have issued a token').toBeTruthy();

    // -----------------------------------------------------------------------
    // 2. The patient's phone.
    // -----------------------------------------------------------------------
    const patient = await openSecondPage(page, { viewport: { width: 390, height: 844 } });
    await patient.goto(`/s/${token}`);

    await expect(patient.getByRole('heading', { name: /your details/i })).toBeVisible({
      timeout: 30_000,
    });
    await fillField(patient, 'Full name', 'Adwoa Mensah');
    await fillField(patient, 'Age', '34');
    // "Female", not "F". The button still reads "F" on screen — three of them
    // have to fit across a phone — but Phase 11 gave it an `aria-label`,
    // because "F" read aloud is not an answer to "Sex". Selecting by the
    // accessible name is what a patient using a screen reader would hear.
    await patient.getByRole('button', { name: 'Female', exact: true }).click();
    await fillField(patient, 'Your phone number', '0245551234');
    await patient.getByRole('button', { name: /^continue$/i }).click();

    await expect(patient.getByRole('heading', { name: /choose your language/i })).toBeVisible({
      timeout: 20_000,
    });
    await patient.getByRole('button', { name: /english/i }).first().click();
    await patient.getByRole('button', { name: /^continue$/i }).click();

    await expect(patient.getByRole('heading', { name: /how would you like to consult/i })).toBeVisible({
      timeout: 20_000,
    });
    await patient.getByRole('button', { name: /video/i }).first().click();
    await patient.getByRole('button', { name: /enter waiting room/i }).click();

    // -----------------------------------------------------------------------
    // 3. The doctor.
    // -----------------------------------------------------------------------
    const doctorPage = await openSecondPage(page);
    await signInThroughUi(doctorPage, doctor);
    await gotoHydrated(doctorPage, '/doctor/queue');

    // `isVisible()` does not wait, so asking it straight after a navigation
    // answers "no" simply because React has not painted — and the doctor then
    // stays offline while the test waits for an offer that can never come.
    // Wait for the toggle, read it, and assert the state actually flipped.
    const presenceToggle = doctorPage.getByRole('button', { name: /go online|go offline/i });
    await presenceToggle.waitFor({ state: 'visible', timeout: 20_000 });

    if (/go online/i.test((await presenceToggle.textContent()) ?? '')) {
      await presenceToggle.click();
    }
    await expect(doctorPage.getByRole('button', { name: /go offline/i })).toBeVisible({
      timeout: 20_000,
    });

    // The offer is routed and accepted over the API, and this is the one
    // deliberate departure from "through the screens" in this scenario.
    //
    // A doctor cannot decline an offer (spec §30). So the moment this doctor
    // comes online, `process-waiting-queue` may hand them any consultation
    // already queued — and they are then committed to it. On a database with
    // a backlog that is not a race this test can win, and it would sit
    // waiting for a patient whose consultation went to someone else.
    //
    // Being shown an offer and being unable to decline it is exactly what
    // queue.spec.ts scenario 4 covers, through the screen, with the
    // countdown. What is unique to *this* scenario is the join between the
    // counter, the phone, the clinical record and the patient's completion —
    // so that is what stays on the screens.
    const adminCsrf = (await signInAdmin(adminApi)).csrf;
    await adminApi.post(`${API}/admin/queue/${publicId}/reallocate`, {
      headers: csrfHeaders(adminCsrf),
      data: {},
    });

    const accepted = await doctorApi.post(`${API}/doctor/consultations/${publicId}/accept`, {
      headers: csrfHeaders(onShift.ok ? onShift.csrf : ''),
      data: {},
    });
    expect(accepted.ok(), `the doctor should be able to accept: ${await accepted.text()}`).toBeTruthy();

    await gotoHydrated(doctorPage, `/doctor/consultations/${publicId}`);

    // -----------------------------------------------------------------------
    // 4. The consultation, and its end.
    // -----------------------------------------------------------------------
    await expect(doctorPage).toHaveURL(new RegExp(publicId.replace(/-/g, '\\-')));

    await expect(doctorPage.getByRole('button', { name: /complete consultation/i })).toBeVisible({
      timeout: 30_000,
    });
    await doctorPage.getByRole('button', { name: /^other$/i }).click();
    await doctorPage.getByRole('button', { name: /complete consultation/i }).click();

    // The patient's own phone is where the consultation reference reaches
    // them, and it is their only route back to their own record (D24).
    await expect(patient.getByRole('heading', { name: /consultation complete/i })).toBeVisible({
      timeout: 30_000,
    });
    await expect(patient.getByText(/NEEM-[0-9A-HJKMNP-TV-Z]{4}-/)).toBeVisible();

    // And the patient can hand the phone back.
    //
    // `POST /patient/session/leave` existed from Phase 3 with no caller: the
    // portal's only "Leave" was the call's, which ends the video and lets you
    // rejoin. So there was no way to end a session on a handset about to go
    // back over a counter. The confirmation asks about the reference rather
    // than about security, because losing it is the consequence a patient
    // can actually act on (D24).
    const stolen = (await patient.context().cookies()).find(
      (cookie) => cookie.name === 'neem_patient',
    )!.value;

    await patient.getByRole('button', { name: /finish and clear this phone/i }).click();
    await patient.getByRole('button', { name: /yes, finish/i }).click();

    await expect(patient.getByRole('heading', { name: /this phone is clear/i })).toBeVisible({
      timeout: 20_000,
    });
    // Nothing of the consultation survives on the screen for the next person.
    await expect(patient.getByText(/NEEM-[0-9A-HJKMNP-TV-Z]{4}-/)).toHaveCount(0);

    // The copied token dies with it (D34) — the half that a cleared cookie
    // does nothing about.
    const replay = await playwright.request.newContext({
      extraHTTPHeaders: { cookie: `neem_patient=${stolen}` },
    });
    const afterFinish = await replay.get(`${API}/patient/session`);
    expect(afterFinish.status(), 'a copied patient token must not outlive the session').toBe(401);
    await replay.dispose();

    await patient.context().close();
    await doctorPage.context().close();
    await doctorApi.dispose();
    await adminApi.dispose();
  });

  /**
   * Scenario 2, entirely through the counter screen.
   *
   * The whole point is the middle: a failed payment must leave the
   * consultation recoverable rather than dead. A pharmacy that has to start
   * again — new consultation, new reference, patient asked to pay twice — is
   * the failure this scenario exists to rule out.
   *
   * Nothing here calls the API directly. A payment that the *server* has not
   * confirmed must not open the consultation (spec §34), so the only honest
   * way to test it is to press the buttons and watch what the screen is told.
   */
  test('Scenario 2 — payment fails, patient retries, payment succeeds', async ({ page }) => {
    await signInThroughUi(page, DEMO.pharmacy);
    await gotoHydrated(page, '/pharmacy/new');

    await expect(page.getByRole('heading', { name: /start a consultation/i })).toBeVisible();
    await page.getByRole('button', { name: /continue to payment/i }).click();

    await expect(page.getByRole('heading', { name: /collect payment/i })).toBeVisible({
      timeout: 20_000,
    });
    await page.getByRole('button', { name: /request payment/i }).click();

    // The provider reports a failure.
    await page.getByRole('button', { name: /simulate failure/i }).click();
    await expect(page.getByText(/payment did not go through/i)).toBeVisible({ timeout: 20_000 });

    // Recoverable, and on the same consultation: the screen offers another
    // attempt rather than sending the counter back to the beginning.
    await page.getByRole('button', { name: /try again/i }).click();
    await expect(page.getByRole('button', { name: /request payment/i })).toBeVisible();
    await page.getByRole('button', { name: /request payment/i }).click();

    await page.getByRole('button', { name: /simulate successful payment/i }).click();

    // Activation is the server's word, not the browser's: the screen advances
    // only once its own status poll reports ACTIVATED (spec §34).
    await expect(page.getByRole('heading', { name: /ask the patient to scan this code/i })).toBeVisible({
      timeout: 30_000,
    });
  });


  /**
   * Scenario 14, through the screen an administrator actually uses.
   *
   * Pending for nine phases behind the note "needs an admin scheduling UI,
   * which arrives with the Phase 9 admin console". Phase 9 came and went and
   * the screen never arrived: `POST /admin/shifts` existed from Phase 2,
   * `useAssignShift` was written in the feature layer, and no component ever
   * imported it. The 40-hour ceiling — a fatigue rule, not a preference — was
   * enforced on a route no administrator could reach, and this scenario could
   * not run end to end because there was no end to run it through.
   *
   * `/admin/scheduling` was built in Phase 10. What this adds over the
   * integration suite is that the refusal reaches a person: an API that says
   * no is worth nothing if the rota screen swallows it.
   *
   * Three NIGHT shifts are 36 hours and fit; the fourth would be 48 and must
   * not. They are placed on consecutive days of one ISO week, which is the
   * boundary the rule actually uses (`isoWeekOf`) — a test that straddled a
   * Monday would see the total reset and prove nothing.
   */
  test('Scenario 14 — a doctor cannot be scheduled beyond 40 hours', async ({
    page,
    playwright,
    run,
  }) => {
    const api = await playwright.request.newContext();
    const adminApi = await playwright.request.newContext();

    const doctor = await createActiveDoctor(api, { run: `${run}s14` });
    const adminCsrf = (await signInAdmin(adminApi)).csrf;

    // NIGHT is seeded inactive. Activating it is idempotent and leaves a real
    // capability behind rather than a test artefact — the same thing the
    // clinical fixture does for the same reason.
    const activated = await adminApi.patch(`${API}/admin/shifts/definitions/NIGHT`, {
      headers: csrfHeaders(adminCsrf),
      data: { isActive: true },
    });
    expect(activated.ok(), await activated.text()).toBeTruthy();

    // Next Monday, so every date is in one ISO week and none is in the past.
    const monday = new Date();
    monday.setUTCDate(monday.getUTCDate() + ((8 - monday.getUTCDay()) % 7 || 7));
    const dateOn = (offset: number) => {
      const date = new Date(monday);
      date.setUTCDate(date.getUTCDate() + offset);
      return date.toISOString().slice(0, 10);
    };

    await signInAdminOnPage(page);
    await gotoHydrated(page, '/admin/scheduling');
    await expect(page.getByRole('heading', { name: 'Scheduling' })).toBeVisible();

    // The directory is paged, so a doctor created seconds ago is not on the
    // first page of twenty-five. Searching is what an administrator with a
    // real roster has to do anyway — and the screen had no search until
    // writing this test proved it needed one.
    await page.getByPlaceholder(/name or mdc number/i).fill(doctor.mdcNumber);

    const doctorSelect = page.locator('select').first();
    const shiftSelect = page.locator('select').nth(1);
    const dateInput = page.locator('input[type="date"]');

    // The placeholder plus exactly one match, so the assertion fails if the
    // search silently matched nothing and left the full list in place.
    await expect(doctorSelect.locator('option')).toHaveCount(2, { timeout: 20_000 });

    async function assign(offset: number) {
      await doctorSelect.selectOption(doctor.publicId);
      await shiftSelect.selectOption('NIGHT');
      await dateInput.fill(dateOn(offset));
      await page.getByRole('button', { name: /assign shift/i }).click();
    }

    // Three nights: 36 of 40 hours, and the screen says so. The running total
    // is on screen for every assignment, not only the one that fails — a
    // ceiling you discover by hitting it is one you plan around badly.
    for (const day of [0, 1, 2]) {
      await assign(day);
      await expect(page.getByText(/shift assigned/i)).toBeVisible({ timeout: 20_000 });
    }
    await expect(page.getByText(/of a 40h weekly limit/i)).toBeVisible();

    // The fourth would be 48 hours in the same week.
    await assign(3);
    await expect(page.getByText(/this shift was not assigned/i)).toBeVisible({
      timeout: 20_000,
    });

    // And the ceiling is the API's, not this screen's opinion of it: the same
    // request made directly is refused identically (spec §92).
    const direct = await adminApi.post(`${API}/admin/shifts`, {
      headers: csrfHeaders(adminCsrf),
      data: { doctorPublicId: doctor.publicId, shiftCode: 'NIGHT', serviceDate: dateOn(4) },
    });
    expect(direct.ok(), 'the ceiling must hold when the screen is bypassed').toBeFalsy();
    expect(await direct.text()).toMatch(/40|week/i);

    await api.dispose();
    await adminApi.dispose();
  });

  /**
   * Scenario 15 — still pending, and this is the accurate reason.
   *
   * The old note said it "needs Phase 7 payment to drive it end to end".
   * Phase 7 landed; that is no longer true and was left stale for three
   * phases. The real obstacle is time.
   *
   * Suspension happens when `sweep-subscription-expiry` finds a membership
   * whose period has ended. That job runs on an hourly interval and has no
   * route that triggers it, deliberately — an endpoint that runs maintenance
   * on demand exists for nobody except a test, and inventing product surface
   * to make a test pass is how untrustworthy tests get written. Nor can this
   * suite move the clock: it drives a real server over HTTP.
   *
   * So the mechanism is covered where it can be covered honestly, with an
   * injected clock, in `membership.test.ts` — expiry, suspension, the exact
   * `statusReason` match, and the payment that lifts it. What is missing here
   * is only the browser, and a browser adds nothing to a job nobody watches
   * run.
   *
   * This stays `fixme` rather than being quietly deleted, because a scenario
   * that vanishes looks like coverage nobody thought about.
   */
  test.fixme('Scenario 15 — membership expires and the account is suspended', async () => {
    // Covered by apps/api/tests/integration/membership.test.ts with a fixed
    // clock. See the note above for why it is not driven through a browser.
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
    await card.getByRole('textbox').fill(DECISION_NOTE);
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
     * Looked for under **All**, not on the default view. The screen opens on
     * "Awaiting a decision", and a refund that has just been approved is by
     * definition no longer awaiting one — so its card leaves that list the
     * moment the query refetches.
     *
     * This assertion used to run against the default view and passed on a
     * race: it caught the card in the instant between the mutation settling
     * and the list refetching it away. Seeding a second refund changed the
     * timing and the race started losing, which is the only reason anyone
     * looked. A test that depends on observing something mid-flight is not
     * testing that the decision was recorded.
     *
     * Matched on the paragraph specifically: the same sentence sits in the
     * textarea it was typed into and in the paragraph that reads it back, so
     * an element-agnostic locator always resolves to two.
     */
    await page.getByRole('button', { name: 'All', exact: true }).click();

    const decided = page
      .locator('section')
      .filter({ hasText: publicId })
      .getByRole('paragraph')
      .filter({ hasText: DECISION_NOTE });

    await expect(decided).toBeVisible();

    await pharmacyApi.dispose();
  });
});
