import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { appByName, appUrl } from '../apps.js';
import { baggageSeed, preauthenticatedSession } from '../fixtures.js';
import { BROWSER_API_URL, directAdminApi } from '../staff.js';

const clientApp = appByName('client');
const opsApp = appByName('ops');
const CLIENT_ORIGIN = `http://localhost:${clientApp.port}`;
const BAGGAGE_REFERENCE = /ETG-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}/;

let baggageReference = '';

function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

async function addSessionCookie(
  context: BrowserContext,
  realm: 'customer' | 'staff',
  token: string,
) {
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

/**
 * PR-13. A dedicated customer, trip, booking and traveller: nothing is shared
 * with the PR-10/PR-11/PR-12 scenarios. No tariff, payment or allowance.
 */
test.describe('PR-13 baggage', () => {
  test.describe.configure({ mode: 'serial' });

  test('customer registers a bag on the own confirmed booking and sees reference, QR and status', async ({
    browser,
    page,
  }) => {
    const errors = trackPageErrors(page);
    const seed = baggageSeed();
    await addSessionCookie(page.context(), 'customer', preauthenticatedSession('baggageCustomer'));
    await page.goto(appUrl(clientApp, '/compte'));

    const section = page.getByTestId('customer-baggage');
    await expect(section).toContainText('Aucune franchise ni aucun supplément bagage');
    await section
      .getByLabel('Voyageur et réservation')
      .selectOption(`${seed.bookingReference}|${seed.passengerReference}`);
    await section.getByLabel('Type de bagage').selectOption('SUITCASE');
    await section.getByRole('button', { name: 'Enregistrer le bagage' }).click();
    const notice = section.getByRole('status');
    await expect(notice).toContainText(/Bagage ETG-[0-9A-Z]{12} enregistré\./);
    baggageReference = ((await notice.textContent()) ?? '').match(BAGGAGE_REFERENCE)?.[0] ?? '';
    expect(baggageReference).toMatch(BAGGAGE_REFERENCE);

    const card = section.getByTestId(`baggage-${baggageReference}`);
    await expect(card).toContainText(baggageReference);
    await expect(card).toContainText('Enregistré');
    await expect(card).toContainText('Valise de Coumba Bagages');
    await expect(card).toContainText('poids mesuré : Non pesé');
    // The customer has no weight or event control.
    await expect(section.getByLabel(/Poids/)).toHaveCount(0);

    await card.getByRole('button', { name: 'Afficher le QR code' }).click();
    const qr = card.getByRole('img', { name: `QR code du bagage ${baggageReference}` });
    await expect(qr).toBeVisible();
    const source = decodeURIComponent((await qr.getAttribute('src')) ?? '');
    expect(source.startsWith('data:image/svg+xml;charset=utf-8,<svg')).toBe(true);
    for (const personal of ['Coumba', 'Bagages', seed.bookingReference, seed.passengerReference]) {
      expect(source).not.toContain(personal);
    }
    await expect(card).toContainText('Il ne donne aucun droit.');

    await card.getByRole('button', { name: 'Voir l’historique' }).click();
    const history = card.getByRole('list', { name: `Historique du bagage ${baggageReference}` });
    await expect(history.getByRole('listitem')).toHaveCount(1);
    await expect(history).toContainText('Enregistré');

    // A foreign customer gets exactly the unknown-bag answer.
    const foreignContext = await browser.newContext();
    try {
      await addSessionCookie(
        foreignContext,
        'customer',
        preauthenticatedSession('foreignCustomer'),
      );
      const foreignPage = await foreignContext.newPage();
      const headers = { Origin: CLIENT_ORIGIN };
      const foreign = await foreignPage.request.get(
        `${BROWSER_API_URL}/v1/booking/baggage/${baggageReference}`,
        { headers },
      );
      const unknown = await foreignPage.request.get(
        `${BROWSER_API_URL}/v1/booking/baggage/ETG-000000000000`,
        { headers },
      );
      expect(foreign.status()).toBe(404);
      const foreignBody = (await foreign.json()) as { code: string; message: string };
      const unknownBody = (await unknown.json()) as { code: string; message: string };
      expect({ code: foreignBody.code, message: foreignBody.message }).toEqual({
        code: unknownBody.code,
        message: unknownBody.message,
      });
      expect(foreignBody.code).toBe('BAGGAGE_NOT_FOUND');
    } finally {
      await foreignContext.close();
    }
    expect(errors).toEqual([]);
  });

  test('OPS finds the bag, records an exact weight and an event, and reads the timeline', async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    expect(baggageReference).toMatch(BAGGAGE_REFERENCE);
    const seed = baggageSeed();
    // DISPATCHER: baggage.read and baggage.manage, without any booking permission.
    await addSessionCookie(page.context(), 'staff', preauthenticatedSession('baggageManager'));
    await page.goto(appUrl(opsApp, '/'));
    const nav = page.getByRole('navigation', { name: 'Navigation principale' });
    await expect(nav.getByRole('link', { name: 'Réservations' })).toHaveCount(0);
    await nav.getByRole('link', { name: 'Bagages' }).click();
    await expect(page).toHaveURL(appUrl(opsApp, '/baggage'));

    const workspace = page.getByTestId('baggage-workspace');
    await workspace.getByLabel('Référence bagage').fill(baggageReference.toLowerCase());
    await workspace.getByRole('button', { name: 'Filtrer' }).click();
    const row = workspace.getByRole('row').filter({ hasText: baggageReference });
    await expect(row).toContainText('Enregistré');
    await expect(row).toContainText('Non pesé');
    await row.getByRole('button', { name: 'Consulter' }).click();

    const detail = page.getByTestId('baggage-detail');
    await expect(detail).toContainText(`Bagage ${baggageReference}`);
    await expect(detail).toContainText('Coumba Bagages');
    await expect(detail).toContainText(seed.bookingReference);
    await expect(detail).toContainText(seed.tripReference);
    await expect(detail).toContainText('Aucune franchise ni aucun supplément');

    await detail.getByLabel('Poids mesuré (kg)').fill('12,345');
    await detail.getByRole('button', { name: 'Enregistrer le poids' }).click();
    await expect(workspace.getByRole('status')).toContainText(
      'Événement « Pesée » enregistré (n° 2).',
    );
    await expect(detail.getByTestId('baggage-weight')).toHaveText('12,345 kg');

    await detail.getByLabel('Événement', { exact: true }).selectOption('CHECKED_IN');
    await detail.getByRole('button', { name: 'Enregistrer l’événement' }).click();
    await expect(workspace.getByRole('status')).toContainText(
      'Événement « Pris en charge » enregistré (n° 3).',
    );
    await expect(detail.locator('.et-tag').first()).toHaveText('Pris en charge');

    // An invalid transition is refused by the server and changes nothing.
    await detail.getByLabel('Événement', { exact: true }).selectOption('DELIVERED');
    await detail.getByRole('button', { name: 'Enregistrer l’événement' }).click();
    await expect(detail.getByRole('alert')).toContainText(
      'Cette transition de bagage n’est pas autorisée.',
    );

    const timeline = detail.getByTestId('baggage-timeline');
    await expect(timeline.locator('tbody tr')).toHaveCount(3);
    await expect(timeline.locator('tbody tr').nth(0)).toContainText('Enregistré');
    await expect(timeline.locator('tbody tr').nth(1)).toContainText('Pesée');
    await expect(timeline.locator('tbody tr').nth(1)).toContainText('12,345 kg');
    await expect(timeline.locator('tbody tr').nth(2)).toContainText('Pris en charge');

    await detail.getByRole('button', { name: 'Afficher l’étiquette QR' }).click();
    await expect(
      detail.getByRole('img', { name: `QR code du bagage ${baggageReference}` }),
    ).toBeVisible();

    // The scanned payload only identifies the bag; the lookup is authenticated.
    await workspace.getByLabel('Code QR scanné').fill(`ETG1:${baggageReference}`);
    await workspace.getByRole('button', { name: 'Rechercher le bagage' }).click();
    await expect(detail).toContainText(`Bagage ${baggageReference}`);
    await expect(detail.getByTestId('baggage-weight')).toHaveText('12,345 kg');
    expect(errors).toEqual([]);
  });

  test('staff without baggage permissions has no menu entry, no page and receives 403', async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    // COMPLIANCE_AGENT: compliance and passenger-document reads, no baggage grant.
    await addSessionCookie(page.context(), 'staff', preauthenticatedSession('baggageDenied'));
    await page.goto(appUrl(opsApp, '/'));
    const nav = page.getByRole('navigation', { name: 'Navigation principale' });
    await expect(nav.getByRole('link', { name: 'Revues passagers' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Bagages' })).toHaveCount(0);

    const api = directAdminApi(page.request);
    expect((await api.get('/baggage')).status()).toBe(403);
    expect((await api.get('/baggage/ETG-000000000000')).status()).toBe(403);
    expect(
      (await api.post('/baggage/ETG-000000000000/events', { type: 'CHECKED_IN' })).status(),
    ).toBe(403);
    expect(
      (await api.post('/baggage/ETG-000000000000/weight', { measuredWeightKg: '1.000' })).status(),
    ).toBe(403);

    await page.goto(appUrl(opsApp, '/baggage'));
    await expect(
      page.getByText('Vous n’avez pas la permission d’afficher cette page.'),
    ).toBeVisible();
    await expect(page.getByTestId('baggage-workspace')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
