import {
  test,
  expect,
  API,
  gotoHydrated,
  runId,
  signInAdmin,
  signInAdminOnPage,
} from './support/fixtures.ts';

/**
 * Pilot applications, end to end.
 *
 * The journey this covers is the one the marketing site starts: somebody fills
 * in the public form, and an administrator finds them on a screen and works
 * the lead. The two halves live in different repositories, so the join between
 * them — an unauthenticated POST landing on an authenticated screen — is
 * exactly the part nothing else tests.
 */

test.describe('pilot applications', () => {
  test('a public submission reaches the admin screen and can be worked', async ({
    page,
    request,
  }) => {
    const id = runId();
    const applicant = {
      role: 'DOCTOR' as const,
      fullName: `Dr. Pilot ${id}`,
      // Spaced, the way a person actually writes their number.
      phone: '024 000 0000',
      email: `pilot-${id}@example.com`,
      specialty: 'General practice',
      organisation: `Clinic ${id}`,
      location: 'Kumasi',
      yearsOfPractice: '6',
      additionalInfo: 'Available weekday evenings.',
      consent: true as const,
    };

    // --- the public half: no session, no CSRF header, nothing --------------
    const submitted = await request.post(`${API}/pilot-applications`, { data: applicant });

    expect(submitted.status(), 'the public form should be accepted').toBe(201);
    const reference = (await submitted.json()).data.reference as string;
    expect(reference).toMatch(/^pil_/);

    // --- the admin half ----------------------------------------------------
    await signInAdminOnPage(page);
    await gotoHydrated(page, '/admin/pilot');

    await expect(page.getByRole('heading', { name: 'Pilot applications' })).toBeVisible();

    const card = page.locator('section', { hasText: applicant.fullName });
    await expect(card).toBeVisible();

    // The number was normalised on the way in, and the screen offers it as a
    // link because whoever works this list is going to call it.
    await expect(card.getByRole('link', { name: '+233240000000' })).toHaveAttribute(
      'href',
      'tel:+233240000000',
    );
    await expect(card.getByRole('link', { name: applicant.email })).toBeVisible();

    // Move the lead along.
    await card.getByPlaceholder('What happened? (optional)').fill('Called — keen to start.');
    await card.getByRole('button', { name: 'Contacted' }).click();

    // The default filter is what is still waiting, so a contacted lead leaves it.
    await expect(page.locator('section', { hasText: applicant.fullName })).toHaveCount(0);

    await page.getByRole('button', { name: 'Contacted', exact: true }).first().click();
    await expect(page.locator('section', { hasText: applicant.fullName })).toBeVisible();
  });

  test('an unauthenticated caller cannot read the applications', async ({ request }) => {
    const response = await request.get(`${API}/admin/pilot-applications`);

    // The whole reason the submit route is allowed to be open: what goes in
    // does not come back out without a session behind it.
    expect(response.status()).toBe(401);
  });

  test('a submission creates no account', async ({ request }) => {
    const id = runId();

    await request.post(`${API}/pilot-applications`, {
      data: {
        role: 'PHARMACY',
        fullName: `Counter ${id}`,
        phone: '0200000001',
        email: `pharm-${id}@example.com`,
        organisation: `Pharmacy ${id}`,
        location: 'Tema',
        consent: true,
      },
    });

    // If the lead had quietly become an account, it would be able to sign in.
    const login = await request.post(`${API}/auth/login`, {
      data: { email: `pharm-${id}@example.com`, password: 'anything-at-all' },
    });

    expect(login.ok()).toBeFalsy();

    // And it must not show up as a pharmacy awaiting verification either.
    // signInAdmin authenticates the request context itself.
    await signInAdmin(request);
    const pharmacies = await request.get(`${API}/admin/pharmacies?search=${id}`);

    expect((await pharmacies.json()).data).toHaveLength(0);
  });
});
