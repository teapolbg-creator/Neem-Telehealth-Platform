import {
  test,
  expect,
  API,
  csrfHeaders,
  fillField,
  gotoHydrated,
  minimalPng,
  signIn,
  signInAdmin,
  signInAdminOnPage,
  signInThroughUi,
} from './support/fixtures.ts';

/**
 * Pharmacy registration and verification, end to end (spec §20, §83).
 *
 * None of this existed before: there was no registration screen, no document
 * upload route, and no check on activation. `verifiedDocumentCount` was
 * therefore structurally always zero, and every pharmacy that had gone ACTIVE
 * did so without a single document being looked at. An active pharmacy
 * receives and dispenses prescriptions.
 */

const PASSWORD = 'PharmacyPassword2026!';

test.describe('pharmacy application', () => {
  test('applies through the form and lands in PENDING', async ({ page, run }) => {
    const email = `e2e.pharmacy.${run}@pharmacy.test`;

    await gotoHydrated(page, '/onboarding/pharmacy');

    await fillField(page, /pharmacy name/i, `E2E Pharmacy ${run}`);
    await fillField(page, /pharmacy council registration/i, `PCG-E2E-${run}`);
    await fillField(page, /owner/i, 'Yaa Owner');
    await fillField(page, /responsible pharmacist/i, 'Kwesi Pharmacist');
    await fillField(page, /street address/i, '12 Ring Road');
    await fillField(page, /city or town/i, 'Kumasi');
    await fillField(page, /region/i, 'Ashanti');
    await fillField(page, /phone/i, '0244556677');
    await fillField(page, /email/i, email);
    await fillField(page, /password/i, PASSWORD);

    await page.getByRole('button', { name: /submit application/i }).click();

    await expect(page.getByRole('heading', { name: /application received/i })).toBeVisible();
    // The applicant is told what happens next, not left guessing.
    await expect(page.getByText(/cannot be activated until an administrator/i)).toBeVisible();
  });

  test('states plainly that Neem does not check registrations automatically', async ({ page }) => {
    await gotoHydrated(page, '/onboarding/pharmacy');

    // Spec §78 — no claim of an automated regulatory check.
    await expect(
      page.getByText(/does not check registrations automatically with the pharmacy council/i),
    ).toBeVisible();
  });
});

test.describe('pharmacy verification', () => {
  test('refuses activation until a document is verified, then allows it', async ({
    page,
    request,
    run,
  }) => {
    const email = `e2e.pharmverify.${run}@pharmacy.test`;
    const councilNo = `PCG-E2EV-${run}`;

    const application = await request.post(`${API}/onboarding/pharmacy`, {
      data: {
        email,
        password: PASSWORD,
        name: `Verify Pharmacy ${run}`,
        councilRegistrationNo: councilNo,
        ownerName: 'Yaa Owner',
        responsiblePharmacistName: 'Kwesi Pharmacist',
        addressLine1: '12 Ring Road',
        city: 'Kumasi',
        region: 'Ashanti',
        phone: '0244556677',
        openingHours: [],
        tests: [],
        equipment: [],
        services: [],
      },
    });
    expect(application.status(), await application.text()).toBe(201);

    const pharmacyCsrf = await signIn(request, { email, password: PASSWORD });

    const upload = await request.post(`${API}/pharmacy/documents`, {
      headers: csrfHeaders(pharmacyCsrf),
      multipart: {
        documentType: 'COUNCIL_REGISTRATION',
        file: { name: 'council.png', mimeType: 'image/png', buffer: minimalPng() },
      },
    });
    expect(upload.status()).toBe(201);
    const documentId = (await upload.json()).data.id as string;

    await request.post(`${API}/auth/logout`, { headers: csrfHeaders(pharmacyCsrf) });
    const { csrf: adminCsrf } = await signInAdmin(request);

    const list = await request.get(`${API}/admin/pharmacies?search=${councilNo}`);
    const applicant = (await list.json()).data.find(
      (entry: { councilRegistrationNo: string }) => entry.councilRegistrationNo === councilNo,
    );
    expect(applicant, 'the applicant should be in the review queue').toBeTruthy();

    for (const status of ['UNDER_REVIEW', 'APPROVED']) {
      const response = await request.post(`${API}/admin/pharmacies/${applicant.publicId}/status`, {
        headers: csrfHeaders(adminCsrf),
        data: { status },
      });
      expect(response.ok(), `transition to ${status}`).toBeTruthy();
    }

    // Uploaded is not verified. A human must open the file and accept it.
    const blocked = await request.post(`${API}/admin/pharmacies/${applicant.publicId}/status`, {
      headers: csrfHeaders(adminCsrf),
      data: { status: 'ACTIVE' },
    });
    expect(blocked.status()).toBe(422);
    expect(await blocked.text()).toMatch(/no verified documents/i);

    // The administrator can actually open the document before deciding.
    const file = await request.get(`${API}/admin/pharmacies/documents/${documentId}`);
    expect(file.status()).toBe(200);
    expect(file.headers()['content-type']).toBe('image/png');

    const verified = await request.post(`${API}/admin/pharmacies/documents/${documentId}/verify`, {
      headers: csrfHeaders(adminCsrf),
      data: { verified: true },
    });
    expect(verified.ok()).toBeTruthy();

    const activated = await request.post(`${API}/admin/pharmacies/${applicant.publicId}/status`, {
      headers: csrfHeaders(adminCsrf),
      data: { status: 'ACTIVE' },
    });
    expect(activated.ok(), await activated.text()).toBeTruthy();

    // And the console reflects it. Search rather than scroll: the directory
    // accumulates across runs and is paginated.
    await signInAdminOnPage(page);
    await gotoHydrated(page, '/admin/verification');
    await page.getByRole('button', { name: /pharmacies/i }).click();
    await fillField(page, /search pharmacies/i, councilNo);
    await expect(page.getByText(`Verify Pharmacy ${run}`).first()).toBeVisible();
  });

  test('shows the pharmacy its own outstanding requirements', async ({ page, request, run }) => {
    const email = `e2e.pharmportal.${run}@pharmacy.test`;

    await request.post(`${API}/onboarding/pharmacy`, {
      data: {
        email,
        password: PASSWORD,
        name: `Portal Pharmacy ${run}`,
        councilRegistrationNo: `PCG-E2EP-${run}`,
        ownerName: 'Yaa Owner',
        responsiblePharmacistName: 'Kwesi Pharmacist',
        addressLine1: '12 Ring Road',
        city: 'Kumasi',
        region: 'Ashanti',
        phone: '0244556677',
        openingHours: [],
        tests: [],
        equipment: [],
        services: [],
      },
    });

    await signInThroughUi(page, { email, password: PASSWORD });
    await gotoHydrated(page, '/pharmacy/onboarding');

    await expect(page.getByText(/your application is incomplete/i)).toBeVisible();
    await expect(page.getByText(/upload your pharmacy council registration/i)).toBeVisible();
    await expect(page.getByText(/0 of 0 verified/i)).toBeVisible();

    // The page states what is and is not claimed about the documents.
    await expect(page.getByText(/makes no claim that a document is genuine/i)).toBeVisible();
  });
});

test.describe('pharmacy document isolation', () => {
  test('will not let one pharmacy read another pharmacy’s document', async ({
    request,
    playwright,
    run,
  }) => {
    const first = `e2e.pharmiso.a.${run}@pharmacy.test`;
    const second = `e2e.pharmiso.b.${run}@pharmacy.test`;

    const apply = (email: string, suffix: string) =>
      request.post(`${API}/onboarding/pharmacy`, {
        data: {
          email,
          password: PASSWORD,
          name: `Isolation ${suffix} ${run}`,
          councilRegistrationNo: `PCG-E2EI-${suffix}-${run}`,
          ownerName: 'Yaa Owner',
          responsiblePharmacistName: 'Kwesi Pharmacist',
          addressLine1: '12 Ring Road',
          city: 'Kumasi',
          region: 'Ashanti',
          phone: '0244556677',
          openingHours: [],
          tests: [],
          equipment: [],
          services: [],
        },
      });

    await apply(first, 'a');
    await apply(second, 'b');

    const csrf = await signIn(request, { email: first, password: PASSWORD });
    const upload = await request.post(`${API}/pharmacy/documents`, {
      headers: csrfHeaders(csrf),
      multipart: {
        documentType: 'COUNCIL_REGISTRATION',
        file: { name: 'council.png', mimeType: 'image/png', buffer: minimalPng() },
      },
    });
    const documentId = (await upload.json()).data.id as string;

    // A separate context, because it is a separate cookie jar.
    const other = await playwright.request.newContext();
    await signIn(other, { email: second, password: PASSWORD });

    const response = await other.get(`${API}/pharmacy/documents/${documentId}`);

    // 404, not 403: confirming the document exists would itself be a
    // disclosure (spec §102).
    expect(response.status()).toBe(404);

    await other.dispose();
  });
});
