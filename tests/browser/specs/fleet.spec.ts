import { expect, test, type Page } from '@playwright/test';
import { appByName, appUrl } from '../apps.js';
import { FIXTURES, seededVehicleCode } from '../fixtures.js';
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

test('ops fleet: SUPER_ADMIN registers, edits and moves a synthetic vehicle through its lifecycle', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = trackPageErrors(page);
  const runId = (process.env.E2E_RUN_ID ?? '').toUpperCase();
  const code = `VH_E2E_${runId}`;
  // Synthetic VIN: ZZZ prefix + run id (hex, valid VIN alphabet), never real.
  const vin = `ZZZ${runId}000000`;

  await signInAndEnroll(page, FIXTURES.fleetAdmin.email);
  await mainNav(page).getByRole('link', { name: 'Flotte' }).click();
  await expect(page).toHaveURL(appUrl(ops, '/fleet'));
  await expect(page.getByTestId('fleet-workspace')).toBeVisible();

  const create = page.getByRole('form', { name: 'Enregistrer un véhicule' });
  await create.getByLabel('Code du nouveau véhicule', { exact: true }).fill(code.toLowerCase());
  await create
    .getByLabel('Constructeur du nouveau véhicule', { exact: true })
    .fill('Constructeur synthétique');
  await create.getByLabel('Modèle du nouveau véhicule', { exact: true }).fill('Autocar test');
  await create.getByLabel('Année modèle du nouveau véhicule (facultatif)').fill('2022');
  await create.getByLabel('VIN du nouveau véhicule (facultatif)').fill(vin);
  await create.getByRole('button', { name: 'Enregistrer le véhicule' }).click();
  await expect(notice(page, `Véhicule ${code} enregistré (planifié).`)).toBeVisible();

  const detail = page.getByRole('region', { name: `Véhicule ${code}` });
  await expect(detail.getByTestId('vehicle-status')).toHaveText('Planifié');
  await expect(page.getByRole('row').filter({ hasText: code })).toContainText('Planifié');

  // Administrative edit (never the status).
  const edit = detail.getByRole('form', { name: `Modifier le véhicule ${code}` });
  await edit.getByLabel('Modèle du véhicule', { exact: true }).fill('Autocar test révisé');
  await edit.getByRole('button', { name: 'Enregistrer les modifications' }).click();
  await expect(notice(page, `Véhicule ${code} modifié.`)).toBeVisible();
  await expect(detail.getByTestId('vehicle-detail')).toContainText('Autocar test révisé');

  const changeStatus = async (label: string, reason: string) => {
    const form = detail.getByRole('form', { name: `Changer le statut du véhicule ${code}` });
    await form.getByLabel('Nouveau statut').selectOption({ label });
    await form.getByLabel('Motif du changement').fill(reason);
    await form.getByRole('button', { name: 'Appliquer le changement de statut' }).click();
    await expect(notice(page, `Statut du véhicule ${code} : ${label}.`)).toBeVisible();
    await expect(detail.getByTestId('vehicle-status')).toHaveText(label);
  };
  await changeStatus('En service', 'Mise en service synthétique');
  await changeStatus('Hors service', 'Panne synthétique');

  const history = detail
    .getByRole('list', { name: `Historique des statuts du véhicule ${code}` })
    .getByRole('listitem');
  await expect(history).toHaveCount(2);
  await expect(history.nth(0)).toContainText('En service → Hors service — Panne synthétique');
  await expect(history.nth(1)).toContainText('Planifié → En service');
  await expect(page.getByRole('row').filter({ hasText: code })).toContainText('Hors service');
  expect(errors).toEqual([]);
});

test('ops fleet: fleet.read consults without any mutation control; the API refuses mutations', async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  const code = seededVehicleCode();
  await signInAndEnroll(page, FIXTURES.fleetReader.email);
  await mainNav(page).getByRole('link', { name: 'Flotte' }).click();
  await expect(page.getByTestId('fleet-workspace')).toBeVisible();
  await expect(page.getByRole('form', { name: 'Enregistrer un véhicule' })).toHaveCount(0);

  await page.getByRole('button', { name: `Consulter le véhicule ${code}` }).click();
  await expect(page.locator('#vehicle-detail-panel')).toBeFocused();
  const detail = page.getByRole('region', { name: `Véhicule ${code}` });
  await expect(detail.getByTestId('vehicle-status')).toHaveText('Planifié');
  await expect(detail.getByRole('form')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^(Enregistrer|Appliquer)/ })).toHaveCount(0);

  const api = directAdminApi(page.request);
  const list = await api.get(`/fleet/vehicles?limit=100`);
  expect(list.status()).toBe(200);
  const seeded = ((await list.json()) as { items: Array<{ id: string; code: string }> }).items.find(
    (vehicle) => vehicle.code === code,
  );
  expect(seeded).toBeDefined();
  const attempts = [
    await api.post('/fleet/vehicles', {
      code: `VH_DENIED_${(process.env.E2E_RUN_ID ?? '').toUpperCase()}`,
      manufacturer: 'Interdit',
      model: 'Interdit',
    }),
    await api.post(`/fleet/vehicles/${seeded?.id}`, { model: 'Interdit' }),
    await api.post(`/fleet/vehicles/${seeded?.id}/status`, {
      status: 'ACTIVE',
      reason: 'Interdit',
    }),
  ];
  for (const attempt of attempts) {
    expect(attempt.status()).toBe(403);
    expect(((await attempt.json()) as { code: string }).code).toBe('FORBIDDEN');
  }
  expect(errors).toEqual([]);
});

test('ops fleet: without fleet.read the menu is absent and the API refuses reads', async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  await signInAndEnroll(page, FIXTURES.fleetDenied.email);
  // The profile does see other spaces (network.read), but not Flotte.
  await expect(mainNav(page).getByRole('link', { name: 'Réseau' })).toBeVisible();
  await expect(mainNav(page).getByRole('link', { name: 'Flotte' })).toHaveCount(0);

  const forbidden = await directAdminApi(page.request).get('/fleet/vehicles');
  expect(forbidden.status()).toBe(403);
  expect(((await forbidden.json()) as { code: string }).code).toBe('FORBIDDEN');

  await page.goto(appUrl(ops, '/fleet'));
  await expect(
    page.getByText('Vous n’avez pas la permission d’afficher cette page.'),
  ).toBeVisible();
  await expect(page.getByTestId('fleet-workspace')).toHaveCount(0);
  expect(errors).toEqual([]);
});
