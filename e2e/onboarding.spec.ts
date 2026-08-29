import {
  test,
  expect,
  API,
  csrfHeaders,
  fillField,
  gotoHydrated,
  signInAdmin,
  signIn,
  signInThroughUi,
  signInAdminOnPage,
} from './support/fixtures.ts';

/**
 * Doctor onboarding and admin verification, end to end (spec §21, §55, §83).
 *
 * Covers the journey a real applicant takes: apply → sign in → upload
 * credentials → capture a signature → wait for an administrator → activation.
 */

test.describe('doctor application', () => {
  test('applies through the form and lands in PENDING', async ({ page, run }) => {
    const email = `e2e.doctor.${run}@doctor.test`;

    await gotoHydrated(page, '/onboarding/doctor');

    await fillField(page, 'Full name', 'Dr. E2E Applicant');
    await fillField(page, 'Email', email);
    await fillField(page, 'Password', 'DoctorPassword2026!');
    await fillField(page, 'Phone', '0244000111');
    await fillField(page, 'MDC number', `MDC-E2E-${run}`);
    await fillField(page, 'Licence expires', '2029-12-31');
    await fillField(page, 'Date qualified', '2015-01-15');
    await fillField(page, 'Years of experience', '10');

    await page.getByRole('button', { name: 'English', exact: true }).click();
    await page.getByRole('button', { name: 'Twi', exact: true }).click();

    await page.getByRole('button', { name: /submit application/i }).click();

    await expect(page.getByRole('heading', { name: /application received/i })).toBeVisible();
    // The message must set the right expectation: manual review, not instant access.
    await expect(page.getByText(/administrator will review/i)).toBeVisible();
  });

  test('refuses an applicant below the minimum experience requirement', async ({ page, run }) => {
    await gotoHydrated(page, '/onboarding/doctor');

    await fillField(page, 'Full name', 'Dr. Too Junior');
    await fillField(page, 'Email', `e2e.junior.${run}@doctor.test`);
    await fillField(page, 'Password', 'DoctorPassword2026!');
    await fillField(page, 'Phone', '0244000112');
    await fillField(page, 'MDC number', `MDC-E2E-J-${run}`);
    await fillField(page, 'Licence expires', '2029-12-31');
    await fillField(page, 'Date qualified', '2024-01-15');
    await fillField(page, 'Years of experience', '1');
    await page.getByRole('button', { name: 'English', exact: true }).click();

    await page.getByRole('button', { name: /submit application/i }).click();

    // Enforced server-side against the configured setting (spec §21).
    await expect(page.getByRole('alert')).toContainText(/3 years/);
  });

  test('states that Neem does not verify licences automatically', async ({ page }) => {
    // Spec §78: no unverified regulatory capability may be implied.
    await gotoHydrated(page, '/onboarding/doctor');
    await expect(page.getByText(/does not verify licences automatically/i)).toBeVisible();
  });
});

test.describe('doctor onboarding portal', () => {
  test('shows outstanding requirements, then accepts a drawn signature', async ({
    page,
    request,
    run,
  }) => {
    const email = `e2e.sig.${run}@doctor.test`;

    const application = await request.post(`${API}/onboarding/doctor`, {
      data: {
        email,
        password: 'DoctorPassword2026!',
        fullName: 'Dr. Signature Test',
        mdcNumber: `MDC-E2E-S-${run}`,
        mdcExpiresAt: '2029-12-31',
        qualifiedAt: '2014-01-15',
        yearsExperience: 11,
        phone: '0244000113',
        languageCodes: ['en'],
      },
    });
    expect(application.status()).toBe(201);

    await signIn(request, { email, password: 'DoctorPassword2026!' });
    await signInThroughUi(page, { email, password: 'DoctorPassword2026!' });

    await gotoHydrated(page, '/doctor/onboarding');

    await expect(page.getByText(/application is incomplete/i)).toBeVisible();
    await expect(page.getByText(/3 required documents/i)).toBeVisible();
    await expect(page.getByText(/does not check licences automatically/i)).toBeVisible();

    // Draw on the signature canvas with real pointer input.
    const canvas = page.getByRole('img', { name: /signature drawing area/i });
    await canvas.scrollIntoViewIfNeeded();
    const box = (await canvas.boundingBox())!;

    await page.mouse.move(box.x + 30, box.y + box.height / 2);
    await page.mouse.down();
    for (let step = 1; step <= 12; step += 1) {
      await page.mouse.move(
        box.x + 30 + step * ((box.width - 60) / 12),
        box.y + box.height / 2 + Math.sin(step) * 20,
      );
    }
    await page.mouse.up();

    await page.getByRole('button', { name: /save signature/i }).click();
    await expect(page.getByText(/signature saved/i)).toBeVisible();

    // Confirm it actually persisted, rather than trusting the toast.
    const profile = await request.get(`${API}/doctor/profile`);
    expect((await profile.json()).data.signatureCapturedAt).not.toBeNull();
  });

  test('refuses a file whose contents do not match its declared type', async ({ request, run }) => {
    const email = `e2e.upload.${run}@doctor.test`;

    await request.post(`${API}/onboarding/doctor`, {
      data: {
        email,
        password: 'DoctorPassword2026!',
        fullName: 'Dr. Upload Test',
        mdcNumber: `MDC-E2E-U-${run}`,
        mdcExpiresAt: '2029-12-31',
        qualifiedAt: '2014-01-15',
        yearsExperience: 11,
        phone: '0244000114',
        languageCodes: ['en'],
      },
    });
    const csrf = await signIn(request, { email, password: 'DoctorPassword2026!' });

    // A script payload declared as a PNG. The browser Content-Type is
    // attacker-controlled, so the server checks the bytes (docs/security.md §6).
    const response = await request.post(`${API}/doctor/documents`, {
      headers: csrfHeaders(csrf),
      multipart: {
        documentType: 'MDC_LICENCE',
        file: {
          name: 'shell.png',
          mimeType: 'image/png',
          buffer: Buffer.from('<?php system($_GET["c"]); ?>'),
        },
      },
    });

    expect(response.status()).toBe(400);
    expect(await response.text()).toContain('do not match its file type');
  });
});

test.describe('admin verification', () => {
  test('takes an application from PENDING to ACTIVE, refusing the shortcut', async ({
    page,
    request,
    run,
  }) => {
    const email = `e2e.verify.${run}@doctor.test`;

    // Apply, then upload real PNGs so the magic-byte check passes.
    await request.post(`${API}/onboarding/doctor`, {
      data: {
        email,
        password: 'DoctorPassword2026!',
        fullName: `Dr. Verify ${run}`,
        mdcNumber: `MDC-E2E-V-${run}`,
        mdcExpiresAt: '2029-12-31',
        qualifiedAt: '2013-01-15',
        yearsExperience: 12,
        phone: '0244000115',
        languageCodes: ['en'],
      },
    });

    const doctorCsrf = await signIn(request, { email, password: 'DoctorPassword2026!' });
    const png = minimalPng();

    for (const documentType of ['MDC_LICENCE', 'GOVERNMENT_ID', 'PRACTICE_EVIDENCE']) {
      const upload = await request.post(`${API}/doctor/documents`, {
        headers: csrfHeaders(doctorCsrf),
        multipart: {
          documentType,
          file: { name: 'doc.png', mimeType: 'image/png', buffer: png },
        },
      });
      expect(upload.status()).toBe(201);
    }

    await request.post(`${API}/doctor/signature`, {
      headers: csrfHeaders(doctorCsrf),
      data: { signatureDataUrl: `data:image/png;base64,${png.toString('base64')}` },
    });

    await request.post(`${API}/auth/logout`, { headers: csrfHeaders(doctorCsrf) });

    // Now act as the administrator.
    const { csrf: adminCsrf } = await signInAdmin(request);

    // Search rather than scan the first page: the directory accumulates
    // applicants across runs and the list is paginated.
    const list = await request.get(
      `${API}/admin/doctors?search=MDC-E2E-V-${run}`,
    );
    const applicant = (await list.json()).data.find(
      (entry: { mdcNumber: string }) => entry.mdcNumber === `MDC-E2E-V-${run}`,
    );
    expect(applicant, 'the applicant should appear in the review queue').toBeTruthy();

    // The illegal shortcut must be refused (spec §83).
    const shortcut = await request.post(`${API}/admin/doctors/${applicant.publicId}/status`, {
      headers: csrfHeaders(adminCsrf),
      data: { status: 'ACTIVE' },
    });
    expect(shortcut.status()).toBe(409);

    // Verify each document, then walk the legitimate path.
    const detail = await (await request.get(`${API}/doctors/${applicant.publicId}`)).json();
    for (const document of detail.data.documents) {
      const verified = await request.post(
        `${API}/admin/doctors/documents/${document.id}/verify`,
        { headers: csrfHeaders(adminCsrf), data: { verified: true } },
      );
      expect(verified.ok()).toBeTruthy();
    }

    for (const status of ['UNDER_REVIEW', 'APPROVED', 'ACTIVE']) {
      const response = await request.post(`${API}/admin/doctors/${applicant.publicId}/status`, {
        headers: csrfHeaders(adminCsrf),
        data: { status },
      });
      expect(response.ok(), `transition to ${status} should be permitted`).toBeTruthy();
    }

    // And the verification console reflects it. Search rather than scroll: the
    // list is paginated, so a specific applicant is not necessarily on page one.
    await signInAdminOnPage(page);
    await gotoHydrated(page, '/admin/verification');
    await fillField(page, /search doctors/i, `Dr. Verify ${run}`);
    await expect(page.getByText(`Dr. Verify ${run}`)).toBeVisible();
  });

  test('offers only the transitions the state machine permits', async ({ page, request, run }) => {
    const email = `e2e.trans.${run}@doctor.test`;

    await request.post(`${API}/onboarding/doctor`, {
      data: {
        email,
        password: 'DoctorPassword2026!',
        fullName: `Dr. Transitions ${run}`,
        mdcNumber: `MDC-E2E-T-${run}`,
        mdcExpiresAt: '2029-12-31',
        qualifiedAt: '2013-01-15',
        yearsExperience: 12,
        phone: '0244000116',
        languageCodes: ['en'],
      },
    });

    await signInAdminOnPage(page);
    await gotoHydrated(page, '/admin/verification');
    await fillField(page, /search doctors/i, `Dr. Transitions ${run}`);

    await page.getByRole('button', { name: new RegExp(`Dr. Transitions ${run}`) }).click();

    // From PENDING the only legal moves are UNDER_REVIEW and REJECTED.
    await expect(page.getByRole('button', { name: 'UNDER REVIEW', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'REJECTED', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'ACTIVE', exact: true })).toHaveCount(0);
  });

  test('requires a reason before an adverse action', async ({ page, request, run }) => {
    const email = `e2e.reason.${run}@doctor.test`;

    await request.post(`${API}/onboarding/doctor`, {
      data: {
        email,
        password: 'DoctorPassword2026!',
        fullName: `Dr. Reason ${run}`,
        mdcNumber: `MDC-E2E-R-${run}`,
        mdcExpiresAt: '2029-12-31',
        qualifiedAt: '2013-01-15',
        yearsExperience: 12,
        phone: '0244000117',
        languageCodes: ['en'],
      },
    });

    await signInAdminOnPage(page);
    await gotoHydrated(page, '/admin/verification');
    await fillField(page, /search doctors/i, `Dr. Reason ${run}`);
    await page.getByRole('button', { name: new RegExp(`Dr. Reason ${run}`) }).click();

    await page.getByRole('button', { name: 'REJECTED', exact: true }).click();

    // Confirm stays disabled until a reason is given (spec §96).
    const confirm = page.getByRole('button', { name: 'Confirm', exact: true });
    await expect(confirm).toBeDisabled();

    await page.getByLabel(/reason/i).fill('Credentials could not be verified with the MDC.');
    await expect(confirm).toBeEnabled();
  });
});

/** The smallest valid PNG, so the magic-byte check has something genuine to accept. */
function minimalPng(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
}
