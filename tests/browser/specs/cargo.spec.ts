import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { appByName, appUrl } from '../apps.js';
import { preauthenticatedSession } from '../fixtures.js';
import { BROWSER_API_URL, directAdminApi } from '../staff.js';

const opsApp = appByName('ops');
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
