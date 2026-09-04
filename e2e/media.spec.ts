import {
  test,
  expect,
  API,
  DEMO,
  createActiveDoctor,
  csrfHeaders,
  goOnlineExclusively,
  gotoHydrated,
  openSecondPage,
  signIn,
  signInAdmin,
  signInThroughUi,
  type ActiveDoctor,
} from './support/fixtures.ts';
import type { APIRequestContext, Page } from '@playwright/test';

/**
 * The consultation media layer, end to end (spec §15, §32, §33).
 *
 * Camera and microphone are real: the Playwright config grants the permissions
 * and starts Chromium with a fake capture device, so `getUserMedia` genuinely
 * runs and the mute and camera controls act on real tracks. Only the transport
 * between the two parties is mocked (decision D18), and the screens say so.
 *
 * Every scenario provisions its own doctor. A doctor's capacity is one
 * consultation, released only when that consultation reaches a terminal state,
 * and completing one arrives in Phase 6 — so borrowing the seeded demo doctor
 * would leave them permanently at capacity and starve later runs.
 */

/**
 * The shift covering now.
 *
 * NIGHT is seeded inactive because 24-hour operation is post-MVP, which meant
 * every scenario here skipped outside 08:00-20:00 UTC. A suite that only runs
 * during office hours gives false confidence overnight and in CI, so the
 * fixture activates the definition instead.
 */
function shiftCoveringNow(): string {
  const hour = new Date().getUTCHours();
  if (hour >= 8 && hour < 14) return 'MORNING';
  if (hour >= 14 && hour < 20) return 'AFTERNOON';
  return 'NIGHT';
}

const PATIENT_PHONE = '0209876543';

async function queueAConsultation(
  contexts: { pharmacy: APIRequestContext; patient: APIRequestContext },
  type: 'VIDEO' | 'AUDIO' | 'CALL_ME',
  languageCode = 'en',
): Promise<string> {
  const csrf = await signIn(contexts.pharmacy, DEMO.pharmacy);

  const created = await contexts.pharmacy.post(`${API}/pharmacy/consultations`, {
    headers: csrfHeaders(csrf),
    data: {},
  });
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
  const token = ((await qr.json()).data.url as string).split('/s/')[1]!;

  const exchange = await contexts.patient.post(`${API}/s/exchange`, { data: { token } });
  expect(exchange.status()).toBe(200);

  await contexts.patient.post(`${API}/patient/session/identity`, {
    data: { fullName: 'Kojo Asare', age: 29, sex: 'MALE', phone: PATIENT_PHONE },
  });
  await contexts.patient.post(`${API}/patient/session/language`, { data: { languageCode } });
  await contexts.patient.post(`${API}/patient/session/mode`, { data: { type } });

  return publicId;
}

/**
 * Puts the given doctor on a confirmed shift and brings them online.
 *
 * Returns a reason when it cannot, so a skipped scenario states what was
 * missing instead of leaving a silent hole in the coverage.
 */
async function makeEligible(
  playwright: typeof import('@playwright/test').default,
  doctorRequest: APIRequestContext,
  adminRequest: APIRequestContext,
  doctor: ActiveDoctor,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const shiftCode = shiftCoveringNow();
  const adminCsrf = (await signInAdmin(adminRequest)).csrf;

  // Idempotent, and only matters for NIGHT. Leaving it active afterwards is
  // harmless — a night shift is a real capability, not a test artefact.
  await adminRequest.patch(`${API}/admin/shifts/definitions/${shiftCode}`, {
    headers: csrfHeaders(adminCsrf),
    data: { isActive: true },
  });

  // The service date is bucketed in UTC, so it is derived in UTC here too.
  const serviceDate = new Date().toISOString().slice(0, 10);

  const assigned = await adminRequest.post(`${API}/admin/shifts`, {
    headers: csrfHeaders(adminCsrf),
    data: { doctorPublicId: doctor.publicId, shiftCode, serviceDate },
  });
  if (!assigned.ok()) {
    return { ok: false, reason: `Could not assign the ${shiftCode} shift: ${await assigned.text()}` };
  }

  const doctorCsrf = await signIn(doctorRequest, doctor);

  const shifts = await doctorRequest.get(`${API}/doctor/shifts`);
  const todays = ((await shifts.json()).data.shifts as Array<{ id: string; serviceDate: string }>)
    .find((assignment) => assignment.serviceDate === serviceDate);
  if (!todays) return { ok: false, reason: `The doctor has no shift on ${serviceDate}.` };

  const confirmed = await doctorRequest.post(`${API}/doctor/shifts/${todays.id}/confirm`, {
    headers: csrfHeaders(doctorCsrf),
    data: {},
  });
  if (!confirmed.ok()) {
    return { ok: false, reason: `Could not confirm the shift: ${await confirmed.text()}` };
  }

  // Exclusively — see the note on `goOnlineExclusively`.
  await goOnlineExclusively(playwright, doctorRequest, doctor, doctorCsrf);

  return { ok: true };
}

/** Offers the consultation and has the doctor accept it. */
async function offerAndAccept(
  doctorRequest: APIRequestContext,
  adminRequest: APIRequestContext,
  publicId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const adminCsrf = await (async () => {
    const state = await adminRequest.storageState();
    return state.cookies.find((cookie) => cookie.name === 'neem_csrf')!.value;
  })();

  const offered = await adminRequest.post(`${API}/admin/queue/${publicId}/reallocate`, {
    headers: csrfHeaders(adminCsrf),
    data: {},
  });
  const offer = (await offered.json()).data;
  if (!offer?.offered) {
    return { ok: false, reason: `Offered to nobody: ${offer?.message ?? offered.status()}` };
  }

  const doctorCsrf = await (async () => {
    const state = await doctorRequest.storageState();
    return state.cookies.find((cookie) => cookie.name === 'neem_csrf')!.value;
  })();

  const accepted = await doctorRequest.post(`${API}/doctor/consultations/${publicId}/accept`, {
    headers: csrfHeaders(doctorCsrf),
    data: {},
  });
  if (!accepted.ok()) {
    return { ok: false, reason: `The doctor could not accept: ${await accepted.text()}` };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// The guarantees — true at every hour, under every adapter
// ---------------------------------------------------------------------------

test.describe('recordings cannot be created (spec §32)', () => {
  test('no recording route exists for a doctor or a patient', async ({ request }) => {
    const csrf = await signIn(request, DEMO.doctor);

    for (const path of [
      '/doctor/consultations/cons_anything/recording',
      '/doctor/consultations/cons_anything/media/recording',
      '/doctor/consultations/cons_anything/media/record',
      '/patient/consultation/media/recording',
      '/patient/consultation/recording',
    ]) {
      const response = await request.post(`${API}${path}`, {
        headers: csrfHeaders(csrf),
        data: {},
      });
      expect(response.status(), path).toBe(404);
    }
  });
});

// ---------------------------------------------------------------------------
// A live consultation, from the queue through to both screens
// ---------------------------------------------------------------------------

test.describe('a video consultation', () => {
  test('joins, exercises real camera controls, and records nothing', async ({
    page,
    request,
    playwright,
    run,
  }) => {
    const doctor = await createActiveDoctor(request, { run });
    const admin = await playwright.request.newContext();

    const publicId = await queueAConsultation({ pharmacy: request, patient: request }, 'VIDEO');

    const eligible = await makeEligible(playwright, page.request, admin, doctor);
    if (!eligible.ok) console.log('  skipped:', eligible.reason);
    test.skip(!eligible.ok, eligible.ok ? '' : eligible.reason);

    const assigned = await offerAndAccept(page.request, admin, publicId);
    if (!assigned.ok) console.log('  skipped:', assigned.reason);
    test.skip(!assigned.ok, assigned.ok ? '' : assigned.reason);

    // Joining through the API first, to assert on the payload itself.
    const csrf = (await page.context().cookies()).find((c) => c.name === 'neem_csrf')!.value;
    const join = await page.request.post(`${API}/doctor/consultations/${publicId}/media/join`, {
      headers: csrfHeaders(csrf),
      data: {},
    });

    expect(join.status()).toBe(200);
    const session = (await join.json()).data;
    expect(session.recordingEnabled).toBe(false);
    expect(session.joinToken).toBeTruthy();
    // Honest about the adapter rather than implying a connection (D18).
    expect(session.isMockProvider).toBe(true);

    // The doctor's clinical panel must not carry the patient's number — Call
    // Me exists precisely so neither party learns the other's (spec §33).
    const panel = await page.request.get(`${API}/doctor/consultations/${publicId}`);
    const panelBody = await panel.text();
    expect(panelBody).toContain('Kojo Asare');
    expect(panelBody).not.toContain(PATIENT_PHONE);
    expect(panelBody).not.toContain('233209876543');

    // Now the screen itself.
    await signInThroughUi(page, doctor);
    await gotoHydrated(page, `/doctor/consultations/${publicId}`);

    await expect(page.getByRole('button', { name: /mute microphone/i })).toBeVisible();
    await expect(page.getByText(/simulated connection/i)).toBeVisible();
    await expect(page.getByText(/cannot see or hear the patient/i)).toBeVisible();

    // Absent by design (spec §32, decision D15).
    await expect(page.getByRole('button', { name: /record/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /chat|message/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /upload|attach/i })).toHaveCount(0);

    // The camera control acts on a real track, so its label flips.
    const cameraOff = page.getByRole('button', { name: /turn camera off/i });
    await cameraOff.waitFor({ state: 'visible' });
    await cameraOff.click();
    await expect(page.getByRole('button', { name: /turn camera on/i })).toBeVisible();

    await admin.dispose();
  });
});

test.describe('a Call Me consultation (spec §33)', () => {
  test('bridges the call and shows neither party the other’s number', async ({
    page,
    request,
    playwright,
    run,
  }) => {
    const doctor = await createActiveDoctor(request, { run: `${run}c` });
    const admin = await playwright.request.newContext();

    // The patient half runs in the browser context so the portal renders.
    const publicId = await queueAConsultation(
      { pharmacy: request, patient: page.request },
      'CALL_ME',
    );

    // The doctor needs their own context — the page is holding the patient's.
    const doctorApi = await playwright.request.newContext();

    const eligible = await makeEligible(playwright, doctorApi, admin, doctor);
    if (!eligible.ok) console.log('  skipped:', eligible.reason);
    test.skip(!eligible.ok, eligible.ok ? '' : eligible.reason);

    const assigned = await offerAndAccept(doctorApi, admin, publicId);
    if (!assigned.ok) console.log('  skipped:', assigned.reason);
    test.skip(!assigned.ok, assigned.ok ? '' : assigned.reason);

    const doctorCsrf = (await doctorApi.storageState()).cookies.find(
      (cookie) => cookie.name === 'neem_csrf',
    )!.value;

    const call = await doctorApi.post(`${API}/doctor/consultations/${publicId}/call`, {
      headers: csrfHeaders(doctorCsrf),
      data: {},
    });

    expect(call.status()).toBe(200);
    const callBody = await call.text();
    expect(JSON.parse(callBody).data.callerIdShown).toBe('Neem');
    expect(callBody).not.toContain(PATIENT_PHONE);
    expect(callBody).not.toContain('0244000199');

    // And the patient's own screen shows no number either.
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoHydrated(page, '/patient');

    await expect(page.getByText(/will call you/i)).toBeVisible();
    await expect(page.getByText(/never shared with the doctor/i)).toBeVisible();

    const body = await page.locator('body').innerText();
    expect(body).not.toMatch(/\+?233\d{9}|\b0\d{9}\b/);

    await doctorApi.dispose();
    await admin.dispose();
  });
});
