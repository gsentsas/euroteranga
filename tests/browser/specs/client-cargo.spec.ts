import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { appByName, appUrl } from '../apps.js';
import { preauthenticatedSession } from '../fixtures.js';
import { BROWSER_API_URL, directAdminApi } from '../staff.js';

const clientApp = appByName('client');
const CARGO_REFERENCE = /ETC-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}/;

function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

async function addSessionCookie(
  context: BrowserContext,
  name: 'et_customer_session' | 'et_staff_session',
  token: string,
) {
  await context.addCookies([
    {
      name,
      value: token,
      url: BROWSER_API_URL,
      httpOnly: true,
      secure: false,
      sameSite: 'Strict',
    },
  ]);
}

test.describe('CLIENT-CARGO-1 customer workspace', () => {
  test('customer creates, tracks and accepts an issued cargo quote without payment', async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await addSessionCookie(
      page.context(),
      'et_customer_session',
      preauthenticatedSession('paymentCustomer'),
    );
    await page.goto(appUrl(clientApp, '/compte'));

    await expect(page.getByRole('heading', { name: 'Mes bagages' })).toBeVisible();
    const cargo = page.getByTestId('customer-cargo');
    await expect(cargo.getByRole('heading', { name: 'Mes colis' })).toBeVisible();

    const form = cargo.getByRole('form', { name: 'Créer une demande colis/fret' });
    await form.getByLabel('Expéditeur', { exact: true }).fill('Awa Client Cargo');
    await form.getByLabel('Contact expéditeur').fill('+33123456789');
    await form.getByLabel('Destinataire', { exact: true }).fill('Moussa Client Cargo');
    await form.getByLabel('Contact destinataire').fill('+221771234567');
    await form.getByLabel('Poids (kg)').fill('37,250');
    await form.getByLabel('Volume (litres)').fill('420');
    await form.getByLabel('Nombre de pièces').fill('3');
    await form.getByLabel('Contenu déclaré').fill('Effets personnels test CLIENT-CARGO');
    await form.getByLabel('Envoi fragile').check();
    await form.getByLabel('Collecte souhaitée').check();
    await form.getByRole('button', { name: 'Créer la demande' }).click();

    const notice = cargo.getByRole('status');
    await expect(notice).toContainText(/Demande ETC-[0-9A-Z]{12} créée/);
    const reference = ((await notice.textContent()) ?? '').match(CARGO_REFERENCE)?.[0] ?? '';
    expect(reference).toMatch(CARGO_REFERENCE);

    await expect(cargo.getByTestId(`customer-cargo-${reference}`)).toContainText(
      'Devis en préparation',
    );
    const detail = cargo.getByTestId('customer-cargo-detail');
    await expect(detail).toContainText(reference);
    await expect(detail).toContainText('Awa Client Cargo');
    await expect(detail).toContainText('+33123456789');
    await expect(detail).toContainText('Préparation');
    await expect(detail).toContainText(
      'Les pièces éventuelles sont confirmées par l’équipe selon la nature de l’envoi',
    );

    await addSessionCookie(
      page.context(),
      'et_staff_session',
      preauthenticatedSession('permitManager'),
    );
    const admin = directAdminApi(page.request);
    const draft = await admin.post(`/cargo/${reference}/quotes`, {
      currencyCode: 'EUR',
      currencyMinorUnit: 2,
      lines: [
        {
          kind: 'CHARGE',
          label: 'Transport fret',
          amountMinor: '18500',
          notes: 'BROWSER-PRIVATE-OPS-NOTE',
        },
        { kind: 'DISCOUNT', label: 'Remise commerciale', amountMinor: '1000' },
      ],
    });
    expect(draft.status()).toBe(201);
    const draftJson = (await draft.json()) as { reference: string };
    const quoteReference = draftJson.reference;

    await cargo.getByRole('button', { name: `Consulter ${reference}` }).click();
    await expect(detail).toContainText('Aucun devis n’a encore été émis.');
    await expect(page.locator('body')).not.toContainText('BROWSER-PRIVATE-OPS-NOTE');

    const issued = await admin.post(`/cargo/${reference}/quotes/${quoteReference}/issue`, {});
    expect(issued.status()).toBe(200);

    await cargo.getByRole('button', { name: `Consulter ${reference}` }).click();
    const customerQuote = cargo.getByTestId(`customer-cargo-quote-${quoteReference}`);
    await expect(customerQuote).toBeVisible();
    await expect(customerQuote).toContainText('175,00 EUR');
    await expect(customerQuote).toContainText('ISSUED');
    await expect(page.locator('body')).not.toContainText('BROWSER-PRIVATE-OPS-NOTE');

    await customerQuote
      .getByRole('button', { name: `Accepter le devis ${quoteReference}` })
      .click();
    await expect(cargo.getByRole('status')).toContainText(
      `Devis ${quoteReference} accepté. Aucun paiement n’a été déclenché.`,
    );
    await expect(customerQuote).toContainText('ACCEPTED');

    const body = await cargo.innerText();
    expect(body).not.toContain('customerIdentityId');
    expect(body).not.toContain('trackingTokens');
    expect(body).not.toContain('tokenHash');
    expect(errors).toEqual([]);
  });
});
