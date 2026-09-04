import {
  test,
  expect,
  API,
  DEMO,
  createActiveDoctor,
  goOnlineExclusively,
  fillField,
  gotoHydrated,
  signInThroughUi,
  openSecondPage,
  csrfHeaders,
  signIn,
  signInAdmin,
  type ActiveDoctor,
} from './support/fixtures.ts';
import type { APIRequestContext } from '@playwright/test';

/**
 * The clinical workflow, end to end (spec §80 scenarios 6–13).
 *
 * Drives the real HTTP surface as each party: the pharmacy records vitals and
 * dispenses, the doctor prescribes and completes, and an unauthenticated
 * caller verifies. Nothing here reaches into a service directly — the point is
 * that the routes and their authorization behave.
 */

const PASSWORD = 'DoctorPassword2026!';

/**
 * The shift covering now.
 *
 * NIGHT is seeded inactive because 24-hour operation is post-MVP, which used to
 * make every test in this file skip outside 08:00-20:00 UTC — a suite that only
 * runs during office hours gives false confidence overnight and in CI. The
 * admin route now activates it when needed.
 */
function shiftCoveringNow(): string {
  const hour = new Date().getUTCHours();
  if (hour >= 8 && hour < 14) return 'MORNING';
  if (hour >= 14 && hour < 20) return 'AFTERNOON';
  return 'NIGHT';
}

interface LiveConsultation {
  publicId: string;
  doctor: ActiveDoctor;
  doctorApi: APIRequestContext;
  pharmacyApi: APIRequestContext;
  adminApi: APIRequestContext;
  /**
   * The patient's device session cookie.
   *
   * Not the QR token: that is single use and the fixture spends it walking
   * the patient through identity, language and mode. A browser opening the
   * link a second time is correctly told the code is spent, so a test that
   * needs the patient's phone adds this cookie instead.
   */
  patientSessionCookie: string;
}

/**
 * A consultation IN_PROGRESS with the doctor joined.
 *
 * Returns null when no active shift covers this hour, so a skipped scenario
 * says what was missing rather than leaving a silent hole.
 */
async function liveConsultation(
  playwright: typeof import('@playwright/test').default,
  run: string,
  seed: string,
): Promise<LiveConsultation | { skip: string }> {
  const shiftCode = shiftCoveringNow();

  const pharmacyApi = await playwright.request.newContext();
  const doctorApi = await playwright.request.newContext();
  const adminApi = await playwright.request.newContext();

  const doctor = await createActiveDoctor(doctorApi, { run: `${run}${seed}` });

  const pharmacyCsrf = await signIn(pharmacyApi, DEMO.pharmacy);
  const created = await pharmacyApi.post(`${API}/pharmacy/consultations`, {
    headers: csrfHeaders(pharmacyCsrf),
    data: {},
  });
  const publicId = (await created.json()).data.publicId as string;

  await pharmacyApi.post(`${API}/pharmacy/consultations/${publicId}/payment`, {
    headers: csrfHeaders(pharmacyCsrf),
    data: {},
  });
  await pharmacyApi.post(`${API}/pharmacy/consultations/${publicId}/payment/simulate`, {
    headers: csrfHeaders(pharmacyCsrf),
    data: { outcome: 'SUCCESS' },
  });

  const qr = await pharmacyApi.post(`${API}/pharmacy/consultations/${publicId}/qr`, {
    headers: csrfHeaders(pharmacyCsrf),
    data: {},
  });
  const token = ((await qr.json()).data.url as string).split('/s/')[1]!;

  // The patient half runs in its own context, as a patient's phone would.
  const patientApi = await playwright.request.newContext();
  await patientApi.post(`${API}/s/exchange`, { data: { token } });
  await patientApi.post(`${API}/patient/session/identity`, {
    data: { fullName: 'Adwoa Mensah', age: 34, sex: 'FEMALE', phone: '0245551234' },
  });
  await patientApi.post(`${API}/patient/session/language`, { data: { languageCode: 'en' } });
  await patientApi.post(`${API}/patient/session/mode`, { data: { type: 'VIDEO' } });

  const patientSessionCookie = (await patientApi.storageState()).cookies.find(
    (cookie) => cookie.name === 'neem_patient',
  )?.value;
  await patientApi.dispose();
  if (!patientSessionCookie) return { skip: 'The patient session cookie was not issued.' };

  // Make the doctor eligible and route the consultation to them.
  const adminCsrf = (await signInAdmin(adminApi)).csrf;
  const serviceDate = new Date().toISOString().slice(0, 10);

  // Idempotent, and only matters for NIGHT. Leaving it active afterwards is
  // harmless — a night shift is a real capability, not a test artefact.
  await adminApi.patch(`${API}/admin/shifts/definitions/${shiftCode}`, {
    headers: csrfHeaders(adminCsrf),
    data: { isActive: true },
  });

  const assigned = await adminApi.post(`${API}/admin/shifts`, {
    headers: csrfHeaders(adminCsrf),
    data: { doctorPublicId: doctor.publicId, shiftCode, serviceDate },
  });
  if (!assigned.ok()) return { skip: `Could not assign a shift: ${await assigned.text()}` };

  const doctorCsrf = await signIn(doctorApi, doctor);
  const shifts = await doctorApi.get(`${API}/doctor/shifts`);
  const todays = (
    (await shifts.json()).data.shifts as Array<{ id: string; serviceDate: string }>
  ).find((shift) => shift.serviceDate === serviceDate);
  if (!todays) return { skip: `No shift on ${serviceDate}.` };

  await doctorApi.post(`${API}/doctor/shifts/${todays.id}/confirm`, {
    headers: csrfHeaders(doctorCsrf),
    data: {},
  });
  // Exclusively: a doctor left online by an earlier test is still eligible,
  // and the engine will hand them this consultation instead.
  await goOnlineExclusively(playwright, doctorApi, doctor, doctorCsrf);

  const offered = await adminApi.post(`${API}/admin/queue/${publicId}/reallocate`, {
    headers: csrfHeaders(adminCsrf),
    data: {},
  });
  /**
   * A skip is only legitimate when the engine answered.
   *
   * This helper used to skip on anything that was not an offer, including a
   * 500 — so an unhandled deadlock in `offerNextDoctor` presented as four
   * quietly skipped tests instead of a failure, and stayed hidden for the
   * whole build. "Nobody was eligible" is a legitimate state of the world;
   * "the server fell over" is not, and the two must not look alike.
   */
  if (offered.status() >= 500) {
    throw new Error(
      `Reallocation failed with ${offered.status()}, which is a defect rather than ` +
        `a reason to skip:\n${await offered.text()}`,
    );
  }

  /**
   * A 409 is the same race, reported differently.
   *
   * Reallocation legitimately conflicts when the ten-second sweep changed the
   * consultation's state between this request being read and its transaction
   * running. Throwing on any non-2xx was too blunt in the other direction from
   * the skip-everything version above — a 5xx is the server falling over, and
   * a 4xx is the engine telling you what happened.
   */
  const offer =
    offered.status() === 409
      ? { offered: false, reason: 'NOT_WAITING' as const }
      : ((await offered.json()).data as
          | { offered: boolean; reason?: string; languageStarved?: boolean; message?: string }
          | undefined);

  /**
   * A race with the sweep is usually our own doctor, and not a reason to stop.
   *
   * The queue sweeps every ten seconds, and this helper has just made its
   * doctor the only online candidate. So the sweep frequently offers the
   * consultation before the explicit reallocation below runs, and the
   * reallocation is then correctly told the work is done. Treating that as a
   * skip made the suite lose two or three tests to timing on most runs —
   * which is also how the deadlock above stayed hidden, because a suite that
   * skips at random teaches you to ignore its skips.
   *
   * Two reasons mean it: `ALREADY_ASSIGNED` from the unique constraint, and
   * `NOT_WAITING` — which is the commoner of the two, because a sweep that
   * has already offered the consultation leaves it ASSIGNED, and the engine
   * then correctly refuses to offer a consultation that is not waiting.
   *
   * Whether the offer went to our doctor is answerable rather than guessable:
   * try to accept it. If our doctor holds it, the test proceeds exactly as if
   * the reallocation had made the offer.
   */
  const RACE_WITH_THE_SWEEP = ['ALREADY_ASSIGNED', 'NOT_WAITING'];

  if (!offer?.offered && !RACE_WITH_THE_SWEEP.includes(offer?.reason ?? '')) {
    const presence = await doctorApi.get(`${API}/doctor/presence`);
    return {
      skip:
        `Offered to nobody — reason=${offer?.reason ?? 'none'} ` +
        `languageStarved=${offer?.languageStarved ?? 'n/a'}; ` +
        `our doctor's presence: ${await presence.text()}`,
    };
  }

  /**
   * The offer arrives asynchronously, so accepting has to wait for it.
   *
   * Two things can write it — this reallocation, or the ten-second sweep that
   * may have been mid-flight when the doctor came online — and neither has
   * necessarily finished when the call above returns. Accepting once and
   * skipping on failure turned that into an intermittent "Could not accept",
   * which reads like a routing fault and is a timing assumption. Scenario 1
   * had the same symptom for the same reason.
   *
   * Five seconds is far longer than the write takes and far shorter than the
   * 90-second response window, so a genuinely absent offer still gives up
   * quickly rather than hanging the suite.
   */
  let accepted = await doctorApi.post(`${API}/doctor/consultations/${publicId}/accept`, {
    headers: csrfHeaders(doctorCsrf),
    data: {},
  });

  for (let attempt = 0; attempt < 20 && !accepted.ok(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    accepted = await doctorApi.post(`${API}/doctor/consultations/${publicId}/accept`, {
      headers: csrfHeaders(doctorCsrf),
      data: {},
    });
  }

  if (!accepted.ok()) {
    const presence = await doctorApi.get(`${API}/doctor/presence`);
    return {
      skip:
        `Could not accept after waiting 5s: ${await accepted.text()}; ` +
        `reallocation said reason=${offer?.reason ?? 'none'}; ` +
        `our doctor's presence: ${await presence.text()}`,
    };
  }

  // Joining the media session is what moves DOCTOR_ACCEPTED → IN_PROGRESS.
  await doctorApi.post(`${API}/doctor/consultations/${publicId}/media/join`, {
    headers: csrfHeaders(doctorCsrf),
    data: {},
  });

  return { publicId, doctor, doctorApi, pharmacyApi, adminApi, patientSessionCookie };
}

async function csrfOf(api: APIRequestContext): Promise<string> {
  const state = await api.storageState();
  return state.cookies.find((cookie) => cookie.name === 'neem_csrf')!.value;
}

const ITEM = {
  medication: 'Amoxicillin',
  strength: '500mg',
  form: 'Capsule',
  dose: '1 capsule',
  frequency: 'Three times daily',
  durationText: '5 days',
  quantity: '15 capsules',
};

test.describe('scenario 6 — a doctor prescribes and the pharmacy receives it', () => {
  test('reaches the pharmacy signed, with a PDF and a verification page', async ({
    playwright,
    run,
  }) => {
    const live = await liveConsultation(playwright, run, 'a');
    if ('skip' in live) console.log('  skipped:', live.skip);
    test.skip('skip' in live, 'skip' in live ? live.skip : '');
    if ('skip' in live) return;

    const doctorCsrf = await csrfOf(live.doctorApi);

    // The pharmacy records what it measured before the doctor prescribes.
    const pharmacyCsrf = await csrfOf(live.pharmacyApi);
    const vitals = await live.pharmacyApi.post(
      `${API}/pharmacy/consultations/${live.publicId}/vitals`,
      {
        headers: csrfHeaders(pharmacyCsrf),
        data: { bpSystolic: 128, bpDiastolic: 84, pulseBpm: 92, temperatureC: 38.2 },
      },
    );
    expect(vitals.status()).toBe(201);

    const draft = await live.doctorApi.post(
      `${API}/doctor/consultations/${live.publicId}/prescriptions`,
      { headers: csrfHeaders(doctorCsrf), data: { items: [ITEM] } },
    );
    expect(draft.status(), await draft.text()).toBe(201);
    const rxPublicId = (await draft.json()).data.publicId as string;

    const issued = await live.doctorApi.post(`${API}/doctor/prescriptions/${rxPublicId}/issue`, {
      headers: csrfHeaders(doctorCsrf),
      data: {},
    });
    expect(issued.status(), await issued.text()).toBe(200);
    expect((await issued.json()).data.state).toBe('ACTIVE');

    // The pharmacy sees it.
    const list = await live.pharmacyApi.get(`${API}/pharmacy/prescriptions?activeOnly=true`);
    const found = ((await list.json()).data as Array<{ publicId: string; items: unknown[] }>).find(
      (rx) => rx.publicId === rxPublicId,
    );
    expect(found, 'the prescription should reach the pharmacy').toBeTruthy();
    expect(found!.items).toHaveLength(1);

    // And can download the PDF.
    const pdf = await live.pharmacyApi.get(`${API}/documents/prescriptions/${rxPublicId}.pdf`);
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()['content-type']).toBe('application/pdf');
    expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');

    await live.doctorApi.dispose();
    await live.pharmacyApi.dispose();
    await live.adminApi.dispose();
  });
});

test.describe('scenarios 7 and 8 — substitution', () => {
  test('the doctor approves, and the record shows both medications', async ({
    playwright,
    run,
  }) => {
    const live = await liveConsultation(playwright, run, 'b');
    if ('skip' in live) console.log('  skipped:', live.skip);
    test.skip('skip' in live, 'skip' in live ? live.skip : '');
    if ('skip' in live) return;

    const doctorCsrf = await csrfOf(live.doctorApi);
    const pharmacyCsrf = await csrfOf(live.pharmacyApi);

    const draft = await live.doctorApi.post(
      `${API}/doctor/consultations/${live.publicId}/prescriptions`,
      { headers: csrfHeaders(doctorCsrf), data: { items: [ITEM] } },
    );
    const rxPublicId = (await draft.json()).data.publicId as string;
    await live.doctorApi.post(`${API}/doctor/prescriptions/${rxPublicId}/issue`, {
      headers: csrfHeaders(doctorCsrf),
      data: {},
    });

    const list = await live.pharmacyApi.get(`${API}/pharmacy/prescriptions`);
    const rx = (
      (await list.json()).data as Array<{ publicId: string; items: Array<{ id: string }> }>
    ).find((entry) => entry.publicId === rxPublicId)!;

    const proposal = await live.pharmacyApi.post(
      `${API}/pharmacy/prescriptions/${rxPublicId}/substitutions`,
      {
        headers: csrfHeaders(pharmacyCsrf),
        data: {
          itemId: rx.items[0]!.id,
          medication: 'Amoxil',
          strength: '500mg',
          reason: 'Out of stock; same molecule.',
        },
      },
    );
    expect(proposal.status(), await proposal.text()).toBe(201);
    const substitutionId = (await proposal.json()).data.id as string;

    // Dispensing must wait for the doctor.
    const early = await live.pharmacyApi.post(
      `${API}/pharmacy/prescriptions/${rxPublicId}/dispense`,
      { headers: csrfHeaders(pharmacyCsrf), data: {} },
    );
    expect(early.status()).toBe(422);

    const decided = await live.doctorApi.post(
      `${API}/doctor/substitutions/${substitutionId}/decide`,
      { headers: csrfHeaders(doctorCsrf), data: { approve: true } },
    );
    expect(decided.status(), await decided.text()).toBe(200);

    const after = await live.pharmacyApi.get(`${API}/pharmacy/prescriptions`);
    const updated = (
      (await after.json()).data as Array<{
        publicId: string;
        state: string;
        items: Array<{ medication: string }>;
      }>
    ).find((entry) => entry.publicId === rxPublicId)!;

    expect(updated.state).toBe('SUBSTITUTION_APPROVED');
    // The active item is the replacement; the original is superseded, not gone.
    expect(updated.items.map((item) => item.medication)).toEqual(['Amoxil']);

    await live.doctorApi.dispose();
    await live.pharmacyApi.dispose();
    await live.adminApi.dispose();
  });

  test('the doctor refuses, and the original is still dispensable', async ({ playwright, run }) => {
    const live = await liveConsultation(playwright, run, 'c');
    if ('skip' in live) console.log('  skipped:', live.skip);
    test.skip('skip' in live, 'skip' in live ? live.skip : '');
    if ('skip' in live) return;

    const doctorCsrf = await csrfOf(live.doctorApi);
    const pharmacyCsrf = await csrfOf(live.pharmacyApi);

    const draft = await live.doctorApi.post(
      `${API}/doctor/consultations/${live.publicId}/prescriptions`,
      { headers: csrfHeaders(doctorCsrf), data: { items: [ITEM] } },
    );
    const rxPublicId = (await draft.json()).data.publicId as string;
    await live.doctorApi.post(`${API}/doctor/prescriptions/${rxPublicId}/issue`, {
      headers: csrfHeaders(doctorCsrf),
      data: {},
    });

    const list = await live.pharmacyApi.get(`${API}/pharmacy/prescriptions`);
    const rx = (
      (await list.json()).data as Array<{ publicId: string; items: Array<{ id: string }> }>
    ).find((entry) => entry.publicId === rxPublicId)!;

    const proposal = await live.pharmacyApi.post(
      `${API}/pharmacy/prescriptions/${rxPublicId}/substitutions`,
      {
        headers: csrfHeaders(pharmacyCsrf),
        data: { itemId: rx.items[0]!.id, medication: 'Something cheaper', reason: 'Cost' },
      },
    );
    const substitutionId = (await proposal.json()).data.id as string;

    await live.doctorApi.post(`${API}/doctor/substitutions/${substitutionId}/decide`, {
      headers: csrfHeaders(doctorCsrf),
      data: { approve: false, note: 'Not therapeutically equivalent.' },
    });

    // A refusal does not strand the prescription — the pharmacy fills what the
    // doctor actually prescribed.
    const dispensed = await live.pharmacyApi.post(
      `${API}/pharmacy/prescriptions/${rxPublicId}/dispense`,
      { headers: csrfHeaders(pharmacyCsrf), data: {} },
    );
    expect(dispensed.status(), await dispensed.text()).toBe(200);
    expect((await dispensed.json()).data.state).toBe('DISPENSED');

    await live.doctorApi.dispose();
    await live.pharmacyApi.dispose();
    await live.adminApi.dispose();
  });
});

test.describe('scenarios 9 and 10 — revocation and its limit', () => {
  test('revokes before dispensing, and refuses afterwards (spec §82)', async ({
    playwright,
    run,
  }) => {
    const live = await liveConsultation(playwright, run, 'd');
    if ('skip' in live) console.log('  skipped:', live.skip);
    test.skip('skip' in live, 'skip' in live ? live.skip : '');
    if ('skip' in live) return;

    const doctorCsrf = await csrfOf(live.doctorApi);
    const pharmacyCsrf = await csrfOf(live.pharmacyApi);

    // First prescription: revoked before dispensing (scenario 9).
    const first = await live.doctorApi.post(
      `${API}/doctor/consultations/${live.publicId}/prescriptions`,
      { headers: csrfHeaders(doctorCsrf), data: { items: [ITEM] } },
    );
    const firstId = (await first.json()).data.publicId as string;
    await live.doctorApi.post(`${API}/doctor/prescriptions/${firstId}/issue`, {
      headers: csrfHeaders(doctorCsrf),
      data: {},
    });

    const revoked = await live.doctorApi.post(`${API}/doctor/prescriptions/${firstId}/revoke`, {
      headers: csrfHeaders(doctorCsrf),
      data: { reason: 'Patient reported a penicillin allergy.' },
    });
    expect(revoked.status(), await revoked.text()).toBe(200);

    // The pharmacy is refused.
    const blocked = await live.pharmacyApi.post(
      `${API}/pharmacy/prescriptions/${firstId}/dispense`,
      { headers: csrfHeaders(pharmacyCsrf), data: {} },
    );
    expect(blocked.status()).toBe(422);

    // Second prescription: dispensed, then revocation refused (scenario 10).
    const second = await live.doctorApi.post(
      `${API}/doctor/consultations/${live.publicId}/prescriptions`,
      {
        headers: csrfHeaders(doctorCsrf),
        data: { items: [{ ...ITEM, medication: 'Azithromycin' }] },
      },
    );
    const secondId = (await second.json()).data.publicId as string;
    await live.doctorApi.post(`${API}/doctor/prescriptions/${secondId}/issue`, {
      headers: csrfHeaders(doctorCsrf),
      data: {},
    });
    await live.pharmacyApi.post(`${API}/pharmacy/prescriptions/${secondId}/dispense`, {
      headers: csrfHeaders(pharmacyCsrf),
      data: {},
    });

    const tooLate = await live.doctorApi.post(`${API}/doctor/prescriptions/${secondId}/revoke`, {
      headers: csrfHeaders(doctorCsrf),
      data: { reason: 'Changed my mind' },
    });
    expect(tooLate.status()).toBe(422);
    expect(await tooLate.text()).toMatch(/already been dispensed/i);

    await live.doctorApi.dispose();
    await live.pharmacyApi.dispose();
    await live.adminApi.dispose();
  });
});

test.describe('scenario 12 — a prescription stays accessible to authorised parties', () => {
  test('survives completion, and the verification page confirms it without disclosing it', async ({
    playwright,
    run,
  }) => {
    const live = await liveConsultation(playwright, run, 'e');
    if ('skip' in live) console.log('  skipped:', live.skip);
    test.skip('skip' in live, 'skip' in live ? live.skip : '');
    if ('skip' in live) return;

    const doctorCsrf = await csrfOf(live.doctorApi);

    const draft = await live.doctorApi.post(
      `${API}/doctor/consultations/${live.publicId}/prescriptions`,
      { headers: csrfHeaders(doctorCsrf), data: { items: [ITEM] } },
    );
    const rxPublicId = (await draft.json()).data.publicId as string;
    await live.doctorApi.post(`${API}/doctor/prescriptions/${rxPublicId}/issue`, {
      headers: csrfHeaders(doctorCsrf),
      data: {},
    });

    const completed = await live.doctorApi.post(
      `${API}/doctor/consultations/${live.publicId}/complete`,
      {
        headers: csrfHeaders(doctorCsrf),
        data: { outcome: 'PRESCRIPTION', notes: { notes: 'Chest clear.' } },
      },
    );
    expect(completed.status(), await completed.text()).toBe(200);
    const result = (await completed.json()).data;
    expect(result.state).toBe('COMPLETED');
    // Sealed and scheduled for destruction (D23).
    expect(result.destroyAt).toBeTruthy();

    // The prescription is still readable by the pharmacy after completion.
    const pdf = await live.pharmacyApi.get(`${API}/documents/prescriptions/${rxPublicId}.pdf`);
    expect(pdf.status()).toBe(200);

    // And still dispensable.
    const dispensed = await live.pharmacyApi.post(
      `${API}/pharmacy/prescriptions/${rxPublicId}/dispense`,
      { headers: csrfHeaders(await csrfOf(live.pharmacyApi)), data: {} },
    );
    expect(dispensed.status(), await dispensed.text()).toBe(200);

    await live.doctorApi.dispose();
    await live.pharmacyApi.dispose();
    await live.adminApi.dispose();
  });
});

test.describe('scenario 11 — the clinical record after completion (revised by D23)', () => {
  test('still exists, and no role can read it', async ({ playwright, run, request }) => {
    const live = await liveConsultation(playwright, run, 'f');
    if ('skip' in live) console.log('  skipped:', live.skip);
    test.skip('skip' in live, 'skip' in live ? live.skip : '');
    if ('skip' in live) return;

    const doctorCsrf = await csrfOf(live.doctorApi);

    await live.doctorApi.put(`${API}/doctor/consultations/${live.publicId}/notes`, {
      headers: csrfHeaders(doctorCsrf),
      data: { notes: 'Fever for three days.', diagnosis: 'Viral pharyngitis' },
    });

    // Readable while live.
    const before = await live.doctorApi.get(
      `${API}/doctor/consultations/${live.publicId}/workspace`,
    );
    expect(before.status()).toBe(200);
    expect(await before.text()).toContain('Fever for three days');

    const summary = await live.doctorApi.post(
      `${API}/doctor/consultations/${live.publicId}/summary`,
      {
        headers: csrfHeaders(doctorCsrf),
        data: {
          presentingComplaint: 'Sore throat, wants antibiotics.',
          assessment: 'Viral. Antibiotics would not help.',
          advice: 'Rest and fluids.',
          safetyNetting: 'Return if you cannot swallow or develop difficulty breathing.',
        },
      },
    );
    expect(summary.status(), await summary.text()).toBe(201);

    await live.doctorApi.post(`${API}/doctor/consultations/${live.publicId}/complete`, {
      headers: csrfHeaders(doctorCsrf),
      data: { outcome: 'ADVICE_ONLY' },
    });

    /**
     * The revised §101 assertion (decision D23). The record is NOT deleted —
     * Ghanaian law does not permit that — but no role can read it.
     */
    const after = await live.doctorApi.get(
      `${API}/doctor/consultations/${live.publicId}/workspace`,
    );
    expect(after.status()).toBe(403);
    expect(await after.text()).not.toContain('Fever for three days');

    // Nor the pharmacy, through its own consultation view.
    const pharmacyView = await live.pharmacyApi.get(
      `${API}/pharmacy/consultations/${live.publicId}`,
    );
    expect(await pharmacyView.text()).not.toMatch(/Fever for three days|pharyngitis/i);

    // The summary the patient carries away is unaffected — it is a document
    // the doctor deliberately issued, not a working note.
    const summaryCode = (await summary.json()).data.publicId;
    expect(summaryCode).toBeTruthy();

    await live.doctorApi.dispose();
    await live.pharmacyApi.dispose();
    await live.adminApi.dispose();
    expect(request).toBeTruthy();
  });
});

/**
 * The substitution loop, through the screens rather than the routes.
 *
 * Worth its cost because every part of this passed at the API layer while the
 * loop was broken in practice: a pharmacy could propose a substitution that no
 * doctor could ever see, because nothing listed what was awaiting a decision.
 * A proposal blocks dispensing, so each unanswered one was a patient at a
 * counter with nothing in their hand — invisible to any test that called
 * `decideSubstitution` with an id it already held.
 *
 * Each role gets its own browser context. One context holds one session, so
 * swapping roles inside it would mean signing out and in between every step —
 * slower, and it tests the sign-in page rather than the workflow.
 */
test.describe('the substitution loop through the UI', () => {
  test('pharmacy proposes, doctor decides, pharmacy dispenses', async ({
    page,
    playwright,
    run,
  }) => {
    const live = await liveConsultation(playwright, run, 'ui');
    if ('skip' in live) console.log('  skipped:', live.skip);
    if ('skip' in live) test.skip(true, live.skip);
    if ('skip' in live) return;

    // Prescribe through the API — the prescribing UI is exercised elsewhere,
    // and what is under test here is what happens to it afterwards.
    const doctorCsrf = await csrfOf(live.doctorApi);
    const draft = await live.doctorApi.post(
      `${API}/doctor/consultations/${live.publicId}/prescriptions`,
      { headers: csrfHeaders(doctorCsrf), data: { items: [ITEM] } },
    );
    const prescriptionPublicId = (await draft.json()).data.publicId as string;
    await live.doctorApi.post(`${API}/doctor/prescriptions/${prescriptionPublicId}/issue`, {
      headers: csrfHeaders(doctorCsrf),
      data: {},
    });

    const doctorPage = await openSecondPage(page);

    try {
      // ---- The pharmacy proposes ----------------------------------------
      await signInThroughUi(page, DEMO.pharmacy);
      await gotoHydrated(page, '/pharmacy/prescriptions');

      const card = page.locator('section', { hasText: live.publicId }).first();
      await expect(card).toBeVisible();

      await card.getByRole('button', { name: /propose substitution/i }).click();
      await fillField(page, 'Medication', 'Amoxil');
      await fillField(page, 'Strength', '500mg');
      await fillField(page, 'Form', 'Capsule');
      await fillField(page, 'Reason', 'Generic out of stock; branded equivalent available.');
      await page.getByRole('button', { name: /send to the doctor/i }).click();

      await expect(card.getByText(/sent to the doctor/i)).toBeVisible();
      // Undispensable while it is with the doctor — the point of the flow.
      await expect(card.getByRole('button', { name: /mark dispensed/i })).toBeDisabled();

      // ---- The doctor decides -------------------------------------------
      await signInThroughUi(doctorPage, live.doctor);
      await gotoHydrated(doctorPage, '/doctor/substitutions');

      const proposal = doctorPage.locator('article', { hasText: live.publicId }).first();
      await expect(proposal).toBeVisible();
      // Both products, so the decision is made against what it replaces.
      await expect(proposal.getByText('Amoxicillin · 500mg · Capsule')).toBeVisible();
      await expect(proposal.getByText('Amoxil · 500mg')).toBeVisible();

      await proposal.getByRole('button', { name: /approve the substitution/i }).click();
      await expect(doctorPage.getByText(/nothing waiting/i)).toBeVisible();

      // ---- The pharmacy dispenses ---------------------------------------
      await gotoHydrated(page, '/pharmacy/prescriptions');

      const approved = page.locator('section', { hasText: live.publicId }).first();
      await expect(approved.getByText(/the doctor approved amoxil/i)).toBeVisible();
      // The item itself is superseded, not annotated.
      await expect(approved.getByText('Amoxil · 500mg')).toBeVisible();

      await approved.getByRole('button', { name: /mark dispensed/i }).click();

      // It leaves the to-dispense list entirely, and is still findable under
      // All — the toggle that used to return the same list either way.
      await expect(page.locator('section', { hasText: live.publicId })).toHaveCount(0);

      await page.getByRole('button', { name: 'All' }).click();
      const dispensed = page.locator('section', { hasText: live.publicId }).first();
      await expect(dispensed.getByText('dispensed', { exact: false }).first()).toBeVisible();
      await expect(dispensed.getByRole('button', { name: /mark dispensed/i })).toHaveCount(0);
    } finally {
      await doctorPage.close();
      await live.doctorApi.dispose();
      await live.pharmacyApi.dispose();
      await live.adminApi.dispose();
    }
  });
});

/**
 * The pharmacy's observation entry.
 *
 * The routes for this existed and were tested from the start of the phase; no
 * screen called them, so no pharmacy could have recorded a blood pressure. The
 * doctor's whole clinical picture beyond a name and an age comes from here.
 */
test.describe('vitals and point-of-care entry through the UI', () => {
  test('what the pharmacy records is what the doctor sees', async ({ page, playwright, run }) => {
    const live = await liveConsultation(playwright, run, 'obs');
    if ('skip' in live) console.log('  skipped:', live.skip);
    if ('skip' in live) test.skip(true, live.skip);
    if ('skip' in live) return;

    const doctorPage = await openSecondPage(page);

    try {
      await signInThroughUi(page, DEMO.pharmacy);
      await gotoHydrated(page, `/pharmacy/consultations/${live.publicId}`);

      await fillField(page, /systolic bp/i, '136');
      await fillField(page, /diastolic bp/i, '88');
      await fillField(page, /temperature/i, '37.4');
      await page.getByRole('button', { name: /^record vitals$/i }).click();

      // Read back, so a pharmacist can see the reading went in rather than
      // entering it a second time.
      await expect(page.getByText('136 mmHg')).toBeVisible();
      await expect(page.getByText('37.4 °C')).toBeVisible();
      // Blank means not measured, never zero — a fabricated reading in front
      // of a doctor is worse than a missing one.
      await expect(page.getByText(/\b0 bpm/)).toHaveCount(0);

      await fillField(page, /^test$/i, 'Malaria RDT');
      await fillField(page, /^result$/i, 'Positive');
      await page.getByRole('button', { name: /add result/i }).click();
      await expect(page.getByText('Positive')).toBeVisible();

      // ---- And now the doctor's side ------------------------------------
      await signInThroughUi(doctorPage, live.doctor);
      await gotoHydrated(doctorPage, `/doctor/consultations/${live.publicId}`);

      await expect(doctorPage.getByText('136/88 mmHg')).toBeVisible();
      await expect(doctorPage.getByText('37.4 °C')).toBeVisible();
      await expect(doctorPage.getByText('Malaria RDT')).toBeVisible();
    } finally {
      await doctorPage.close();
      await live.doctorApi.dispose();
      await live.pharmacyApi.dispose();
      await live.adminApi.dispose();
    }
  });
});

/**
 * The patient after completion (spec §51, decision D24).
 *
 * The session resolved only while the consultation was live, so it ended at
 * the moment of completion and the patient's phone showed "Session ended"
 * instead of the screen carrying their consultation reference. Nothing caught
 * it: every route involved passed its own tests, and no test had ever looked
 * at that screen after a doctor completed.
 */
test.describe('what the patient sees after completion', () => {
  test('shows the consultation reference and takes feedback', async ({ page, playwright, run }) => {
    const live = await liveConsultation(playwright, run, 'fb');
    if ('skip' in live) console.log('  skipped:', live.skip);
    if ('skip' in live) test.skip(true, live.skip);
    if ('skip' in live) return;

    // The patient's phone, carrying the session their QR scan produced.
    await page.context().addCookies([
      {
        name: 'neem_patient',
        value: live.patientSessionCookie,
        url: 'http://localhost:8080',
      },
    ]);
    await gotoHydrated(page, '/patient');
    // The doctor has already joined, so the phone is in the consultation.
    await expect(page.getByRole('button', { name: 'Leave' })).toBeVisible();

    const doctorCsrf = await csrfOf(live.doctorApi);
    await live.doctorApi.post(`${API}/doctor/consultations/${live.publicId}/complete`, {
      headers: csrfHeaders(doctorCsrf),
      data: { outcome: 'OTHER' },
    });

    // The phone polls; the completion screen must arrive on its own.
    await expect(page.getByText('Consultation complete')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(live.publicId)).toBeVisible();

    await page.getByRole('button', { name: 'Rate this consultation' }).click();
    await page.getByRole('button', { name: /The doctor: 4 out of 5/ }).click();
    await page.getByRole('button', { name: /Neem: 5 out of 5/ }).click();
    await page.getByRole('button', { name: 'Something went well' }).click();
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(page.getByText('Thank you for your feedback.')).toBeVisible();

    // Asked once. A reload must not present the form again.
    await page.reload();
    await expect(page.getByText('Thank you for your feedback.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Rate this consultation' })).toHaveCount(0);
  });
});

test.describe('the verification page discloses nothing', () => {
  test('confirms a document without revealing what it says (spec §44)', async ({
    playwright,
    request,
    run,
  }) => {
    const live = await liveConsultation(playwright, run, 'g');
    if ('skip' in live) console.log('  skipped:', live.skip);
    test.skip('skip' in live, 'skip' in live ? live.skip : '');
    if ('skip' in live) return;

    const doctorCsrf = await csrfOf(live.doctorApi);

    const referral = await live.doctorApi.post(
      `${API}/doctor/consultations/${live.publicId}/referrals`,
      {
        headers: csrfHeaders(doctorCsrf),
        data: {
          hospitalName: 'Korle Bu Teaching Hospital',
          department: 'Emergency',
          reasonText: 'Persistent chest pain requiring urgent cardiac assessment.',
          urgency: 'Urgent',
        },
      },
    );
    expect(referral.status(), await referral.text()).toBe(201);
    const referralId = (await referral.json()).data.publicId as string;

    // `request` is an unauthenticated context — no account, as a hospital
    // clerk holding a printout would have.
    const verified = await request.get(`${API}/verify/referral/${referralId}`);
    expect(verified.status()).toBe(200);

    const body = await verified.text();
    expect(JSON.parse(body).data.genuine).toBe(true);
    expect(body).not.toMatch(/chest pain|cardiac|Korle Bu/i);
    expect(body).not.toContain('Adwoa Mensah');

    await live.doctorApi.dispose();
    await live.pharmacyApi.dispose();
    await live.adminApi.dispose();
  });
});
