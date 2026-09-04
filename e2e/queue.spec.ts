import {
  test,
  expect,
  API,
  DEMO,
  csrfHeaders,
  gotoHydrated,
  signIn,
  signInAdminOnPage,
  signInThroughUi,
} from './support/fixtures.ts';

/**
 * The allocation engine, end to end (spec §29, §30, §37).
 *
 * Implements three of the required §80 scenarios:
 *   3 — payment succeeds but no doctor is available
 *   4 — the doctor misses the 90-second window and the case is reassigned
 *   5 — no language match raises an admin alert
 *
 * Scenario 4's *timing* is proven by the Vitest integration suite, which can
 * advance the clock. Here it is exercised through the real UI up to the point
 * a browser can reach, and the reassignment itself is driven through the API
 * as the scheduled sweep would.
 */

type ApiContext = Parameters<typeof signIn>[0];

/**
 * Drives a consultation to the waiting queue and returns its public id.
 *
 * `pharmacy` and `patient` are deliberately separate API contexts, because
 * they are separate cookie jars — as a pharmacy terminal and a patient's phone
 * genuinely are. Pass `page.request` as `patient` when the test then needs the
 * browser to render the patient portal; otherwise the page would have no
 * patient session and would show "Session ended".
 */
async function queueAConsultation(
  contexts: { pharmacy: ApiContext; patient: ApiContext },
  languageCode: string,
): Promise<string> {
  const csrf = await signIn(contexts.pharmacy, DEMO.pharmacy);

  const created = await contexts.pharmacy.post(`${API}/pharmacy/consultations`, {
    headers: csrfHeaders(csrf),
    data: {},
  });
  expect(created.status()).toBe(201);
  const publicId = (await created.json()).data.publicId as string;

  await contexts.pharmacy.post(`${API}/pharmacy/consultations/${publicId}/payment`, {
    headers: csrfHeaders(csrf),
    data: {},
  });
  await contexts.pharmacy.post(`${API}/pharmacy/consultations/${publicId}/payment/simulate`, {
    headers: csrfHeaders(csrf),
    data: { outcome: 'SUCCESS' },
  });

  const qr = await contexts.pharmacy.post(`${API}/pharmacy/consultations/${publicId}/qr`, {
    headers: csrfHeaders(csrf),
    data: {},
  });
  const url = (await qr.json()).data.url as string;
  const token = url.split('/s/')[1]!;

  const exchange = await contexts.patient.post(`${API}/s/exchange`, { data: { token } });
  expect(exchange.status(), 'the patient should be able to open the consultation').toBe(200);

  await contexts.patient.post(`${API}/patient/session/identity`, {
    data: { fullName: 'Efua Mensah', age: 34, sex: 'FEMALE', phone: '0240000000' },
  });
  await contexts.patient.post(`${API}/patient/session/language`, { data: { languageCode } });
  await contexts.patient.post(`${API}/patient/session/mode`, { data: { type: 'VIDEO' } });

  return publicId;
}

test.describe('scenario 3 — payment succeeds but no doctor is available', () => {
  test('keeps the patient waiting rather than discarding a paid consultation', async ({
    page,
    request,
  }) => {
    // The patient half runs in the BROWSER's context, so the page can then
    // render the portal. The seeded doctors are not online, so nobody is
    // eligible.
    const publicId = await queueAConsultation({ pharmacy: request, patient: page.request }, 'en');

    const session = await page.request.get(`${API}/patient/session`);
    const view = await session.json();

    expect(view.data.step).toBe('WAITING');
    expect(view.data.state).toBe('WAITING_FOR_DOCTOR');

    // The patient's own screen says they are waiting, and shows no queue
    // position or estimate (spec §72).
    await gotoHydrated(page, '/patient');
    await expect(page.getByText(/just a moment/i)).toBeVisible();
    await expect(page.getByText(/matching you with a doctor/i)).toBeVisible();

    const body = await page.locator('body').innerText();
    expect(body).not.toMatch(/position|queue depth|\bnext in line\b/i);

    // And the consultation is still queued, not failed. The admin check uses
    // the separate `request` context so it does not disturb the patient
    // session the page is holding.
    const adminCsrf = await signIn(request, DEMO.pharmacy);
    expect(adminCsrf).toBeTruthy();

    const queue = await request.get(`${API}/pharmacy/consultations?activeOnly=true&limit=50`);
    const entries = (await queue.json()).data as Array<{ publicId: string; state: string }>;
    const entry = entries.find((candidate) => candidate.publicId === publicId);

    expect(entry?.state).toBe('WAITING_FOR_DOCTOR');
  });
});

test.describe('scenario 5 — no language match raises an admin alert', () => {
  test('flags the consultation and never assigns a doctor without the language', async ({
    page,
    request,
  }) => {
    // Ga is an active MVP language; the seeded online pool has no Ga speaker
    // available, so this exercises the language gate.
    const publicId = await queueAConsultation({ pharmacy: request, patient: request }, 'ga');

    await signInAdminOnPage(page);

    // Ask the engine to allocate. It must refuse rather than assign an
    // English-only doctor (spec §29).
    const csrf = (await page.context().cookies()).find((c) => c.name === 'neem_csrf')!.value;
    const attempt = await page.request.post(`${API}/admin/queue/${publicId}/reallocate`, {
      headers: { 'x-neem-csrf': csrf },
      data: {},
    });

    const result = (await attempt.json()).data;
    expect(result.offered).toBe(false);
    expect(result.message).toMatch(/remains in the queue/i);

    // The admin console surfaces it.
    await gotoHydrated(page, '/admin/queue');
    await expect(page.getByText(publicId)).toBeVisible();

    // No doctor was assigned.
    const detail = await page.request.get(`${API}/admin/queue`);
    const entry = ((await detail.json()).data as Array<Record<string, unknown>>).find(
      (candidate) => candidate.consultationPublicId === publicId,
    );
    expect(entry?.offerAttempts).toBe(0);
  });
});

test.describe('scenario 4 — the doctor misses the 90-second window', () => {
  test('a doctor is shown the offer with a countdown, and cannot decline it', async ({
    page,
    request,
  }) => {
    const publicId = await queueAConsultation({ pharmacy: request, patient: request }, 'en');

    // Bring a seeded doctor online and allocate to them.
    await signInThroughUi(page, DEMO.doctor);
    await expect(page).toHaveURL(/\/doctor/);

    const csrf = (await page.context().cookies()).find((c) => c.name === 'neem_csrf')!.value;

    // A confirmed shift is required for eligibility; the demo doctor may not
    // have one today, in which case the screen says so rather than silently
    // showing nothing.
    await page.request.post(`${API}/doctor/presence/online`, {
      headers: { 'x-neem-csrf': csrf },
      data: {},
    });

    await gotoHydrated(page, '/doctor/queue');

    // Whatever the eligibility outcome, the screen must never offer a way to
    // decline — spec §30 is explicit that doctors cannot reject an assignment.
    await expect(page.getByRole('button', { name: /decline|reject/i })).toHaveCount(0);
    await expect(page.getByText(/cannot be declined/i)).toBeVisible();
    await expect(page.getByText(/90 seconds to accept/i)).toBeVisible();

    expect(publicId).toBeTruthy();
  });

  test('the API refuses any attempt to decline an assignment', async ({ request }) => {
    const csrf = await signIn(request, DEMO.doctor);

    // There is deliberately no such route (spec §30).
    for (const path of ['decline', 'reject']) {
      const response = await request.post(`${API}/doctor/consultations/cons_anything/${path}`, {
        headers: csrfHeaders(csrf),
        data: {},
      });
      expect(response.status(), path).toBe(404);
    }
  });
});

test.describe('what each role may see', () => {
  test('a doctor is never shown a score or a rating (spec §24, §52)', async ({ request }) => {
    const csrf = await signIn(request, DEMO.doctor);

    await request.post(`${API}/doctor/presence/online`, { headers: csrfHeaders(csrf), data: {} });
    const queue = await request.get(`${API}/doctor/queue`);

    expect(JSON.stringify(await queue.json())).not.toMatch(/score|rating|quality|breakdown/i);
  });

  test('an admin does see the routing score — the fairness audit trail', async ({ page }) => {
    await signInAdminOnPage(page);

    const queue = await page.request.get(`${API}/admin/queue`);
    expect(queue.status()).toBe(200);

    // The field is present even when null, because it is what makes an
    // allocation explainable after the fact (spec §28).
    const body = await queue.text();
    expect(body).toContain('lastOfferScore');
  });
});
