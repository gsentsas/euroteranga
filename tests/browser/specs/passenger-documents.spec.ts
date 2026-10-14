import { readFile } from 'node:fs/promises';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { appByName, appUrl } from '../apps.js';
import { paymentSeed, preauthenticatedSession } from '../fixtures.js';
import { BROWSER_API_URL, directAdminApi } from '../staff.js';

const clientApp = appByName('client');
const opsApp = appByName('ops');
const CLIENT_ORIGIN = `http://localhost:${clientApp.port}`;
const SAFE_PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n', 'utf8');

let passengerReference = '';
let documentReference = '';

function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

async function addSessionCookie(
  context: BrowserContext,
  realm: 'customer' | 'staff',
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

async function expectExactDownload(
  page: Page,
  buttonName: string,
  reference: string,
): Promise<void> {
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: buttonName, exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(`${reference}.pdf`);
  const path = await download.path();
  expect(path).not.toBeNull();
  expect(await readFile(path as string)).toEqual(SAFE_PDF);
}

test.describe('PR-11 passenger documents', () => {
  test.describe.configure({ mode: 'serial' });

  test('customer creates a passenger, uploads a private file and another customer cannot read it', async ({
    browser,
    page,
  }) => {
    test.setTimeout(120_000);
    const errors = trackPageErrors(page);
    await addSessionCookie(page.context(), 'customer', preauthenticatedSession('paymentCustomer'));
    await page.goto(appUrl(clientApp, '/compte'));

    const workspace = page.getByTestId('customer-passengers');
    await expect(workspace).toBeVisible();
    await workspace
      .getByLabel('Réservation confirmée')
      .selectOption(paymentSeed().confirmedBookingReference);
    await workspace.getByLabel('Prénom', { exact: true }).fill('Awa');
    await workspace.getByLabel('Nom', { exact: true }).fill('Ndiaye');
    await workspace.getByLabel('Date de naissance').fill('1990-02-03');
    await workspace.getByRole('button', { name: 'Ajouter le voyageur' }).click();
    await expect(workspace.getByRole('status')).toContainText('Voyageur Awa Ndiaye ajouté.');

    const passenger = workspace.getByRole('article').filter({ hasText: 'Awa Ndiaye' });
    await expect(passenger).toBeVisible();
    passengerReference =
      ((await passenger.textContent()) ?? '').match(/ETV-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}/)?.[0] ??
      '';
    expect(passengerReference).toMatch(/^ETV-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/);

    await workspace.getByLabel('Voyageur').selectOption(passengerReference);
    await workspace.getByLabel('Type de document').selectOption('PASSPORT');
    await workspace
      .getByLabel('Date d’expiration (facultative, sans validation réglementaire)')
      .fill('2032-12-31');
    await workspace.getByLabel('Fichier PDF, JPEG ou PNG — 10 Mio maximum').setInputFiles({
      // A real browser sends this name as raw UTF-8 (`’`, `é`): it must be accepted.
      name: 'passeport synthétique d’Awa.pdf',
      mimeType: 'application/pdf',
      buffer: SAFE_PDF,
    });
    await workspace.getByRole('button', { name: 'Téléverser et analyser' }).click();
    const notice = workspace.getByRole('status');
    await expect(notice).toContainText('accepté techniquement', { timeout: 30_000 });
    documentReference =
      ((await notice.textContent()) ?? '').match(/ETD-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}/)?.[0] ?? '';
    expect(documentReference).toMatch(/^ETD-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/);
    await expect(workspace).toContainText('sans valider sa conformité au voyage');
    await expect(passenger).toContainText('Fichier accepté techniquement');
    await expectExactDownload(page, 'Télécharger', documentReference);

    const foreignContext = await browser.newContext();
    try {
      await addSessionCookie(
        foreignContext,
        'customer',
        preauthenticatedSession('foreignCustomer'),
      );
      const foreignPage = await foreignContext.newPage();
      const denied = await foreignPage.request.get(
        `${BROWSER_API_URL}/v1/booking/documents/${documentReference}/download`,
        { headers: { Origin: CLIENT_ORIGIN } },
      );
      expect(denied.status()).toBe(404);
      expect(((await denied.json()) as { code: string }).code).toBe('PASSENGER_DOCUMENT_NOT_FOUND');
    } finally {
      await foreignContext.close();
    }
    expect(errors).toEqual([]);
  });

  test('authorized OPS profile sees metadata and downloads the exact private bytes', async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    expect(documentReference).toMatch(/^ETD-/);
    await addSessionCookie(
      page.context(),
      'staff',
      preauthenticatedSession('passengerDocumentReader'),
    );
    await page.goto(appUrl(opsApp, '/'));
    const mainNav = page.getByRole('navigation', { name: 'Navigation principale' });
    await mainNav.getByRole('link', { name: 'Documents passagers' }).click();
    await expect(page).toHaveURL(appUrl(opsApp, '/passenger-documents'));
    const workspace = page.getByTestId('passenger-documents-workspace');
    await expect(workspace).toBeVisible();

    const row = workspace.getByRole('row').filter({ hasText: documentReference });
    await expect(row).toContainText(passengerReference);
    await expect(row).toContainText('Accepté techniquement');
    await row.getByRole('button', { name: 'Consulter' }).click();
    const detail = page.getByTestId('passenger-document-detail');
    await expect(detail).toContainText(documentReference);
    await expect(detail).toContainText('ne conclut ni à la validité juridique');
    await expect(page.getByRole('button', { name: /approuver|valider/i })).toHaveCount(0);
    await expectExactDownload(page, 'Télécharger le fichier privé', documentReference);

    const apiDetail = await directAdminApi(page.request).get(
      `/passenger-documents/${documentReference}`,
    );
    expect(apiDetail.status()).toBe(200);
    expect(((await apiDetail.json()) as { reference: string }).reference).toBe(documentReference);
    expect(errors).toEqual([]);
  });

  test('OPS profile without passenger.document.read has no menu and receives 403', async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await addSessionCookie(
      page.context(),
      'staff',
      preauthenticatedSession('passengerDocumentDenied'),
    );
    await page.goto(appUrl(opsApp, '/'));
    const mainNav = page.getByRole('navigation', { name: 'Navigation principale' });
    await expect(mainNav.getByRole('link', { name: 'Documents passagers' })).toHaveCount(0);

    const refused = await directAdminApi(page.request).get('/passenger-documents');
    expect(refused.status()).toBe(403);
    expect(((await refused.json()) as { code: string }).code).toBe('FORBIDDEN');
    await page.goto(appUrl(opsApp, '/passenger-documents'));
    await expect(
      page.getByText('Vous n’avez pas la permission d’afficher cette page.'),
    ).toBeVisible();
    await expect(page.getByTestId('passenger-documents-workspace')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
