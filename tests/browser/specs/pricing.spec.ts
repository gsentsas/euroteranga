import { expect, test, type Page } from '@playwright/test';
import { appByName, appUrl } from '../apps.js';
import { FIXTURES, pricingSeed, tripSeed } from '../fixtures.js';
import { directAdminApi, signInAndEnroll } from '../staff.js';

const ops = appByName('ops');

function mainNav(page: Page) {
  return page.getByRole('navigation', { name: 'Navigation principale' });
}

function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

/** Business notices are role="status" boxes; filter on their exact text. */
function notice(page: Page, text: string) {
  return page.getByRole('status').filter({ hasText: text });
}

test('ops pricing: SUPER_ADMIN publishes a fare table, prices a DRAFT trip and freezes it', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const errors = trackPageErrors(page);
  const seed = pricingSeed();
  const trips = tripSeed();
  const code = `FT_E2E_${seed.run}`;
  const origin = `1. ${trips.originCode} — Arrêt départ synthétique`;
  const destination = `2. ${trips.destinationCode} — Arrêt arrivée synthétique`;

  await signInAndEnroll(page, FIXTURES.pricingAdmin.email);
  await mainNav(page).getByRole('link', { name: 'Tarification' }).click();
  await expect(page).toHaveURL(appUrl(ops, '/pricing'));

  const create = page.getByRole('form', { name: 'Créer une grille tarifaire' });
  await create.getByLabel('Code de la grille', { exact: true }).fill(code.toLowerCase());
  await create.getByLabel('Nom de la grille', { exact: true }).fill('Grille synthétique E2E');
  await create
    .getByLabel('Route tarifée', { exact: true })
    .selectOption({ label: `${trips.routeCode} — ${trips.routeName}` });
  await create.getByLabel('Code devise', { exact: true }).fill('eur');
  await create.getByLabel('Décimales de la devise', { exact: true }).selectOption('2');
  await create.getByRole('button', { name: 'Créer la grille' }).click();
  await expect(notice(page, `Grille tarifaire ${code} créée.`)).toBeVisible();

  const detail = page.getByRole('region', { name: `Grille ${code} — Grille synthétique E2E` });
  await expect(detail.getByTestId('fare-table-detail')).toContainText('EUR (2 décimales)');
  await detail.getByRole('button', { name: 'Créer une version brouillon' }).click();
  await expect(
    notice(page, `Nouvelle version brouillon de la grille ${code} créée.`),
  ).toBeVisible();

  const add = detail.getByRole('form', { name: 'Ajouter un tarif' });
  await add.getByLabel('Origine', { exact: true }).selectOption({ label: origin });
  await add.getByLabel('Destination', { exact: true }).selectOption({ label: destination });
  // Strict conversion: a third decimal is refused, never rounded.
  await add.getByLabel('Tarif de base (EUR)', { exact: true }).fill('123,456');
  await add.getByRole('button', { name: 'Ajouter le tarif' }).click();
  await expect(
    add.getByText('Montant invalide : strictement positif, au plus 2 décimales.'),
  ).toBeVisible();
  await add.getByLabel('Tarif de base (EUR)', { exact: true }).fill('123,45');
  await add.getByRole('button', { name: 'Ajouter le tarif' }).click();
  const draftFares = detail.getByRole('table', { name: 'Tarifs du brouillon version 1' });
  await expect(draftFares.getByRole('row')).toHaveCount(2);
  await expect(draftFares).toContainText('123,45 EUR');
  await expect(detail.getByRole('button', { name: 'Publier la version 1' })).toBeDisabled();

  await detail.getByRole('button', { name: 'Enregistrer la grille' }).click();
  await expect(
    notice(page, 'Grille du brouillon version 1 enregistrée (1 paire tarifée).'),
  ).toBeVisible();
  await detail.getByRole('button', { name: 'Publier la version 1' }).click();
  await expect(notice(page, `Version 1 de la grille ${code} publiée.`)).toBeVisible();
  const versions = detail.getByRole('list', { name: `Versions de la grille ${code}` });
  await expect(versions.getByRole('listitem').first()).toContainText('Publiée');
  await expect(versions.getByRole('listitem').first()).toContainText('1 paire tarifée');
  // Published prices are read-only.
  await expect(detail.getByRole('form', { name: 'Ajouter un tarif' })).toHaveCount(0);

  // Trip: explicit assignment of the published version, server-side resolution, scheduling.
  await mainNav(page).getByRole('link', { name: 'Voyages' }).click();
  await page.getByRole('button', { name: `Consulter le voyage ${seed.tripReference}` }).click();
  const trip = page.getByRole('region', { name: `Voyage ${seed.tripReference}` });
  await trip.getByRole('tab', { name: 'Tarification' }).click();
  await expect(trip.getByTestId('trip-fare-table')).toHaveText('Aucune');
  await trip.getByRole('button', { name: 'Modifier la tarification' }).click();
  const pricing = trip.getByRole('form', { name: `Tarification du voyage ${seed.tripReference}` });
  await pricing
    .getByLabel('Grille tarifaire du voyage', { exact: true })
    .selectOption({ label: `${code} v1 (EUR) — 1 paire tarifée` });
  await pricing.getByRole('button', { name: 'Enregistrer la tarification' }).click();
  await expect(trip.getByTestId('trip-fare-table')).toHaveText(
    `${code} v1 (EUR) — 1 paire tarifée`,
  );

  const preview = trip.getByRole('form', { name: 'Aperçu d’un tarif' });
  await preview.getByLabel('Origine du trajet', { exact: true }).selectOption({ label: origin });
  await preview
    .getByLabel('Destination du trajet', { exact: true })
    .selectOption({ label: destination });
  await preview.getByRole('button', { name: 'Calculer le tarif' }).click();
  await expect(trip.getByTestId('trip-fare-preview')).toHaveText('123,45 EUR');

  await trip.getByRole('button', { name: 'Planifier le voyage' }).click();
  await expect(notice(page, `Voyage ${seed.tripReference} planifié.`)).toBeVisible();
  await expect(trip.getByTestId('trip-status')).toHaveText('Planifié');
  // The trip's pricing is now historical and read-only.
  await expect(trip.getByTestId('trip-fare-table')).toHaveText(
    `${code} v1 (EUR) — 1 paire tarifée`,
  );
  await expect(
    trip.getByRole('form', { name: `Tarification du voyage ${seed.tripReference}` }),
  ).toHaveCount(0);
  await expect(trip.getByRole('button', { name: 'Modifier la tarification' })).toHaveCount(0);
  await expect(trip.getByText('La tarification est figée')).toBeVisible();
  expect(errors).toEqual([]);
});

test('ops pricing: SUPER_ADMIN manages a fail-closed cargo pricing rule', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = trackPageErrors(page);
  const seed = pricingSeed();
  const code = `CPF_E2E_${seed.run}`;

  await signInAndEnroll(page, FIXTURES.cargoPricingAdmin.email);
  await mainNav(page).getByRole('link', { name: 'Tarification' }).click();
  await expect(page.getByTestId('cargo-pricing-workspace')).toBeVisible();

  const create = page.getByRole('form', { name: 'Créer une règle tarifaire fret' });
  await create.getByLabel('Code de la règle', { exact: true }).fill(code.toLowerCase());
  await create.getByLabel('Nom de la règle', { exact: true }).fill('Fret synthétique E2E');
  await create.getByLabel('Direction', { exact: true }).selectOption('PAR_DKR');
  await create.getByLabel('Audience', { exact: true }).selectOption('PUBLIC');
  await create.getByRole('button', { name: 'Créer la règle fret' }).click();
  await expect(notice(page, `Règle fret ${code} créée.`)).toBeVisible();

  const detail = page.getByRole('region', {
    name: `Règle fret ${code} — Fret synthétique E2E`,
  });
  await expect(detail.getByTestId('cargo-rule-detail')).toContainText('Paris → Dakar');
  await expect(detail.getByTestId('cargo-rule-detail')).toContainText(
    'Aucune — estimation publique en devis requis',
  );

  await detail.getByRole('button', { name: 'Créer un brouillon fail-closed' }).click();
  await expect(notice(page, `Brouillon fret créé pour ${code}.`)).toBeVisible();

  const editor = detail.getByRole('form', { name: `Configurer la version 1 de ${code}` });
  await expect(editor.getByLabel('Méthode', { exact: true })).toHaveValue('CUSTOM_QUOTE');

  const preview = detail.getByRole('form', { name: `Prévisualiser la version 1 de ${code}` });
  await preview.getByRole('button', { name: 'Prévisualiser' }).click();
  await expect(detail.getByTestId('cargo-pricing-preview')).toContainText('Devis requis');
  await expect(detail.getByTestId('cargo-pricing-preview')).toContainText('CUSTOM_QUOTE');

  await detail.getByRole('button', { name: 'Activer la version 1' }).click();
  await detail.getByRole('button', { name: 'Confirmer l’activation' }).click();
  await expect(notice(page, `Version 1 de ${code} activée.`)).toBeVisible();
  await expect(detail.getByTestId('cargo-rule-detail')).toContainText('v1 — Devis personnalisé');

  await detail.getByRole('button', { name: 'Désactiver la version 1' }).click();
  await detail.getByRole('button', { name: 'Confirmer la désactivation' }).click();
  await expect(notice(page, `Version 1 de ${code} désactivée.`)).toBeVisible();
  await expect(detail.getByTestId('cargo-rule-detail')).toContainText(
    'Aucune — estimation publique en devis requis',
  );

  expect(errors).toEqual([]);
});

test('ops pricing: pricing.read consults fares without any mutation control', async ({ page }) => {
  const errors = trackPageErrors(page);
  const seed = pricingSeed();
  await signInAndEnroll(page, FIXTURES.pricingReader.email);
  await mainNav(page).getByRole('link', { name: 'Tarification' }).click();
  await expect(page.getByTestId('pricing-workspace')).toBeVisible();
  await expect(page.getByRole('form', { name: 'Créer une grille tarifaire' })).toHaveCount(0);
  await page
    .getByRole('button', { name: `Consulter la grille ${seed.seededFareTableCode}` })
    .click();
  const detail = page.getByRole('region', {
    name: new RegExp(`^Grille ${seed.seededFareTableCode}`),
  });
  await expect(
    detail.getByRole('list', { name: `Versions de la grille ${seed.seededFareTableCode}` }),
  ).toContainText('1 paire tarifée');
  await detail.getByText('Tarifs de la version 1 (Publiée, lecture seule)').click();
  await expect(detail.getByRole('table', { name: 'Tarifs de la version 1' })).toContainText(
    '15 000 XOF',
  );
  await expect(detail.getByRole('form')).toHaveCount(0);
  await expect(
    page.getByRole('button', {
      name: /^(Créer|Désactiver|Activer|Ajouter|Enregistrer|Publier|Retirer)/,
    }),
  ).toHaveCount(0);

  const api = directAdminApi(page.request);
  expect((await api.get('/pricing/fare-tables?limit=10')).status()).toBe(200);
  expect((await api.get('/pricing/cargo-rules?limit=10')).status()).toBe(200);
  expect(page.getByRole('form', { name: 'Créer une règle tarifaire fret' })).toHaveCount(0);
  const forbidden = await api.post('/pricing/fare-tables', {
    code: `FT_DENIED_${seed.run}`,
    name: 'Interdit',
    routeId: '01900000-0000-7000-8000-000000000000',
    currencyCode: 'EUR',
    currencyMinorUnit: 2,
    active: true,
  });
  expect(forbidden.status()).toBe(403);
  expect(((await forbidden.json()) as { code: string }).code).toBe('FORBIDDEN');

  const cargoForbidden = await api.post('/pricing/cargo-rules', {
    code: `CPF_DENIED_${seed.run}`,
    name: 'Interdit',
    direction: 'PAR_DKR',
    audience: 'PUBLIC',
  });
  expect(cargoForbidden.status()).toBe(403);
  expect(((await cargoForbidden.json()) as { code: string }).code).toBe('FORBIDDEN');
  expect(errors).toEqual([]);
});

test('ops pricing: without pricing.read the menu is absent and the API refuses reads', async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  await signInAndEnroll(page, FIXTURES.pricingDenied.email);
  await expect(mainNav(page).getByRole('link', { name: 'Tarification' })).toHaveCount(0);
  const forbidden = await directAdminApi(page.request).get('/pricing/fare-tables');
  expect(forbidden.status()).toBe(403);
  expect(((await forbidden.json()) as { code: string }).code).toBe('FORBIDDEN');
  await page.goto(appUrl(ops, '/pricing'));
  await expect(
    page.getByText('Vous n’avez pas la permission d’afficher cette page.'),
  ).toBeVisible();
  await expect(page.getByTestId('pricing-workspace')).toHaveCount(0);
  expect(errors).toEqual([]);
});
