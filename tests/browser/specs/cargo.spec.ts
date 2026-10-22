import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { appByName, appUrl } from '../apps.js';
import { preauthenticatedSession } from '../fixtures.js';
import { BROWSER_API_URL, directAdminApi } from '../staff.js';

const opsApp = appByName('ops');
const trackingApp = appByName('tracking');
const CARGO_REFERENCE = /ETC-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}/;

function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

async function addSessionCookie(context: BrowserContext, token: string) {
  await context.addCookies([
    {
      name: 'et_staff_session',
      value: token,
      url: BROWSER_API_URL,
      httpOnly: true,
      secure: false,
      sameSite: 'Strict',
    },
  ]);
}

test.describe('CARGO-1 OPS workspace', () => {
  test('DISPATCHER creates and progresses an unassigned Paris-Dakar freight record', async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await addSessionCookie(page.context(), preauthenticatedSession('baggageManager'));
    await page.goto(appUrl(opsApp, '/'));

    const nav = page.getByRole('navigation', { name: 'Navigation principale' });
    await nav.getByRole('link', { name: 'Colis & fret' }).click();
    await expect(page).toHaveURL(appUrl(opsApp, '/cargo'));

    const workspace = page.getByTestId('cargo-workspace');
    const create = workspace.getByRole('form', { name: 'Créer un colis ou fret' });
    await create.getByLabel('Expéditeur', { exact: true }).fill('Awa Cargo');
    await create.getByLabel('Contact expéditeur').fill('+33102030405');
    await create.getByLabel('Destinataire', { exact: true }).fill('Moussa Cargo');
    await create.getByLabel('Contact destinataire').fill('+221770102030');
    await create.getByLabel('Poids (kg)').fill('25,500');
    await create.getByLabel('Volume (litres)').fill('320');
    await create.getByLabel('Nombre de pièces').fill('2');
    await create.getByLabel('Contenu déclaré').fill('Effets personnels');
    await create.getByRole('button', { name: 'Créer' }).click();

    const notice = workspace.getByRole('status');
    await expect(notice).toContainText(/Fret ETC-[0-9A-Z]{12} créé./);
    const reference = ((await notice.textContent()) ?? '').match(CARGO_REFERENCE)?.[0] ?? '';
    expect(reference).toMatch(CARGO_REFERENCE);

    const detail = page.getByTestId('cargo-detail');
    await expect(detail).toContainText(reference);
    await expect(detail).toContainText('Demande / devis');
    await expect(detail.getByTestId('cargo-weight')).toHaveText('25,500 kg');

    await detail.getByLabel('Événement', { exact: true }).selectOption('BOOKED');
    await detail.getByRole('button', { name: 'Enregistrer l’événement' }).click();
    await expect(workspace.getByRole('status')).toContainText('Réserver');

    await detail.getByLabel('Événement', { exact: true }).selectOption('RECEIVED');
    await detail.getByRole('button', { name: 'Enregistrer l’événement' }).click();
    await expect(detail.locator('.et-tag').first()).toHaveText('Reçu');
    await expect(detail.getByTestId('cargo-timeline').locator('tbody tr')).toHaveCount(3);
    await expect(detail.getByTestId('cargo-quotes')).toBeVisible();
    await expect(detail.getByRole('form', { name: 'Créer un devis fret' })).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('OPS_MANAGER creates, issues and accepts a freight quote without payment', async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await addSessionCookie(page.context(), preauthenticatedSession('permitManager'));
    await page.goto(appUrl(opsApp, '/cargo'));

    const workspace = page.getByTestId('cargo-workspace');
    const createCargo = workspace.getByRole('form', { name: 'Créer un colis ou fret' });
    await createCargo.getByLabel('Expéditeur', { exact: true }).fill('Awa Pricing');
    await createCargo.getByLabel('Contact expéditeur').fill('+33101010101');
    await createCargo.getByLabel('Destinataire', { exact: true }).fill('Moussa Pricing');
    await createCargo.getByLabel('Contact destinataire').fill('+221770000001');
    await createCargo.getByLabel('Poids (kg)').fill('40,000');
    await createCargo.getByLabel('Volume (litres)').fill('450');
    await createCargo.getByLabel('Nombre de pièces').fill('3');
    await createCargo.getByLabel('Contenu déclaré').fill('Fret commercial test');
    await createCargo.getByRole('button', { name: 'Créer' }).click();

    const detail = page.getByTestId('cargo-detail');
    const quotes = detail.getByTestId('cargo-quotes');
    await expect(quotes).toBeVisible();

    const createQuote = quotes.getByRole('form', { name: 'Créer un devis fret' });
    await createQuote.getByLabel('Devise').fill('EUR');
    await createQuote.getByLabel('Libellé').fill('Transport Paris Dakar');
    await createQuote.getByLabel('Montant (EUR)').fill('125,50');
    await createQuote.getByRole('button', { name: 'Créer le brouillon' }).click();

    await expect(quotes.getByRole('status')).toContainText('Brouillon de devis créé.');
    await expect(quotes.getByTestId('cargo-quote-detail')).toContainText('125,50 EUR');
    await expect(quotes.getByTestId('cargo-quote-detail')).toContainText(/ETCQ-[0-9A-Z]{12}/);

    await quotes.getByRole('button', { name: 'Émettre le devis' }).click();
    await expect(quotes.getByRole('status')).toContainText('Devis émis.');

    await quotes.getByRole('button', { name: 'Accepter le devis' }).click();
    await expect(quotes.getByRole('status')).toContainText(
      'Devis accepté. Aucun paiement n’a été déclenché.',
    );
    await expect(quotes).toContainText('Accepté');
    await expect(quotes).toContainText('Paiement non déclenché');
    expect(errors).toEqual([]);
  });

  test('OPS creates a privacy-safe public cargo link and revokes it', async ({ page }) => {
    const errors = trackPageErrors(page);
    await addSessionCookie(page.context(), preauthenticatedSession('permitManager'));
    const api = directAdminApi(page.request);
    const created = await api.post('/cargo', {
      direction: 'PAR_DKR',
      senderName: 'PRIVATE BROWSER SENDER',
      senderContact: '+33199999999',
      recipientName: 'PRIVATE BROWSER RECIPIENT',
      recipientContact: '+221779999999',
      weightKg: '12.500',
      volumeLiters: 80,
      packageCount: 2,
      declaredContents: 'PRIVATE BROWSER CONTENT',
      fragile: false,
      professional: false,
      pickupRequired: false,
      deliveryRequired: false,
    });
    expect(created.status()).toBe(201);
    const reference = ((await created.json()) as { reference: string }).reference;

    await page.goto(appUrl(opsApp, '/cargo'));
    const workspace = page.getByTestId('cargo-workspace');
    const row = workspace
      .locator('section[aria-labelledby="cargo-list-title"]')
      .getByRole('row')
      .filter({ hasText: reference });
    await row.getByRole('button', { name: 'Consulter' }).click();

    const trackingPanel = workspace.getByTestId('cargo-tracking-panel');
    await expect(trackingPanel).toBeVisible();
    await expect(trackingPanel.locator('img')).toBeVisible();
    await trackingPanel.getByRole('button', { name: 'Créer un lien de suivi public' }).click();

    const issued = trackingPanel.getByTestId('cargo-issued-tracking-link');
    await expect(issued).toBeVisible();
    const issuedText = (await issued.textContent()) ?? '';
    const token = issuedText.match(/[A-Za-z0-9_-]{43}/)?.[0] ?? '';
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    await page.goto(appUrl(trackingApp, `/cargo/${token}`));
    await expect(page.getByTestId('public-cargo-tracking')).toBeVisible();
    await expect(page.getByRole('heading', { name: reference })).toBeVisible();
    const publicBody = await page.locator('body').innerText();
    expect(publicBody).not.toContain('PRIVATE BROWSER SENDER');
    expect(publicBody).not.toContain('PRIVATE BROWSER RECIPIENT');
    expect(publicBody).not.toContain('PRIVATE BROWSER CONTENT');
    expect(publicBody).not.toContain('+33199999999');
    expect(publicBody).not.toContain('+221779999999');
    expect(publicBody).not.toContain('GPS précise');

    const listed = await api.get(`/cargo/${reference}/tracking-tokens`);
    expect(listed.status()).toBe(200);
    const tokens = (await listed.json()) as { items: Array<{ id: string; revokedAt: string | null }> };
    expect(tokens.items).toHaveLength(1);
    expect(JSON.stringify(tokens)).not.toContain(token);

    const revoked = await api.post(
      `/cargo/${reference}/tracking-tokens/${tokens.items[0]!.id}/revoke`,
      { reason: 'Fin du partage navigateur' },
    );
    expect(revoked.status()).toBe(200);

    await page.reload();
    await expect(page.getByTestId('cargo-tracking-unavailable')).toBeVisible();
    await expect(page.getByTestId('public-cargo-tracking')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('switching shipments resets unsaved quote form state', async ({ page }) => {
    const errors = trackPageErrors(page);
    await addSessionCookie(page.context(), preauthenticatedSession('permitManager'));
    const api = directAdminApi(page.request);
    const createCargo = (suffix: string) =>
      api.post('/cargo', {
        direction: 'PAR_DKR',
        senderName: `Expéditeur ${suffix}`,
        senderContact: '+33101010101',
        recipientName: `Destinataire ${suffix}`,
        recipientContact: '+221770000001',
        weightKg: '10.000',
        volumeLiters: 100,
        packageCount: 1,
        declaredContents: `Fret isolation devis ${suffix}`,
        fragile: false,
        professional: false,
        pickupRequired: false,
        deliveryRequired: false,
      });
    const [first, second] = await Promise.all([createCargo('A'), createCargo('B')]);
    expect(first.status()).toBe(201);
    expect(second.status()).toBe(201);
    const firstReference = ((await first.json()) as { reference: string }).reference;
    const secondReference = ((await second.json()) as { reference: string }).reference;

    await page.goto(appUrl(opsApp, '/cargo'));
    const workspace = page.getByTestId('cargo-workspace');
    const cargoList = workspace.locator('section[aria-labelledby="cargo-list-title"]');

    const firstRow = cargoList.getByRole('row').filter({ hasText: firstReference });
    await expect(firstRow).toBeVisible();
    await firstRow.getByRole('button', { name: 'Consulter' }).click();

    const firstQuoteForm = workspace
      .getByTestId('cargo-quotes')
      .getByRole('form', { name: 'Créer un devis fret' });
    await firstQuoteForm.getByLabel('Devise').fill('XOF');
    await firstQuoteForm.getByLabel('Libellé').fill('Tarif temporaire fret A');
    await firstQuoteForm.getByLabel('Montant (XOF)').fill('9000');

    const secondRow = cargoList.getByRole('row').filter({ hasText: secondReference });
    await secondRow.getByRole('button', { name: 'Consulter' }).click();
    await expect(workspace.getByTestId('cargo-detail')).toContainText(secondReference);

    const secondQuoteForm = workspace
      .getByTestId('cargo-quotes')
      .getByRole('form', { name: 'Créer un devis fret' });
    await expect(secondQuoteForm.getByLabel('Devise')).toHaveValue('EUR');
    await expect(secondQuoteForm.getByLabel('Libellé')).toHaveValue('Transport fret');
    await expect(secondQuoteForm.getByLabel('Montant (EUR)')).toHaveValue('');
    expect(errors).toEqual([]);
  });

  test('staff without cargo.read has no menu, no workspace and receives 403', async ({ page }) => {
    const errors = trackPageErrors(page);
    await addSessionCookie(page.context(), preauthenticatedSession('baggageDenied'));
    await page.goto(appUrl(opsApp, '/'));
    const nav = page.getByRole('navigation', { name: 'Navigation principale' });
    await expect(nav.getByRole('link', { name: 'Colis & fret' })).toHaveCount(0);

    const api = directAdminApi(page.request);
    expect((await api.get('/cargo')).status()).toBe(403);
    expect((await api.post('/cargo', {})).status()).toBe(403);

    await page.goto(appUrl(opsApp, '/cargo'));
    await expect(
      page.getByText('Vous n’avez pas la permission d’afficher cette page.'),
    ).toBeVisible();
    await expect(page.getByTestId('cargo-workspace')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
