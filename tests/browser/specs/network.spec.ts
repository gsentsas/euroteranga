import { expect, test, type Page } from '@playwright/test';
import { appByName, appUrl } from '../apps.js';
import { FIXTURES } from '../fixtures.js';
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

function syntheticCodes() {
  const runId = process.env.E2E_RUN_ID;
  if (!runId) throw new Error('E2E_RUN_ID is set by global-setup.ts');
  const letter = (pair: string) => String.fromCharCode(65 + (Number.parseInt(pair, 16) % 26));
  const iso2 = `${letter(runId.slice(0, 2))}${letter(runId.slice(2, 4))}`;
  return {
    runId: runId.toUpperCase(),
    iso2,
    iso3: `${iso2}${letter(runId.slice(4, 6))}`,
  };
}

test('ops network: SUPER_ADMIN creates and publishes a synthetic versioned route', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = trackPageErrors(page);
  const codes = syntheticCodes();
  const countryName = `Pays synthétique ${codes.runId}`;
  const firstStopName = `Arrêt Alpha ${codes.runId}`;
  const lastStopName = `Arrêt Oméga ${codes.runId}`;
  const checkpointName = `Checkpoint Test ${codes.runId}`;
  const routeName = `Route synthétique ${codes.runId}`;
  const firstStopCode = `STA_${codes.runId}`;
  const lastStopCode = `STO_${codes.runId}`;
  const checkpointCode = `CP_${codes.runId}`;
  const routeCode = `RT_${codes.runId}`;

  await signInAndEnroll(page, FIXTURES.networkAdmin.email);
  await expect(page.getByTestId('session-roles')).toHaveText('SUPER_ADMIN');
  await mainNav(page).getByRole('link', { name: 'Réseau' }).click();
  await expect(page).toHaveURL(appUrl(ops, '/network'));
  await expect(page.getByTestId('network-workspace')).toBeVisible();

  const countryForm = page.getByRole('form', { name: 'Créer un pays' });
  await countryForm.getByLabel('Code ISO2').fill(codes.iso2);
  await countryForm.getByLabel('Code ISO3').fill(codes.iso3);
  await countryForm.getByLabel('Nom du pays').fill(countryName);
  await countryForm.getByRole('button', { name: 'Créer le pays' }).click();
  await expect(page.getByRole('row').filter({ hasText: countryName })).toBeVisible();

  const createStop = async (code: string, name: string, latitude: string) => {
    const form = page.getByRole('form', { name: 'Créer un arrêt' });
    await form.getByLabel('Code de l’arrêt').fill(code);
    await form.getByLabel('Nom de l’arrêt').fill(name);
    await form
      .getByLabel('Pays de l’arrêt')
      .selectOption({ label: `${codes.iso2} — ${countryName}` });
    await form.getByLabel('Localité de l’arrêt').fill(`Localité ${codes.runId}`);
    await form.getByLabel('Latitude de l’arrêt').fill(latitude);
    await form.getByLabel('Longitude de l’arrêt').fill('-1.25');
    await form.getByLabel('Fuseau horaire de l’arrêt').fill('Etc/UTC');
    await form.getByRole('button', { name: 'Créer l’arrêt' }).click();
    await expect(page.getByRole('row').filter({ hasText: code })).toContainText(name);
  };
  await createStop(firstStopCode, firstStopName, '10.25');
  await createStop(lastStopCode, lastStopName, '11.50');

  const checkpointForm = page.getByRole('form', { name: 'Créer un checkpoint' });
  await checkpointForm.getByLabel('Code du checkpoint').fill(checkpointCode);
  await checkpointForm.getByLabel('Nom du checkpoint').fill(checkpointName);
  await checkpointForm
    .getByLabel('Pays du checkpoint')
    .selectOption({ label: `${codes.iso2} — ${countryName}` });
  await checkpointForm.getByLabel('Type de checkpoint').selectOption('TECHNICAL');
  await checkpointForm.getByLabel('Localité du checkpoint').fill(`Localité ${codes.runId}`);
  await checkpointForm.getByLabel('Latitude du checkpoint').fill('10.75');
  await checkpointForm.getByLabel('Longitude du checkpoint').fill('-1.20');
  await checkpointForm.getByLabel('Fuseau horaire du checkpoint').fill('Etc/UTC');
  await checkpointForm.getByRole('button', { name: 'Créer le checkpoint' }).click();
  await expect(page.getByRole('row').filter({ hasText: checkpointCode })).toContainText(
    checkpointName,
  );

  const routeForm = page.getByRole('form', { name: 'Créer une route' });
  await routeForm.getByLabel('Code de la route').fill(routeCode);
  await routeForm.getByLabel('Nom de la route').fill(routeName);
  await routeForm.getByRole('button', { name: 'Créer la route' }).click();
  await expect(
    page.getByRole('heading', { level: 3, name: `${routeCode} — ${routeName}` }),
  ).toBeVisible();

  await page.getByRole('button', { name: `Créer un brouillon pour ${routeCode}` }).click();
  await expect(page.getByRole('heading', { name: 'Édition du brouillon version 1' })).toBeVisible();

  const stopSelect = page.getByLabel('Arrêt à ajouter');
  await stopSelect.selectOption({ label: `${firstStopCode} — ${firstStopName}` });
  await page.getByRole('button', { name: 'Ajouter l’arrêt sélectionné' }).click();
  await stopSelect.selectOption({ label: `${lastStopCode} — ${lastStopName}` });
  await page.getByRole('button', { name: 'Ajouter l’arrêt sélectionné' }).click();
  await page
    .getByLabel('Checkpoint à ajouter')
    .selectOption({ label: `${checkpointCode} — ${checkpointName}` });
  await page.getByRole('button', { name: 'Ajouter le checkpoint sélectionné' }).click();

  await page
    .getByRole('button', {
      name: `Monter Checkpoint ${checkpointCode} — ${checkpointName}`,
    })
    .click();
  const waypoints = page
    .getByRole('list', { name: 'Waypoints du brouillon 1' })
    .getByRole('listitem');
  await expect(waypoints.nth(0)).toContainText(firstStopCode);
  await expect(waypoints.nth(1)).toContainText(checkpointCode);
  await expect(waypoints.nth(2)).toContainText(lastStopCode);

  await page.getByRole('button', { name: 'Enregistrer l’ordre des waypoints' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Ordre de la version 1 enregistré.' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Publier la version 1' }).click();
  await expect(
    page.getByText('Version 1', { exact: false }).filter({ hasText: 'Publiée' }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test('ops network: network.read can consult but cannot mutate', async ({ page }) => {
  const errors = trackPageErrors(page);
  await signInAndEnroll(page, FIXTURES.networkReader.email);
  await mainNav(page).getByRole('link', { name: 'Réseau' }).click();
  await expect(page.getByTestId('network-workspace')).toBeVisible();
  await expect(page.getByRole('table', { name: 'Pays du réseau' })).toBeVisible();
  await expect(page.getByRole('form', { name: /^Créer / })).toHaveCount(0);
  await expect(
    page.getByRole('button', {
      name: /^(Créer|Activer|Désactiver|Ajouter|Monter|Descendre|Retirer|Enregistrer|Publier)/,
    }),
  ).toHaveCount(0);

  const api = directAdminApi(page.request);
  expect((await api.get('/network/countries?limit=10')).status()).toBe(200);
  const forbidden = await api.post('/network/countries', {
    iso2: 'XA',
    iso3: 'XAA',
    name: 'Mutation interdite',
    active: true,
  });
  expect(forbidden.status()).toBe(403);
  expect(((await forbidden.json()) as { code: string }).code).toBe('FORBIDDEN');
  expect(errors).toEqual([]);
});

test('ops network: a profile without network.read sees no navigation and the API refuses reads', async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  await signInAndEnroll(page, FIXTURES.networkDenied.email);
  await expect(mainNav(page).getByRole('link', { name: 'Réseau' })).toHaveCount(0);

  const api = directAdminApi(page.request);
  const forbidden = await api.get('/network/countries?limit=10');
  expect(forbidden.status()).toBe(403);
  expect(((await forbidden.json()) as { code: string }).code).toBe('FORBIDDEN');

  await page.goto(appUrl(ops, '/network'));
  await expect(
    page.getByText('Vous n’avez pas la permission d’afficher cette page.'),
  ).toBeVisible();
  await expect(page.getByTestId('network-workspace')).toHaveCount(0);
  expect(errors).toEqual([]);
});
