import { expect, test, type Page } from '@playwright/test';
import { appByName, appUrl } from '../apps.js';
import { FIXTURES, preauthenticatedSession, seatMapSeed } from '../fixtures.js';
import { BROWSER_API_URL, directAdminApi, signInAndEnroll } from '../staff.js';

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

test('ops seat maps: SUPER_ADMIN publishes a layout, configures a vehicle and freezes it on a trip', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const errors = trackPageErrors(page);
  const seed = seatMapSeed();
  const code = `SM_E2E_${seed.run}`;

  await signInAndEnroll(page, FIXTURES.seatMapAdmin.email);
  await mainNav(page).getByRole('link', { name: 'Plans de sièges' }).click();
  await expect(page).toHaveURL(appUrl(ops, '/seat-maps'));
  await expect(page.getByTestId('seat-maps-workspace')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Indicateurs des plans de sièges' })).toBeVisible();

  await page.getByRole('button', { name: 'Nouveau plan' }).click();
  const createDrawer = page.getByRole('dialog', { name: 'Nouveau plan de sièges' });
  const create = createDrawer.getByRole('form', { name: 'Créer un plan de sièges' });
  await create.getByLabel('Code du plan', { exact: true }).fill(code.toLowerCase());
  await create.getByLabel('Nom du plan', { exact: true }).fill('Plan synthétique E2E');
  await create.getByRole('button', { name: 'Créer le plan' }).click();
  await expect(notice(page, `Plan de sièges ${code} créé.`)).toBeVisible();

  const detailDrawer = page.getByRole('dialog', { name: code });
  const detail = detailDrawer.getByRole('region', {
    name: `Plan ${code} — Plan synthétique E2E`,
  });
  await detail.getByRole('button', { name: 'Créer une version brouillon' }).click();
  await detail.getByRole('tab', { name: 'Versions' }).click();
  await expect(
    detail.getByRole('heading', { name: 'Édition du brouillon version 1' }),
  ).toBeVisible();

  const add = detail.getByRole('form', { name: 'Ajouter une cellule à la version 1' });
  const addCell = async (row: string, column: string, kind: string, label?: string) => {
    await add.getByLabel('Pont', { exact: true }).fill('1');
    await add.getByLabel('Rang', { exact: true }).fill(row);
    await add.getByLabel('Colonne', { exact: true }).fill(column);
    await add.getByLabel('Type de cellule', { exact: true }).selectOption({ label: kind });
    if (label) await add.getByLabel('Numéro du siège', { exact: true }).fill(label);
    await add.getByRole('button', { name: 'Ajouter la cellule' }).click();
  };
  await addCell('1', '1', 'Conducteur');
  await addCell('2', '1', 'Siège', '1A');
  await addCell('2', '2', 'Allée');
  await addCell('2', '3', 'Siège', '1B');
  await expect(detail.getByTestId('draft-seat-count')).toHaveText('Capacité : 2 sièges');
  await expect(
    detail.getByRole('group', { name: 'Aperçu du brouillon version 1, pont 1' }),
  ).toContainText('1A');
  await expect(
    detail.getByRole('table', { name: 'Cellules du brouillon version 1' }).getByRole('row'),
  ).toHaveCount(5);

  await detail.getByRole('button', { name: 'Enregistrer les cellules' }).click();
  await expect(notice(page, 'Cellules de la version 1 enregistrées.')).toBeVisible();
  await detail.getByRole('button', { name: 'Publier la version 1' }).click();
  await expect(notice(page, 'Version 1 publiée.')).toBeVisible();
  await expect(
    detail
      .getByRole('list', { name: `Versions du plan ${code}` })
      .getByRole('listitem')
      .first(),
  ).toContainText('Publiée');

  await detailDrawer.getByRole('button', { name: 'Fermer' }).click();

  // Fleet: configure the synthetic vehicle with the published version.
  await mainNav(page).getByRole('link', { name: 'Flotte' }).click();
  await page.getByRole('button', { name: `Consulter le véhicule ${seed.vehicleCode}` }).click();
  const vehicle = page.getByRole('region', { name: `Véhicule ${seed.vehicleCode}` });
  const vehicleForm = vehicle.getByRole('form', {
    name: `Plan de sièges du véhicule ${seed.vehicleCode}`,
  });
  await vehicleForm
    .getByLabel('Plan de sièges à configurer', { exact: true })
    .selectOption({ label: `${code} v1 — 2 sièges` });
  await vehicleForm.getByRole('button', { name: 'Enregistrer le plan de sièges' }).click();
  await expect(vehicle.getByTestId('vehicle-seat-map')).toHaveText(`${code} v1 — 2 sièges`);

  // Trip: explicitly use the vehicle's seat map, then schedule.
  await mainNav(page).getByRole('link', { name: 'Voyages' }).click();
  await page.getByRole('button', { name: `Consulter le voyage ${seed.tripReference}` }).click();
  const trip = page.getByRole('region', { name: `Voyage ${seed.tripReference}` });
  await trip.getByRole('tab', { name: 'Véhicules' }).click();
  await expect(trip.getByTestId('trip-seat-map')).toHaveText('Aucun');
  await trip.getByRole('button', { name: 'Utiliser le plan du véhicule' }).click();
  await expect(trip.getByTestId('trip-seat-map')).toHaveText(`${code} v1 — 2 sièges`);
  await trip.getByRole('button', { name: 'Planifier le voyage' }).click();
  await expect(notice(page, `Voyage ${seed.tripReference} planifié.`)).toBeVisible();
  await expect(trip.getByTestId('trip-status')).toHaveText('Planifié');
  await expect(trip.getByTestId('trip-seat-map')).toHaveText(`${code} v1 — 2 sièges`);
  await expect(trip.getByRole('button', { name: 'Utiliser le plan du véhicule' })).toHaveCount(0);
  await expect(trip.getByRole('button', { name: 'Modifier le plan de sièges' })).toHaveCount(0);
  await expect(
    trip.getByRole('form', { name: `Plan de sièges du voyage ${seed.tripReference}` }),
  ).toHaveCount(0);
  await expect(trip.getByText('Le plan de sièges est figé')).toBeVisible();
  expect(errors).toEqual([]);
});

test('ops seat maps: seatmap.read consults the catalogue without any mutation control', async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  const seed = seatMapSeed();
  await signInAndEnroll(page, FIXTURES.seatMapReader.email);
  await mainNav(page).getByRole('link', { name: 'Plans de sièges' }).click();
  await expect(page.getByTestId('seat-maps-workspace')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Nouveau plan' })).toHaveCount(0);
  await expect(page.getByRole('form', { name: 'Créer un plan de sièges' })).toHaveCount(0);

  await page.getByRole('button', { name: `Consulter le plan ${seed.seededSeatMapCode}` }).click();
  const drawer = page.getByRole('dialog', { name: seed.seededSeatMapCode });
  const detail = drawer.getByRole('region', {
    name: new RegExp(`^Plan ${seed.seededSeatMapCode}`),
  });
  await detail.getByRole('tab', { name: 'Versions' }).click();
  await expect(
    detail.getByRole('list', { name: `Versions du plan ${seed.seededSeatMapCode}` }),
  ).toContainText('capacité 1 siège');
  await expect(detail.getByRole('form')).toHaveCount(0);
  await expect(
    page.getByRole('button', {
      name: /^(Créer|Désactiver|Activer|Ajouter|Enregistrer|Publier|Retirer)/,
    }),
  ).toHaveCount(0);

  const api = directAdminApi(page.request);
  expect((await api.get('/seat-maps?limit=10')).status()).toBe(200);
  const forbidden = await api.post('/seat-maps', {
    code: `SM_DENIED_${seed.run}`,
    name: 'Interdit',
    active: true,
  });
  expect(forbidden.status()).toBe(403);
  expect(((await forbidden.json()) as { code: string }).code).toBe('FORBIDDEN');
  expect(errors).toEqual([]);
});

test('ops seat maps: filters and keyboard drawer keep the catalogue accessible', async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  const seed = seatMapSeed();

  await page.context().addCookies([
    {
      name: 'et_staff_session',
      value: preauthenticatedSession('seatMapAccessibilityAdmin'),
      url: BROWSER_API_URL,
      httpOnly: true,
      secure: false,
      sameSite: 'Strict',
    },
  ]);
  await page.goto(appUrl(ops, '/seat-maps'));
  await expect(page.getByTestId('seat-maps-workspace')).toBeVisible();

  const search = page.getByRole('searchbox', { name: 'Rechercher un plan' });
  await search.fill(seed.seededSeatMapCode);
  await expect(
    page.getByRole('button', { name: `Consulter le plan ${seed.seededSeatMapCode}` }),
  ).toBeVisible();

  const trigger = page.getByRole('button', {
    name: `Consulter le plan ${seed.seededSeatMapCode}`,
  });
  await trigger.click();
  const drawer = page.getByRole('dialog', { name: seed.seededSeatMapCode });
  await expect(drawer).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(errors).toEqual([]);
});

test('ops seat maps: without seatmap.read the menu is absent and the API refuses reads', async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  await signInAndEnroll(page, FIXTURES.seatMapDenied.email);
  await expect(mainNav(page).getByRole('link', { name: 'Plans de sièges' })).toHaveCount(0);
  const forbidden = await directAdminApi(page.request).get('/seat-maps');
  expect(forbidden.status()).toBe(403);
  expect(((await forbidden.json()) as { code: string }).code).toBe('FORBIDDEN');
  await page.goto(appUrl(ops, '/seat-maps'));
  await expect(
    page.getByText('Vous n’avez pas la permission d’afficher cette page.'),
  ).toBeVisible();
  await expect(page.getByTestId('seat-maps-workspace')).toHaveCount(0);
  expect(errors).toEqual([]);
});
