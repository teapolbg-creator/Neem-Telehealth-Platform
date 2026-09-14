import {
  test,
  expect,
  API,
  csrfHeaders,
  createActiveDoctor,
  gotoHydrated,
  shiftCoveringNow,
  signInAdmin,
  signInThroughUi,
} from './support/fixtures.ts';

/**
 * A doctor confirms today's shift from the dashboard (D51).
 *
 * The dashboard told doctors to confirm their shift and offered nothing to
 * press, so no doctor could, and an unconfirmed shift counts for nothing in the
 * queue. This assigns a shift the way an administrator does, then confirms it
 * the way a doctor now can.
 */
test('a doctor confirms today’s shift from the dashboard, and it stays confirmed', async ({
  page,
  playwright,
  run,
}) => {
  const doctorApi = await playwright.request.newContext();
  const adminApi = await playwright.request.newContext();

  const doctor = await createActiveDoctor(doctorApi, { run: `${run}conf` });

  const shiftCode = shiftCoveringNow();
  const serviceDate = new Date().toISOString().slice(0, 10);
  const adminCsrf = (await signInAdmin(adminApi)).csrf;

  // Idempotent; only matters for NIGHT, which is seeded inactive.
  await adminApi.patch(`${API}/admin/shifts/definitions/${shiftCode}`, {
    headers: csrfHeaders(adminCsrf),
    data: { isActive: true },
  });
  const assigned = await adminApi.post(`${API}/admin/shifts`, {
    headers: csrfHeaders(adminCsrf),
    data: { doctorPublicId: doctor.publicId, shiftCode, serviceDate },
  });
  expect(assigned.ok(), await assigned.text()).toBeTruthy();

  await signInThroughUi(page, doctor);
  await gotoHydrated(page, '/doctor');

  const warning = page.getByText(/you have an unconfirmed shift today/i);
  await expect(warning).toBeVisible();

  await page.getByRole('button', { name: 'Confirm shift' }).click();
  await expect(warning).toBeHidden({ timeout: 15_000 });

  // A reload is what proves the server changed, not only the screen.
  await gotoHydrated(page, '/doctor');
  await expect(page.getByText(/shift today,/i)).toBeVisible();
  await expect(page.getByText(/you have an unconfirmed shift today/i)).toHaveCount(0);

  await doctorApi.dispose();
  await adminApi.dispose();
});
