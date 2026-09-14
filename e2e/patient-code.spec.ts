import type { Page } from '@playwright/test';
import {
  test,
  expect,
  API,
  DEMO,
  csrfHeaders,
  gotoHydrated,
  signInThroughUi,
} from './support/fixtures.ts';

/**
 * The patient code, from the consultation page (D48).
 *
 * "New consultation" shows the code once, at its end. A pharmacist who left
 * that screen had no way back to it, although the API has always issued a
 * replacement. These drive the page as the pharmacy would; the consultation is
 * created and paid through the same session's API calls, with the mock
 * provider.
 */

async function csrfOf(page: Page): Promise<string> {
  const cookie = (await page.context().cookies()).find((entry) => entry.name === 'neem_csrf');
  if (!cookie) throw new Error('No CSRF cookie after sign-in');
  return cookie.value;
}

async function createConsultation(page: Page, { paid }: { paid: boolean }): Promise<string> {
  const headers = csrfHeaders(await csrfOf(page));

  const created = await page.request.post(`${API}/pharmacy/consultations`, { headers, data: {} });
  expect(created.ok()).toBeTruthy();
  const publicId = (await created.json()).data.publicId as string;

  if (paid) {
    await page.request.post(`${API}/pharmacy/consultations/${publicId}/payment`, {
      headers,
      data: {},
    });
    const settled = await page.request.post(
      `${API}/pharmacy/consultations/${publicId}/payment/simulate`,
      { headers, data: { outcome: 'SUCCESS' } },
    );
    expect(settled.ok()).toBeTruthy();
  }

  return publicId;
}

test.describe('the patient code on the consultation page', () => {
  test('is offered once paid, and replaces any earlier code', async ({ page, playwright }) => {
    await signInThroughUi(page, DEMO.pharmacy);
    const publicId = await createConsultation(page, { paid: true });

    // A code issued earlier — as "New consultation" would have shown.
    const earlier = await page.request.post(`${API}/pharmacy/consultations/${publicId}/qr`, {
      headers: csrfHeaders(await csrfOf(page)),
      data: {},
    });
    const earlierToken = ((await earlier.json()).data.url as string).split('/s/')[1]!;

    await gotoHydrated(page, `/pharmacy/consultations/${publicId}`);
    await page.getByRole('button', { name: 'Show patient code' }).click();

    await expect(
      page.getByRole('heading', { name: 'Ask the patient to scan this code' }),
    ).toBeVisible();
    await expect(page.getByAltText('Consultation QR code')).toBeVisible();

    // The page's warning is true: the earlier code no longer opens anything.
    const patient = await playwright.request.newContext();
    const exchange = await patient.post(`${API}/s/exchange`, { data: { token: earlierToken } });
    expect(exchange.ok()).toBeFalsy();
    await patient.dispose();
  });

  test('is not offered before payment', async ({ page }) => {
    await signInThroughUi(page, DEMO.pharmacy);
    const publicId = await createConsultation(page, { paid: false });

    await gotoHydrated(page, `/pharmacy/consultations/${publicId}`);
    await expect(page.getByText(publicId)).toBeVisible();

    await expect(page.getByRole('button', { name: 'Show patient code' })).toHaveCount(0);
  });
});
