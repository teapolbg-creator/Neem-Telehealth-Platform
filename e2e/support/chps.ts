import type { APIRequestContext, Page } from '@playwright/test';
import {
  API,
  createActiveDoctor,
  csrfHeaders,
  expect,
  fillField,
  goOnlineExclusively,
  gotoHydrated,
  openSecondPage,
  putDoctorOnShiftNow,
  signInAdmin,
  signInThroughUi,
  type ActiveDoctor,
} from './fixtures.ts';

/**
 * What the CHPS journeys share (docs/v2-chps-plan.md §5).
 *
 * Accounts and facilities are made through the same admin routes the console
 * uses, and each run makes its own, so nothing in the demo data is touched.
 * Everything a test is about happens on the screens.
 */

const CHO_PASSWORD = 'ChoPassword2026!';

/**
 * Refuses to run against an API that could send a real message.
 *
 * Playwright's mock settings do not reach a dev server it reuses, and these
 * journeys notify doctors and carry valid-looking Ghanaian numbers.
 */
export async function assertMessagesAreMocked(request: APIRequestContext): Promise<void> {
  const { csrf } = await signInAdmin(request);
  const health = await (await request.get(`${API}/admin/system-health`)).json();
  await request.post(`${API}/auth/logout`, { headers: csrfHeaders(csrf) });
  const mocked: string[] = health.data.mockedProviders;
  for (const provider of ['sms', 'email', 'whatsapp', 'video']) {
    expect(
      mocked,
      `${provider} is not mocked. Start the API with every provider mocked before this suite.`,
    ).toContain(provider);
  }
}

export interface Geography {
  regionId: string;
  districtId: string;
  districtName: string;
}

export async function aDistrict(admin: APIRequestContext): Promise<Geography> {
  const regions = (await (await admin.get(`${API}/admin/geography`)).json()).data as Array<{
    id: string;
    districts: Array<{ id: string; name: string }>;
  }>;
  const region = regions.find((entry) => entry.districts.length > 0);
  expect(region, 'the development database should have a district').toBeTruthy();
  return {
    regionId: region!.id,
    districtId: region!.districts[0]!.id,
    districtName: region!.districts[0]!.name,
  };
}

export async function createFacility(
  admin: APIRequestContext,
  csrf: string,
  options: { name: string; code: string; type: 'CHPS' | 'DISTRICT_HOSPITAL'; districtId: string },
): Promise<string> {
  const created = await admin.post(`${API}/admin/facilities`, {
    headers: csrfHeaders(csrf),
    data: {
      name: options.name,
      code: options.code,
      type: options.type,
      districtId: options.districtId,
      community: options.name,
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const publicId = (await created.json()).data.publicId as string;
  const activated = await admin.patch(`${API}/admin/facilities/${publicId}`, {
    headers: csrfHeaders(csrf),
    data: { status: 'ACTIVE' },
  });
  expect(activated.ok(), await activated.text()).toBeTruthy();
  return publicId;
}

/** Follows the one-time link an account is set up with, as its owner would. */
export async function setPasswordFromLink(
  request: APIRequestContext,
  setupPath: string,
  password: string,
): Promise<void> {
  const token = new URL(setupPath, 'http://neem.test').searchParams.get('token');
  const confirmed = await request.post(`${API}/auth/password-reset/confirm`, {
    data: { token, password },
  });
  expect(confirmed.ok(), await confirmed.text()).toBeTruthy();
}

export interface Compound {
  publicId: string;
  name: string;
  cho: { email: string; password: string };
  geography: Geography;
}

/** A live CHPS compound with one CHO who has set their password. */
export async function createCompound(
  request: APIRequestContext,
  run: string,
  label = 'Alpha',
  districtId?: string,
): Promise<Compound> {
  const { csrf } = await signInAdmin(request);
  const geography = await aDistrict(request);
  if (districtId) geography.districtId = districtId;
  const name = `E2E ${label} CHPS ${run}`;
  const publicId = await createFacility(request, csrf, {
    name,
    code: `E2E-${label}-${run}`,
    type: 'CHPS',
    districtId: geography.districtId,
  });
  const email = `e2e.cho.${label.toLowerCase()}.${run}@chps.test`;
  const staff = await request.post(`${API}/admin/facilities/${publicId}/staff`, {
    headers: csrfHeaders(csrf),
    data: { fullName: `CHO ${label} ${run}`, email },
  });
  expect(staff.status(), await staff.text()).toBe(201);
  const { setupPath } = (await staff.json()).data as { setupPath: string };
  await request.post(`${API}/auth/logout`, { headers: csrfHeaders(csrf) });
  await setPasswordFromLink(request, setupPath, CHO_PASSWORD);
  return { publicId, name, cho: { email, password: CHO_PASSWORD }, geography };
}

export interface WalkIn {
  fullName: string;
  ageYears?: string;
  complaint?: string;
}

/** Fills in the registration form, up to but not including its submit button. */
export async function fillRegistration(page: Page, walkIn: WalkIn): Promise<void> {
  await fillField(page, /full name/i, walkIn.fullName);
  await page.getByRole('button', { name: 'Female', exact: true }).click();
  await page.getByPlaceholder('Years').fill(walkIn.ageYears ?? '34');
  await fillField(page, /community or village/i, 'Alpha');
  await fillField(page, /why have they come/i, walkIn.complaint ?? 'Fever for two days');
  await page.getByRole('button', { name: 'The patient agrees' }).click();
}

/** Registers a walk-in through the form and lands on their record. */
export async function registerWalkIn(page: Page, walkIn: WalkIn): Promise<string> {
  await gotoHydrated(page, '/facility/register?new=true');
  await fillRegistration(page, walkIn);
  await page.getByRole('button', { name: 'Register and start visit' }).click();
  await page.waitForURL(/\/facility\/patients\/NM-/);
  await expect(page.getByRole('heading', { name: walkIn.fullName })).toBeVisible();
  return page.url().split('/').pop()!;
}

/** Records a temperature and the CHO's category on the open form. */
export async function triage(page: Page, category: 'Red' | 'Yellow' | 'Green'): Promise<void> {
  await fillField(page, /temperature/i, '38.4');
  await page.getByRole('button', { name: new RegExp(`^${category}`) }).click();
  await page
    .getByRole('button', {
      name: category === 'Red' ? 'Save and start emergency' : 'Save assessment',
    })
    .click();
  await expect(page.getByText(/Last assessed by/)).toBeVisible();
}

/** Chooses the option whose text contains `text`, for names that carry a suffix. */
export async function chooseOption(page: Page, label: string, text: string): Promise<void> {
  const select = page.getByLabel(label);
  const option = select.locator('option', { hasText: text });
  await expect(option).toHaveCount(1);
  await select.selectOption((await option.getAttribute('value'))!);
}

export async function requestDoctor(page: Page): Promise<void> {
  await page.getByLabel('Language the patient speaks').selectOption({ label: 'English' });
  await page.getByRole('button', { name: 'Request a doctor' }).click();
  await expect(page.getByText('Waiting for a doctor', { exact: false }).first()).toBeVisible();
}

/**
 * A paired station on a browser of its own: its cookie is its credential, and
 * it shares nothing with the CHO who set it up.
 */
export async function pairStation(cho: Page, label = 'Consulting room tablet'): Promise<Page> {
  await gotoHydrated(cho, '/facility');
  await cho.getByRole('button', { name: 'Add station' }).click();
  await cho.getByPlaceholder('Name, e.g. Consulting room tablet').fill(label);
  await cho.getByRole('button', { name: 'Add', exact: true }).click();
  const code = (await cho.locator('p.font-mono').innerText()).trim();
  await cho.getByRole('button', { name: 'Done' }).click();

  const station = await openSecondPage(cho);
  await gotoHydrated(station, '/station');
  await station.getByPlaceholder('XXXX-XXXX').fill(code);
  await station.getByRole('button', { name: 'Pair station' }).click();
  await expect(station.getByRole('heading', { name: 'Welcome to Neem.' })).toBeVisible();
  return station;
}

/** The only doctor who can be offered anything, on shift and available. */
export async function doctorOnline(
  playwright: typeof import('@playwright/test').default,
  request: APIRequestContext,
  adminApi: APIRequestContext,
  run: string,
): Promise<ActiveDoctor> {
  const doctor = await createActiveDoctor(request, { run: `chps${run}` });
  const shift = await putDoctorOnShiftNow(request, adminApi, doctor);
  if (!shift.ok) throw new Error(`The doctor could not go on shift: ${shift.reason}`);
  await goOnlineExclusively(playwright, request, doctor, shift.csrf);
  return doctor;
}

/** The doctor's browser, signed in, past the offer and in the consultation. */
export async function acceptOnQueue(cho: Page, doctor: ActiveDoctor): Promise<Page> {
  const page = await openSecondPage(cho);
  await signInThroughUi(page, doctor);
  await gotoHydrated(page, '/doctor/queue');
  await page.getByRole('button', { name: 'Accept consultation' }).click();
  await page.waitForURL(/\/doctor\/consultations\//);
  return page;
}

/** Writes what completion requires, and completes as advice only. */
export async function documentAndComplete(doctor: Page): Promise<void> {
  await doctor.getByLabel(/^Clinical assessment/).fill('Likely uncomplicated malaria');
  await doctor.getByLabel(/^Treatment plan/).fill('Malaria RDT at the facility, then treat');
  await expect(doctor.getByText('Draft saved')).toBeVisible();
  await doctor.getByRole('checkbox', { name: /advice/i }).check();
  await doctor.getByRole('button', { name: 'Complete consultation' }).click();
  await expect(doctor.getByText(/^Final, version/)).toBeVisible();
}

/**
 * Withdraws whatever this CHO still has waiting for a doctor.
 *
 * The queue is shared by the whole database, so a request a failed test left
 * behind goes to the next test's doctor, whose own patient then waits forever.
 * Does nothing for a page that is not a CHO's.
 */
export async function withdrawOpenRequests(page: Page): Promise<void> {
  const today = await page.request.get(`${API}/facility/today`);
  if (!today.ok()) return;
  const cookie = (await page.context().cookies()).find((entry) => entry.name === 'neem_csrf');
  if (!cookie) return;
  const { board } = (await today.json()).data as {
    board: Array<{ publicId: string; consultation: { state: string } | null }>;
  };
  for (const visit of board) {
    if (
      !['WAITING_FOR_DOCTOR', 'ASSIGNED', 'REASSIGNING'].includes(visit.consultation?.state ?? '')
    ) {
      continue;
    }
    await page.request.post(`${API}/facility/visits/${visit.publicId}/consultation/cancel`, {
      headers: csrfHeaders(decodeURIComponent(cookie.value)),
      data: { reason: 'End of an automated test' },
    });
  }
}
