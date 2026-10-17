import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { API_URL, appByName, appUrl, frontendApps } from '../apps.js';
import { checkInSeed, paymentSeed, preauthenticatedSession } from '../fixtures.js';
import { paymentSearch } from '../payments.js';
import { BROWSER_API_URL } from '../staff.js';

const booking = appByName('booking');
const client = appByName('client');
const ops = appByName('ops');
const crew = appByName('crew');

async function sessionCookie(
  context: BrowserContext,
  realm: 'customer' | 'staff' | 'crew',
  token: string,
): Promise<void> {
  await context.addCookies([
    {
      name: `et_${realm}_session`,
      value: token,
      url: BROWSER_API_URL,
      httpOnly: true,
      secure: false,
      sameSite: 'Strict',
    },
  ]);
}

function pageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

test.describe('PR-25 pilot acceptance', () => {
  test('public surfaces, readiness and CSP satisfy the pilot baseline', async ({ page }) => {
    const ready = await page.request.get(`${API_URL}/health/ready`);
    expect(ready.status()).toBe(200);
    expect(await ready.json()).toEqual({ status: 'ok' });
    expect(ready.headers()['cache-control']).toBe('no-store');
    expect(ready.headers()['x-request-id']).toMatch(/^[0-9a-f-]{36}$/iu);

    for (const app of frontendApps) {
      const response = await page.request.get(appUrl(app, app.path));
      expect(response.status(), app.name).toBe(200);
      const csp = response.headers()['content-security-policy'] ?? '';
      expect(csp, `${app.name} CSP`).toContain("default-src 'self'");
      expect(csp, `${app.name} frame policy`).toContain("frame-ancestors 'none'");
      expect(csp, `${app.name} object policy`).toContain("object-src 'none'");
      expect(csp, `${app.name} CI CSP`).not.toContain("'unsafe-eval'");
    }
  });

  test('booking search exposes the seeded pilot trip without mutating inventory', async ({ page }) => {
    const seed = paymentSearch();
    const errors = pageErrors(page);
    await page.goto(appUrl(booking));
    await page.getByLabel('Origine', { exact: true }).selectOption({ label: seed.origin });
    await page.getByLabel('Destination', { exact: true }).selectOption({ label: seed.destination });
    await page.getByLabel('Date de départ', { exact: true }).fill(seed.departureDate);
    await page.getByRole('button', { name: 'Rechercher', exact: true }).click();
    await expect(
      page.getByRole('button', { name: `Choisir le voyage ${seed.tripReference}` }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('customer account exposes the confirmed synthetic booking', async ({ context, page }) => {
    const errors = pageErrors(page);
    await sessionCookie(context, 'customer', preauthenticatedSession('paymentCustomer'));
    await page.goto(appUrl(client, '/compte'));
    await expect(page.getByRole('heading', { name: 'Mon compte' })).toBeVisible();
    await expect(
      page.getByRole('article', { name: paymentSeed().confirmedBookingReference }),
    ).toContainText('Confirmée');
    expect(errors).toEqual([]);
  });

  test('OPS can reach dispatch and reporting with an authorized session', async ({
    context,
    page,
  }) => {
    const errors = pageErrors(page);
    await sessionCookie(context, 'staff', preauthenticatedSession('permitManager'));

    await page.goto(appUrl(ops, '/departure'));
    await expect(page.getByTestId('departure-workspace')).toBeVisible();
    await expect(page.getByLabel('Référence du voyage')).toBeVisible();

    await page.goto(appUrl(ops, '/reporting'));
    await expect(page.getByTestId('reporting-workspace')).toBeVisible();
    await expect(page.getByText('Reporting opérationnel', { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('Crew opens the assigned synthetic trip with a valid session', async ({ context, page }) => {
    const errors = pageErrors(page);
    await sessionCookie(context, 'crew', preauthenticatedSession('crew'));
    await page.goto(appUrl(crew, '/session'));
    await expect(page.getByRole('heading', { name: 'Opérations équipage' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Voyage', exact: true })).toHaveValue(
      checkInSeed().crewTripReference,
    );
    await expect(page.getByText('En ligne', { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });
});
