import type { Page } from '@playwright/test';
import { authenticator } from 'otplib';
import {
  API,
  csrfHeaders,
  expect,
  fillField,
  gotoHydrated,
  openSecondPage,
  signInAdmin,
  signInThroughUi,
  signOutThroughUi,
  takeOtherDoctorsOffline,
  test,
} from './support/fixtures.ts';
import {
  aDistrict,
  acceptOnQueue,
  assertMessagesAreMocked,
  chooseOption,
  createCompound,
  createFacility,
  documentAndComplete,
  doctorOnline,
  fillRegistration,
  pairStation,
  registerWalkIn,
  requestDoctor,
  setPasswordFromLink,
  triage,
  withdrawOpenRequests,
} from './support/chps.ts';

/**
 * The CHPS acceptance scenarios (brief §13, docs/v2-chps-plan.md §5).
 *
 * The milestone for Phases 1 and 2: each scenario walked across the screens of
 * the people in it, against the mock media provider. A real call on a real
 * tablet is the other half of that milestone and cannot be done from here.
 */

test.beforeAll(async ({ playwright }) => {
  const api = await playwright.request.newContext();
  await assertMessagesAreMocked(api);
  await api.dispose();
});

// A request left waiting would be offered to the next test's doctor.
test.afterEach(async ({ page }) => {
  await withdrawOpenRequests(page);
});

test.describe('CHPS scenarios', () => {
  test('Scenario 1: a walk-in sees a doctor on the facility tablet, with no phone or booking', async ({
    page,
    request,
    playwright,
    run,
  }) => {
    const compound = await createCompound(request, run);
    const adminApi = await playwright.request.newContext();
    const doctor = await doctorOnline(playwright, request, adminApi, run);

    await signInThroughUi(page, compound.cho);
    const station = await pairStation(page);

    const patient = await registerWalkIn(page, { fullName: `Abena Konadu ${run}` });
    await triage(page, 'Yellow');
    await requestDoctor(page);
    await page.getByRole('button', { name: /send to station/i }).click();

    // The station greets by first name, and no further.
    await expect(station.getByRole('heading', { name: 'Welcome, Abena.' })).toBeVisible();
    await expect(station.locator('body')).not.toContainText('Konadu');

    const doctorPage = await acceptOnQueue(page, doctor);

    // The station joins by itself; nobody at the compound presses anything.
    await expect(station.getByRole('button', { name: /leave|end/i })).toBeVisible({
      timeout: 20_000,
    });

    // The doctor reads the CHO's assessment before writing their own.
    await expect(doctorPage.getByText('Temp 38.4 °C').first()).toBeVisible();
    await documentAndComplete(doctorPage);

    await gotoHydrated(page, `/facility/patients/${patient}`);
    await expect(page.getByText('Malaria RDT at the facility, then treat')).toBeVisible();

    await doctorPage.context().close();
    await station.context().close();
    await adminApi.dispose();
  });

  test('Scenario 2: with no doctor available, nothing claims one accepted', async ({
    page,
    request,
    playwright,
    run,
  }) => {
    const compound = await createCompound(request, run);
    await takeOtherDoctorsOffline(playwright);

    await signInThroughUi(page, compound.cho);
    const name = `Yaw Mensah ${run}`;
    await registerWalkIn(page, { fullName: name });
    await triage(page, 'Green');
    await requestDoctor(page);

    await expect(page.getByText(/No doctor has accepted yet/)).toBeVisible();
    await expect(page.getByText(/has accepted\.\s/)).toHaveCount(0);
    await expect(page.getByText('Doctor accepted')).toHaveCount(0);

    // Still on the board, and still the CHO's to manage.
    await gotoHydrated(page, '/facility');
    await expect(page.getByText(name)).toBeVisible();
    await page.getByText(name).click();
    await page.getByPlaceholder('Reason, to withdraw the request').fill('Patient chose to go home');
    await page.getByRole('button', { name: 'Withdraw' }).click();
    await expect(page.getByRole('button', { name: 'Request a doctor' })).toBeVisible();
  });

  test('Scenario 3: an emergency never joins the queue, and is referred and documented', async ({
    page,
    request,
    run,
  }) => {
    const compound = await createCompound(request, run);
    const { csrf } = await signInAdmin(request);
    const hospital = `E2E District Hospital ${run}`;
    await createFacility(request, csrf, {
      name: hospital,
      code: `E2E-HOSP-${run}`,
      type: 'DISTRICT_HOSPITAL',
      districtId: compound.geography.districtId,
    });

    await signInThroughUi(page, compound.cho);
    await registerWalkIn(page, { fullName: `Kofi Boateng ${run}`, complaint: 'Collapsed at home' });
    await triage(page, 'Red');

    await expect(
      page.getByText('This patient is not waiting for a Neem doctor.', { exact: false }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Request a doctor' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Refer the patient' }).click();
    await chooseOption(page, 'Where to', hospital);
    await page.getByRole('button', { name: 'Emergency', exact: true }).click();
    await page.getByLabel(/^Reason/).fill('Unresponsive, needs hospital care');
    await page.getByLabel('Transport').fill('NAS ambulance called 10:42');
    await page.getByRole('button', { name: 'Record referral' }).click();

    await expect(page.getByText(hospital).first()).toBeVisible();
    await expect(page.getByText('NAS ambulance called 10:42')).toBeVisible();

    // What was done is written down.
    await page
      .getByPlaceholder('What have you done? Who was called, where are they going?')
      .fill('Recovery position, NAS called, nurse travelling with patient');
    await page.getByRole('button', { name: 'Record emergency actions' }).click();
    await expect(page.getByText(/Recorded: Recovery position/)).toBeVisible();
  });

  test('Scenario 4: a dropped call is interrupted, not completed, and can be resumed', async ({
    page,
    request,
    playwright,
    run,
  }) => {
    const compound = await createCompound(request, run);
    const adminApi = await playwright.request.newContext();
    const doctor = await doctorOnline(playwright, request, adminApi, run);

    await signInThroughUi(page, compound.cho);
    const patient = await registerWalkIn(page, { fullName: `Esi Darko ${run}` });
    await triage(page, 'Yellow');
    await requestDoctor(page);

    const doctorPage = await acceptOnQueue(page, doctor);

    // A save is still on its way when the next field is typed, and comes back
    // before that field's own one-second timer fires.
    // Nothing typed meanwhile may be lost behind a "Draft saved".
    await doctorPage.route('**/encounter', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      await route.continue();
    });
    await doctorPage.getByLabel(/^Clinical assessment/).fill('Assessment so far, not to be lost');
    await doctorPage.getByLabel(/^Treatment plan/).click();
    await doctorPage
      .getByLabel(/^Treatment plan/)
      .fill('Plan typed while the first save travelled');
    await expect(doctorPage.getByText('Draft saved')).toBeVisible({ timeout: 20_000 });
    await doctorPage.unroute('**/encounter');

    // The doctor's own report that the line went: the route the screen uses.
    const publicId = doctorPage.url().split('/').pop()!;
    const csrf = (await doctorPage.context().cookies()).find((c) => c.name === 'neem_csrf')!.value;
    const interrupted = await doctorPage.request.post(
      `${API}/doctor/consultations/${publicId}/interrupt`,
      { headers: csrfHeaders(decodeURIComponent(csrf)), data: {} },
    );
    expect(interrupted.ok(), await interrupted.text()).toBeTruthy();

    await gotoHydrated(page, `/facility/patients/${patient}`);
    await expect(page.getByText('Call interrupted')).toBeVisible();
    await expect(page.getByText('Consultation completed')).toHaveCount(0);

    // Back in: what was written is still there, and it can still be finished.
    await doctorPage.reload();
    await expect(doctorPage.getByLabel(/^Clinical assessment/)).toHaveValue(
      'Assessment so far, not to be lost',
    );
    await expect(doctorPage.getByLabel(/^Treatment plan/)).toHaveValue(
      'Plan typed while the first save travelled',
    );

    await doctorPage.context().close();
    await adminApi.dispose();
  });

  test('Scenario 5: a referral is recorded, tracked, and reflected in the record', async ({
    page,
    request,
    run,
  }) => {
    const compound = await createCompound(request, run);
    const { csrf } = await signInAdmin(request);
    const hospital = `E2E Referral Hospital ${run}`;
    await createFacility(request, csrf, {
      name: hospital,
      code: `E2E-REF-${run}`,
      type: 'DISTRICT_HOSPITAL',
      districtId: compound.geography.districtId,
    });

    await signInThroughUi(page, compound.cho);
    const name = `Adwoa Sarpong ${run}`;
    const patient = await registerWalkIn(page, { fullName: name });
    await triage(page, 'Yellow');

    await page.getByRole('button', { name: 'Refer the patient' }).click();
    await chooseOption(page, 'Where to', hospital);
    await page.getByLabel(/^Reason/).fill('Needs an ultrasound');
    await page.getByRole('button', { name: 'Record referral' }).click();
    await expect(page.getByText(hospital).first()).toBeVisible();

    await page.getByRole('button', { name: 'They expect the patient' }).click();
    await page.getByPlaceholder('Who confirmed it, e.g. Nurse Adjei, OPD').fill('Nurse Adjei');
    await page.getByRole('button', { name: 'Record confirmation' }).click();
    await expect(page.getByText(/Nurse Adjei/)).toBeVisible();

    await page.getByRole('button', { name: 'Record outcome' }).click();
    await page
      .getByPlaceholder('What they said, if anything: findings, treatment, when to review')
      .fill('Ultrasound normal, review in two weeks');
    await page.getByRole('button', { name: 'Seen there' }).click();
    await expect(page.getByText('Ultrasound normal, review in two weeks')).toBeVisible();

    // The register tracks it, and the record still says so after a reload.
    await gotoHydrated(page, '/facility/referrals');
    await page.getByLabel('Show').selectOption('all');
    await expect(page.getByText(name)).toBeVisible();
    await gotoHydrated(page, `/facility/patients/${patient}`);
    await expect(page.getByText('Ultrasound normal, review in two weeks')).toBeVisible();
  });

  test('Scenario 6: the next patient sees nothing of the last, and strangers cannot open the record', async ({
    page,
    request,
    playwright,
    run,
  }) => {
    const compound = await createCompound(request, run);
    const elsewhere = await createCompound(request, run, 'Beta');
    const adminApi = await playwright.request.newContext();
    const doctor = await doctorOnline(playwright, request, adminApi, run);

    await signInThroughUi(page, compound.cho);
    const station = await pairStation(page);

    const patient = await registerWalkIn(page, { fullName: `Akua Owusu ${run}` });
    await triage(page, 'Yellow');
    await requestDoctor(page);
    await page.getByRole('button', { name: /send to station/i }).click();
    await expect(station.getByRole('heading', { name: 'Welcome, Akua.' })).toBeVisible();

    const doctorPage = await acceptOnQueue(page, doctor);
    await documentAndComplete(doctorPage);

    // Thanked, then wiped by a reload, back to a welcome that names nobody.
    await expect(station.getByRole('heading', { name: 'Welcome to Neem.' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(station.locator('body')).not.toContainText('Akua');
    await expect(station.locator('body')).not.toContainText('Owusu');
    await expect(station.locator('body')).not.toContainText(patient);

    // Another facility's CHO is told the record does not exist.
    const other = await page
      .context()
      .browser()!
      .newContext({ baseURL: process.env.E2E_WEB_URL ?? 'http://localhost:8080' });
    const otherPage = await other.newPage();
    await signInThroughUi(otherPage, elsewhere.cho);
    await gotoHydrated(otherPage, `/facility/patients/${patient}`);
    await expect(otherPage.getByText('Patient not found.')).toBeVisible();
    await expect(otherPage.locator('body')).not.toContainText('Owusu');

    // And nobody signed out gets past the door.
    const anonymous = await page.context().browser()!.newContext();
    const refused = await anonymous.request.get(`${API}/facility/patients/${patient}`);
    expect(refused.status()).toBe(401);

    await other.close();
    await anonymous.close();
    await doctorPage.context().close();
    await station.context().close();
    await adminApi.dispose();
  });
});

test.describe('CHPS doctor (D91)', () => {
  test('a doctor sees priority and vitals, can decline or be busy, and can look back', async ({
    page,
    request,
    playwright,
    run,
  }) => {
    const compound = await createCompound(request, run);
    const adminApi = await playwright.request.newContext();
    const doctor = await doctorOnline(playwright, request, adminApi, run);

    await signInThroughUi(page, compound.cho);
    const declinedName = `Mansa Declined ${run}`;
    await registerWalkIn(page, { fullName: declinedName });
    await triage(page, 'Yellow');
    await page.getByRole('button', { name: 'Urgent', exact: true }).click();
    await requestDoctor(page);
    await expect(page.getByText(/urgent, requested at/)).toBeVisible();

    const doctorPage = await openSecondPage(page);
    await signInThroughUi(doctorPage, doctor);
    await gotoHydrated(doctorPage, '/doctor/queue');

    // Enough to decide on, before accepting.
    await expect(doctorPage.getByText('Urgent', { exact: true })).toBeVisible();
    await expect(doctorPage.getByText(/Temperature 38\.4/)).toBeVisible();
    await doctorPage.getByRole('button', { name: /^Decline/ }).click();
    await expect(doctorPage.getByRole('button', { name: 'Accept consultation' })).toHaveCount(0);

    // The CHO is still told, truthfully, that nobody has accepted.
    await page.reload();
    await expect(page.getByText(/No doctor has accepted yet/)).toBeVisible();
    await withdrawOpenRequests(page);

    // Busy holds offers back; available lets them through.
    await doctorPage.getByRole('button', { name: "I'm busy" }).click();
    await expect(doctorPage.getByRole('heading', { name: 'You are busy' }).first()).toBeVisible();

    const name = `Nana Accepted ${run}`;
    await registerWalkIn(page, { fullName: name });
    await triage(page, 'Green');
    await requestDoctor(page);
    await doctorPage.waitForTimeout(4_000);
    await expect(doctorPage.getByRole('button', { name: 'Accept consultation' })).toHaveCount(0);

    await doctorPage.getByRole('button', { name: "I'm available" }).click();
    await doctorPage
      .getByRole('button', { name: 'Accept consultation' })
      .click({ timeout: 30_000 });
    await doctorPage.waitForURL(/\/doctor\/consultations\//);

    // The CHO's bell says so, names the patient, and leads to them (D92).
    await page.reload();
    await page.getByRole('button', { name: /Notifications, \d+ new/ }).click();
    await page.getByRole('link', { name: new RegExp(`A doctor accepted.*${name}`) }).click();
    await expect(page.getByRole('heading', { name })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible();

    // Their own history, by patient and with the sealed rule untouched.
    await gotoHydrated(doctorPage, '/doctor/history');
    await expect(doctorPage.getByText(name)).toBeVisible();
    await expect(doctorPage.getByText(declinedName)).toHaveCount(0);
    await doctorPage.getByPlaceholder(/whole word of the name/).fill('Nobody');
    await doctorPage.getByRole('button', { name: 'Search' }).click();
    await expect(doctorPage.getByText('No consultations match.')).toBeVisible();
    await doctorPage.getByPlaceholder(/whole word of the name/).fill('Nana');
    await doctorPage.getByRole('button', { name: 'Search' }).click();
    await expect(doctorPage.getByText(name)).toBeVisible();

    await doctorPage.context().close();
    await adminApi.dispose();
  });
});

test.describe('CHPS offline walk-ins (D88)', () => {
  test('a walk-in saved with no connection is sealed on the device and sends itself', async ({
    page,
    request,
    run,
  }) => {
    const compound = await createCompound(request, run);
    await signInThroughUi(page, compound.cho);
    const keyLoaded = page.waitForResponse(/\/facility\/offline-key/);
    await gotoHydrated(page, '/facility/register?new=true');
    await keyLoaded;

    const name = `Abena Offline ${run}`;
    await fillRegistration(page, { fullName: name });
    await page.context().setOffline(true);
    await expect(page.getByText('No connection to Neem').first()).toBeVisible();
    await page.getByRole('button', { name: 'Save on this device' }).click();

    await page.waitForURL(/\/facility\/offline/);
    await expect(page.getByText('Waiting to send', { exact: true })).toBeVisible();

    // What is on the disk is ciphertext: the name is not in it.
    const stored = await storedWalkIns(page);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.includes(name)).toBe(false);

    // Triaged while still offline.
    await page.getByRole('button', { name: 'Triage', exact: true }).click();
    await fillField(page, /temperature/i, '38.6');
    await page.getByRole('button', { name: /^Yellow/ }).click();
    await page.getByRole('button', { name: 'Save assessment on this device' }).click();
    await expect(page.getByText(/^Triaged /)).toBeVisible();

    await page.context().setOffline(false);
    await expect(page.getByText('registered', { exact: true })).toBeVisible({ timeout: 30_000 });

    await page.getByRole('link', { name: /^NM-/ }).click();
    await expect(page.getByRole('heading', { name })).toBeVisible();
    await expect(page.getByText(/recorded offline, reached Neem/)).toBeVisible();
    await expect(page.getByText(/Temperature 38\.6/)).toBeVisible();
    expect(await storedWalkIns(page)).toHaveLength(0);
  });

  test('someone possibly on file is for the CHO to decide, never merged by itself', async ({
    page,
    request,
    run,
  }) => {
    const compound = await createCompound(request, run);
    await signInThroughUi(page, compound.cho);
    const name = `Ama Serwaa ${run}`;
    await registerWalkIn(page, { fullName: `${name} Mensah` });

    const keyLoaded = page.waitForResponse(/\/facility\/offline-key/);
    await gotoHydrated(page, '/facility/register?new=true');
    await keyLoaded;
    await fillRegistration(page, { fullName: name });
    await page.context().setOffline(true);
    await expect(page.getByRole('button', { name: 'Save on this device' })).toBeVisible();
    await page.getByRole('button', { name: 'Save on this device' }).click();
    await page.waitForURL(/\/facility\/offline/);
    await page.context().setOffline(false);

    await expect(page.getByText('May already be on file')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(`${name} Mensah`)).toBeVisible();

    // That patient has a visit in progress, so "this is them" is refused in words.
    await page.getByRole('button', { name: 'This is them' }).click();
    await expect(page.getByText(/already has a visit in progress/)).toBeVisible();
    await expect(page.getByText(/delete it from this device/)).toBeVisible();

    await page.getByRole('button', { name: 'Register as a new patient instead' }).click();
    await expect(page.getByText('registered', { exact: true })).toBeVisible({ timeout: 30_000 });
  });
});

test.describe('CHPS oversight (D84–D87)', () => {
  test('a district officer reads their own area, in figures, and can change nothing', async ({
    page,
    request,
    run,
  }) => {
    const { csrf } = await signInAdmin(request);
    const { regionId } = await aDistrict(request);
    const district = await request.post(`${API}/admin/geography/districts`, {
      headers: csrfHeaders(csrf),
      data: { regionId, name: `E2E District ${run}` },
    });
    expect(district.status(), await district.text()).toBe(201);
    const districtId = (await district.json()).data.id as string;
    const officerEmail = `e2e.officer.${run}@ghs.test`;
    const officer = await request.post(`${API}/admin/staff`, {
      headers: csrfHeaders(csrf),
      data: {
        role: 'DISTRICT',
        fullName: `Officer ${run}`,
        email: officerEmail,
        scope: { level: 'DISTRICT', regionId, districtId },
      },
    });
    expect(officer.status(), await officer.text()).toBe(201);
    const { setupPath } = (await officer.json()).data as { setupPath: string };
    await request.post(`${API}/auth/logout`, { headers: csrfHeaders(csrf) });
    await setPasswordFromLink(request, setupPath, 'OfficerPassword2026!');

    const inside = await createCompound(request, run, 'Inside', districtId);
    const outside = await createCompound(request, run, 'Outside');

    await signInThroughUi(page, inside.cho);
    const patient = `Kwame Inside ${run}`;
    await registerWalkIn(page, { fullName: patient });
    await signOutThroughUi(page);

    await signInThroughUi(page, { email: officerEmail, password: 'OfficerPassword2026!' });
    await gotoHydrated(page, '/district');
    await expect(page.getByRole('cell', { name: inside.name }).first()).toBeVisible();
    await expect(page.locator('body')).not.toContainText(outside.name);
    await expect(page.locator('body')).not.toContainText(patient);

    const cookie = (await page.context().cookies()).find((c) => c.name === 'neem_csrf')!.value;
    const write = await page.request.post(`${API}/facility/patients`, {
      headers: csrfHeaders(decodeURIComponent(cookie)),
      data: {},
    });
    expect(write.status()).toBe(403);
  });

  test('operations sees every compound and the system, but not accounts or the audit log', async ({
    page,
    request,
    run,
  }) => {
    const compound = await createCompound(request, run, 'Watched');
    const { csrf } = await signInAdmin(request);
    const email = `e2e.ops.${run}@ops.test`;
    const created = await request.post(`${API}/admin/staff`, {
      headers: csrfHeaders(csrf),
      data: { role: 'OPS_ADMIN', fullName: `Ops ${run}`, email },
    });
    expect(created.status(), await created.text()).toBe(201);
    const { setupPath } = (await created.json()).data as { setupPath: string };
    await request.post(`${API}/auth/logout`, { headers: csrfHeaders(csrf) });
    const password = 'OperationsPassword2026!';
    await setPasswordFromLink(request, setupPath, password);

    // Two-factor is mandatory for every administrator, operations included.
    const login = await (
      await page.request.post(`${API}/auth/login`, { data: { email, password } })
    ).json();
    expect(login.data.enrollmentRequired).toBe(true);
    const challengeId = login.data.challengeId as string;
    const enrol = await (
      await page.request.post(`${API}/auth/2fa/enroll`, { data: { challengeId } })
    ).json();
    const verified = await page.request.post(`${API}/auth/2fa/verify`, {
      data: { challengeId, code: authenticator.generate(enrol.data.secret) },
    });
    expect(verified.ok(), await verified.text()).toBeTruthy();

    await gotoHydrated(page, '/admin/chps');
    await expect(page.getByText(compound.name).first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Staff accounts' })).toHaveCount(0);

    await gotoHydrated(page, '/admin/monitoring');
    await expect(page.getByText('Failed sign-ins')).toBeVisible();
    await expect(page.getByText(/only the super administrator reads/)).toBeVisible();

    expect((await page.request.get(`${API}/admin/staff`)).status()).toBe(403);
  });
});

/** The offline store as it sits on the device, read the way anything else could. */
async function storedWalkIns(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('neem-offline');
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const all = await new Promise<Array<{ ciphertext: ArrayBuffer }>>((resolve, reject) => {
      const read = db.transaction('walk-ins').objectStore('walk-ins').getAll();
      read.onsuccess = () => resolve(read.result);
      read.onerror = () => reject(read.error);
    });
    db.close();
    return all.map((row) => JSON.stringify(row) + new TextDecoder('latin1').decode(row.ciphertext));
  });
}

test.describe('CHPS triage protocol (D93)', () => {
  test('a rule entered from a named protocol prompts the CHO, who still decides', async ({
    page,
    request,
    run,
  }) => {
    const { csrf } = await signInAdmin(request);
    // Above any real reading, so this rule cannot affect another test's walk-ins.
    const added = await request.post(`${API}/admin/triage-protocol`, {
      headers: csrfHeaders(csrf),
      data: {
        reading: 'glucoseMmolL',
        comparison: 'ABOVE',
        threshold: 49.5,
        suggestedCategory: 'ORANGE',
        message: `End-to-end test rule ${run}.`,
        source: 'A test, not an approved document',
        approvedBy: 'Automated test',
      },
    });
    expect(added.status(), await added.text()).toBe(201);
    const rule = ((await added.json()).data as Array<{ id: string; message: string }>).find(
      (entry) => entry.message.includes(run),
    )!;

    try {
      const compound = await createCompound(request, run);
      await signInThroughUi(page, compound.cho);
      await registerWalkIn(page, { fullName: `Efua Flagged ${run}` });

      await fillField(page, /blood glucose/i, '49.8');
      await expect(page.getByText(`End-to-end test rule ${run}.`)).toBeVisible();
      await expect(page.getByText('From A test, not an approved document')).toBeVisible();

      // It suggested Orange. Green is chosen, and Green is what is recorded.
      await page.getByRole('button', { name: /^Green/ }).click();
      await page.getByRole('button', { name: 'Save assessment' }).click();
      await expect(page.getByText(/Last assessed by/)).toBeVisible();
      await expect(page.getByText('Green', { exact: true }).first()).toBeVisible();
      await expect(page.getByText(`End-to-end test rule ${run}.`)).toBeVisible();
    } finally {
      const again = await signInAdmin(request);
      await request.post(`${API}/admin/triage-protocol/${rule.id}/retire`, {
        headers: csrfHeaders(again.csrf),
      });
    }
  });
});

test.describe('the presentation build (D95)', () => {
  test('asks nothing of the outside world while a CHO works', async ({ page, request, run }) => {
    const outside: string[] = [];
    page.on('request', (sent) => {
      const { hostname, protocol } = new URL(sent.url());
      if (['http:', 'https:', 'ws:', 'wss:'].includes(protocol) && hostname !== 'localhost') {
        outside.push(sent.url());
      }
    });

    const compound = await createCompound(request, run);
    await signInThroughUi(page, compound.cho);
    await registerWalkIn(page, { fullName: `Efua Local ${run}` });
    await triage(page, 'Green');
    for (const path of ['/facility', '/facility/referrals', '/facility/reports']) {
      await gotoHydrated(page, path);
    }

    expect(outside).toEqual([]);
  });
});
