import { readFile } from 'node:fs/promises';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { appByName, appUrl } from '../apps.js';
import { complianceSeed, preauthenticatedSession } from '../fixtures.js';
import { BROWSER_API_URL, directAdminApi } from '../staff.js';

const clientApp = appByName('client');
const opsApp = appByName('ops');
const CLIENT_ORIGIN = `http://localhost:${clientApp.port}`;
// Synthetic file: PDF magic bytes only, no identity data.
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
 * PR-12. Synthetic rules, countries, passengers and files only. No real
 * regulatory requirement exists anywhere: NO_MATCHING_RULE != COMPLIANT.
 */
test.describe('PR-12 compliance', () => {
  test.describe.configure({ mode: 'serial' });

  test('customer sees a compliance summary that never turns a technical file into compliance', async ({
    browser,
    page,
  }) => {
    test.setTimeout(120_000);
    const errors = trackPageErrors(page);
    const seed = complianceSeed();
    await addSessionCookie(
      page.context(),
      'customer',
      preauthenticatedSession('complianceCustomer'),
    );
    await page.goto(appUrl(clientApp, '/compte'));

    const passengers = page.getByTestId('customer-passengers');
    await passengers.getByLabel('Réservation confirmée').selectOption(seed.bookingReference);
    await passengers.getByLabel('Prénom', { exact: true }).fill('Aminata');
    await passengers.getByLabel('Nom', { exact: true }).fill('Sarr');
    await passengers.getByLabel('Date de naissance').fill('1988-11-04');
    await passengers.getByRole('button', { name: 'Ajouter le voyageur' }).click();
    await expect(passengers.getByRole('status')).toContainText('Voyageur Aminata Sarr ajouté.');
    const article = passengers.getByRole('article').filter({ hasText: 'Aminata Sarr' });
    passengerReference =
      ((await article.textContent()) ?? '').match(/ETV-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}/)?.[0] ?? '';
    expect(passengerReference).toMatch(/^ETV-/);
    await passengers.getByLabel('Voyageur').selectOption(passengerReference);
    await passengers.getByLabel('Type de document').selectOption('PASSPORT');
    await passengers.getByLabel('Fichier PDF, JPEG ou PNG — 10 Mio maximum').setInputFiles({
      name: 'passeport-conformite-synthetique.pdf',
      mimeType: 'application/pdf',
      buffer: SAFE_PDF,
    });
    await passengers.getByRole('button', { name: 'Téléverser et analyser' }).click();
    const notice = passengers.getByRole('status');
    await expect(notice).toContainText('accepté techniquement', { timeout: 30_000 });
    documentReference =
      ((await notice.textContent()) ?? '').match(/ETD-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}/)?.[0] ?? '';
    expect(documentReference).toMatch(/^ETD-/);

    const compliance = page.getByTestId('customer-compliance');
    await expect(compliance).toContainText('« Fichier accepté techniquement » signifie seulement');
    await expect(compliance).toContainText('ce n’est pas un « document réglementaire validé »');
    await compliance.getByRole('button', { name: 'Actualiser' }).click();
    const card = compliance.getByTestId(`compliance-${passengerReference}`);
    await expect(card).toContainText('À vérifier');
    await card.getByRole('button', { name: 'Vérifier la conformité' }).click();
    // An ACCEPTED passport and no verified rule: review, never "compliant".
    await expect(card).toContainText('Revue en cours');
    await expect(card).toContainText(
      'Aucune règle publiée et vérifiée ne s’applique encore à ce voyage',
    );
    await expect(card).not.toContainText('Conforme');
    for (const forbidden of ['Voyage autorisé', 'Document validé', 'Approuvé pour le voyage']) {
      await expect(compliance).not.toContainText(forbidden);
    }

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
        `${BROWSER_API_URL}/v1/booking/bookings/${seed.bookingReference}/compliance`,
        { headers },
      );
      const unknown = await foreignPage.request.get(
        `${BROWSER_API_URL}/v1/booking/bookings/ETB-000000000000/compliance`,
        { headers },
      );
      expect(foreign.status()).toBe(404);
      const foreignBody = (await foreign.json()) as { code: string; message: string };
      const unknownBody = (await unknown.json()) as { code: string; message: string };
      expect([foreignBody.code, foreignBody.message]).toEqual([
        unknownBody.code,
        unknownBody.message,
      ]);
    } finally {
      await foreignContext.close();
    }
    expect(errors).toEqual([]);
  });

  test('compliance agent reviews the queue, opens the technical file and records a reasoned review', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const errors = trackPageErrors(page);
    expect(passengerReference).toMatch(/^ETV-/);
    const seed = complianceSeed();
    await addSessionCookie(
      page.context(),
      'staff',
      preauthenticatedSession('passengerDocumentReader'),
    );
    await page.goto(appUrl(opsApp, '/'));
    const group = page
      .getByRole('navigation', { name: 'Navigation principale' })
      .getByRole('list', {
        name: 'Conformité',
      });
    await expect(group.getByRole('link', { name: 'Documents passagers' })).toBeVisible();
    await expect(group.getByRole('link', { name: 'Règles réglementaires' })).toBeVisible();
    await group.getByRole('link', { name: 'Revues passagers' }).click();
    await expect(page).toHaveURL(appUrl(opsApp, '/compliance/reviews'));

    const workspace = page.getByTestId('compliance-reviews-workspace');
    await workspace.getByLabel('Référence réservation').fill(seed.bookingReference);
    await workspace.getByRole('button', { name: 'Filtrer' }).click();
    const row = workspace.getByRole('row').filter({ hasText: passengerReference });
    await expect(row).toContainText('Revue requise');
    await row.getByRole('button', { name: `Examiner ${passengerReference}` }).click();

    const detail = page.getByTestId('compliance-evaluation-detail');
    await expect(detail).toContainText(seed.bookingReference);
    await expect(detail).toContainText(seed.tripReference);
    await expect(detail).toContainText('NO_APPLICABLE_RULE');
    await expect(detail).toContainText('Aucune règle publiée et vérifiée ne s’applique');
    await expect(detail).toContainText('n’est pas une validation réglementaire');
    const downloadPromise = page.waitForEvent('download');
    await detail.getByRole('button', { name: `Ouvrir le document ${documentReference}` }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(`${documentReference}.pdf`);
    expect(await readFile((await download.path()) as string)).toEqual(SAFE_PDF);

    await expect(
      page.getByRole('button', { name: /forcer|bypass|ignorer|contourner/i }),
    ).toHaveCount(0);
    const submit = detail.getByRole('button', { name: 'Enregistrer la revue' });
    await expect(submit).toBeDisabled();
    await detail.getByLabel('Informations complémentaires requises').check();
    await detail
      .getByLabel('Motif interne (obligatoire)')
      .fill('Aucune règle vérifiée pour ce trajet synthétique : pièce complémentaire demandée.');
    await detail
      .getByLabel('Message au client (facultatif)')
      .fill('Merci de fournir une pièce complémentaire.');
    await submit.click();
    await expect(workspace.getByRole('status')).toContainText(
      'Revue enregistrée : Informations complémentaires requises.',
    );
    await expect(detail).toContainText('actuelle');
    await expect(detail.locator('.et-tag').first()).toHaveText(
      'Informations complémentaires requises',
    );
    expect(errors).toEqual([]);
  });

  test('staff without compliance permissions has no menu entry and receives 403', async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await addSessionCookie(
      page.context(),
      'staff',
      preauthenticatedSession('passengerDocumentDenied'),
    );
    await page.goto(appUrl(opsApp, '/'));
    const nav = page.getByRole('navigation', { name: 'Navigation principale' });
    await expect(nav.getByRole('link', { name: 'Revues passagers' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Règles réglementaires' })).toHaveCount(0);
    for (const path of ['/compliance/booking-passengers', '/compliance/rules']) {
      const refused = await directAdminApi(page.request).get(path);
      expect(refused.status(), path).toBe(403);
    }
    for (const path of ['/compliance/reviews', '/compliance/rules']) {
      await page.goto(appUrl(opsApp, path));
      await expect(
        page.getByText('Vous n’avez pas la permission d’afficher cette page.'),
      ).toBeVisible();
    }
    await expect(page.getByTestId('compliance-reviews-workspace')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('rule manager drafts, verifies and publishes a synthetic rule, then sees it read-only', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const errors = trackPageErrors(page);
    const seed = complianceSeed();
    await addSessionCookie(
      page.context(),
      'staff',
      preauthenticatedSession('complianceRuleManager'),
    );
    await page.goto(appUrl(opsApp, '/compliance/rules'));
    const workspace = page.getByTestId('compliance-rules-workspace');
    await expect(workspace).toContainText('Le code n’est pas une autorité juridique');

    const create = workspace.getByRole('form', { name: 'Créer une règle' });
    await create.getByLabel('Titre interne de la règle').fill(`Règle synthétique E2E ${seed.run}`);
    await create.getByLabel('Définition (langage de règle v1, JSON)').fill(
      JSON.stringify({
        language: 1,
        scope: { destinationCountries: [seed.ruleCountry] },
        requirement: { kind: 'DOCUMENT', documentType: 'PASSPORT' },
      }),
    );
    await create.getByLabel('Consigne affichée au client').fill('Consigne synthétique de test.');
    await create.getByLabel('Autorité source').fill('Autorité synthétique');
    await create.getByLabel('Titre du texte source').fill('Texte fictif de test');
    await create.getByLabel('URL officielle (https)').fill('https://regulations.example.test/e2e');
    await create.getByRole('button', { name: 'Créer le brouillon' }).click();
    await expect(workspace.getByRole('status')).toContainText(
      'Règle créée en brouillon non vérifié.',
    );

    const version = page
      .getByTestId('compliance-rule-detail')
      .getByTestId('compliance-rule-version-1');
    await expect(version).toContainText('Brouillon');
    await expect(version).toContainText('Source non vérifiée');
    const publish = version.getByRole('button', { name: 'Publier la version 1' });
    await expect(publish).toBeDisabled();
    await version.getByRole('button', { name: 'Marquer la source comme vérifiée' }).click();
    await expect(workspace.getByRole('status')).toContainText('Source de la version 1 vérifiée.');
    await expect(version).toContainText('Source vérifiée');
    await version.getByRole('button', { name: 'Publier la version 1' }).click();
    await expect(workspace.getByRole('status')).toContainText('Version 1 publiée.');
    await expect(version).toContainText('Publiée');
    await expect(version).toContainText('Version publiée : lecture seule');
    await expect(version.getByRole('button', { name: 'Enregistrer le brouillon' })).toHaveCount(0);
    await expect(
      version.getByRole('button', { name: 'Marquer la source comme vérifiée' }),
    ).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
