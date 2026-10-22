import { expect, test, type Page } from '@playwright/test';
import { appByName, appUrl } from '../apps.js';
import { FIXTURES, tripSeed } from '../fixtures.js';
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

test('ops trips: SUPER_ADMIN creates, times, equips, schedules and cancels a synthetic trip', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = trackPageErrors(page);
  const seed = tripSeed();
  const reference = `ET-TEST-${seed.run}-0001`;

  await signInAndEnroll(page, FIXTURES.tripAdmin.email);
  await mainNav(page).getByRole('link', { name: 'Voyages' }).click();
  await expect(page).toHaveURL(appUrl(ops, '/trips'));
  await expect(page.getByTestId('trips-workspace')).toBeVisible();

  const create = page.getByRole('form', { name: 'Créer un voyage' });
  await create.getByLabel('Référence du voyage', { exact: true }).fill(reference.toLowerCase());
  await create
    .getByLabel('Version de route publiée', { exact: true })
    .selectOption({ label: `${seed.routeCode} — ${seed.routeName} · v1` });
  await create.getByRole('button', { name: 'Créer le voyage' }).click();
  await expect(notice(page, `Voyage ${reference} créé (brouillon).`)).toBeVisible();

  const detail = page.getByRole('region', { name: `Voyage ${reference}` });
  await expect(detail.getByTestId('trip-status')).toHaveText('Brouillon');

  // Only the times are entered (UTC); the order comes from the route version.
  const timetable = detail.getByRole('form', { name: `Horaire du voyage ${reference}` });
  await timetable
    .getByLabel(`Départ de ${seed.originCode} (UTC)`, { exact: true })
    .fill('2030-01-15T08:00');
  await timetable
    .getByLabel(`Arrivée à ${seed.destinationCode} (UTC)`, { exact: true })
    .fill('2030-01-15T12:00');
  await timetable.getByRole('button', { name: 'Enregistrer l’horaire' }).click();
  await expect(notice(page, `Horaire du voyage ${reference} enregistré.`)).toBeVisible();

  const vehicleForm = detail.getByRole('form', { name: `Véhicule du voyage ${reference}` });
  await vehicleForm
    .getByLabel('Véhicule à affecter', { exact: true })
    .selectOption({ label: `${seed.vehicleCode} — ${seed.vehicleLabel}` });
  await vehicleForm.getByRole('button', { name: 'Enregistrer le véhicule' }).click();
  await expect(
    notice(page, `Véhicule du voyage ${reference} : ${seed.vehicleCode}.`),
  ).toBeVisible();
  await expect(detail.getByTestId('trip-vehicle')).toContainText(seed.vehicleCode);

  const costs = detail.getByRole('form', {
    name: `Coûts prévisionnels du voyage ${reference}`,
  });
  await costs.getByRole('button', { name: 'Ajouter une ligne' }).click();
  await costs.getByRole('button', { name: 'Ajouter une ligne' }).click();
  const fuel = costs.getByRole('group', { name: 'Ligne 1' });
  await fuel.getByLabel('Catégorie', { exact: true }).selectOption('FUEL');
  await fuel.getByLabel('Libellé', { exact: true }).fill('Carburant prévisionnel');
  await fuel.getByLabel('Montant (EUR)', { exact: true }).fill('4200');
  const stops = costs.getByRole('group', { name: 'Ligne 2' });
  await stops.getByLabel('Catégorie', { exact: true }).selectOption('STOP_COST');
  await stops.getByLabel('Libellé', { exact: true }).fill('Coûts des arrêts');
  await stops.getByLabel('Montant (EUR)', { exact: true }).fill('1800');
  await costs.getByLabel('Statut du chiffrage', { exact: true }).selectOption('ESTIMATED');
  await expect(costs.getByTestId('trip-cost-total')).toHaveText(/6\s?000,00 €/u);
  await costs.getByRole('button', { name: 'Enregistrer les coûts' }).click();
  await expect(
    notice(page, `Coûts prévisionnels du voyage ${reference} enregistrés.`),
  ).toBeVisible();

  // A full reload proves persistence and the second replacement proves edit + derived total.
  await page.reload();
  await page.getByRole('button', { name: `Consulter le voyage ${reference}` }).click();
  const persistedCosts = detail.getByRole('form', {
    name: `Coûts prévisionnels du voyage ${reference}`,
  });
  await expect(persistedCosts.getByTestId('trip-cost-total')).toHaveText(/6\s?000,00 €/u);
  await persistedCosts
    .getByRole('group', { name: 'Ligne 2' })
    .getByLabel('Montant (EUR)', { exact: true })
    .fill('2000');
  await persistedCosts.getByRole('button', { name: 'Enregistrer les coûts' }).click();
  await expect(
    notice(page, `Coûts prévisionnels du voyage ${reference} enregistrés.`),
  ).toBeVisible();

  // Reload again so 6 200 € is proven to come from the server, not just local form state.
  await page.reload();
  await page.getByRole('button', { name: `Consulter le voyage ${reference}` }).click();
  const reloadedCosts = detail.getByRole('form', {
    name: `Coûts prévisionnels du voyage ${reference}`,
  });
  await expect(reloadedCosts.getByTestId('trip-cost-total')).toHaveText(/6\s?200,00 €/u);

  await detail.getByRole('button', { name: 'Planifier le voyage' }).click();
  await expect(notice(page, `Voyage ${reference} planifié.`)).toBeVisible();
  await expect(detail.getByTestId('trip-status')).toHaveText('Planifié');
  // The timetable is now read-only and frozen.
  await expect(detail.getByRole('form', { name: `Horaire du voyage ${reference}` })).toHaveCount(0);
  const frozen = detail.getByRole('table', { name: `Horaire du voyage ${reference} (UTC)` });
  await expect(frozen.getByRole('row').filter({ hasText: seed.originCode })).toContainText(
    '15/01/2030 08:00 UTC',
  );
  await expect(frozen.getByRole('row').filter({ hasText: seed.destinationCode })).toContainText(
    '15/01/2030 12:00 UTC',
  );

  const cancel = detail.getByRole('form', { name: `Annuler le voyage ${reference}` });
  await cancel.getByLabel('Motif de l’annulation', { exact: true }).fill('Annulation synthétique');
  await cancel.getByRole('button', { name: 'Annuler le voyage' }).click();
  const cancellationConfirmation = cancel.getByRole('group', {
    name: `Confirmer l’annulation du voyage ${reference}`,
  });
  await expect(cancellationConfirmation).toBeVisible();
  await expect(detail.getByTestId('trip-status')).toHaveText('Planifié');
  await cancellationConfirmation.getByRole('button', { name: 'Confirmer l’annulation' }).click();
  await expect(notice(page, `Voyage ${reference} annulé.`)).toBeVisible();
  await expect(detail.getByTestId('trip-status')).toHaveText('Annulé');
  await expect(detail.getByRole('form')).toHaveCount(0);

  const history = detail
    .getByRole('list', { name: `Historique du voyage ${reference}` })
    .getByRole('listitem');
  await expect(history).toHaveCount(7);
  await expect(history.nth(0)).toContainText(
    'Annulation (Planifié → Annulé) — Annulation synthétique',
  );
  await expect(page.getByRole('row').filter({ hasText: reference })).toContainText('Annulé');
  expect(errors).toEqual([]);
});

test('ops trips: trip.read consults without any mutation control; the API refuses mutations', async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  const seed = tripSeed();
  await signInAndEnroll(page, FIXTURES.tripReader.email);
  await mainNav(page).getByRole('link', { name: 'Voyages' }).click();
  await expect(page.getByTestId('trips-workspace')).toBeVisible();
  await expect(page.getByRole('form', { name: 'Créer un voyage' })).toHaveCount(0);

  const consult = page.getByRole('button', {
    name: `Consulter le voyage ${seed.seededTripReference}`,
  });
  const selectedRow = page.getByRole('row').filter({ has: consult });
  await consult.click();
  await expect(page.locator('#trip-detail-panel')).toBeFocused();
  await expect(selectedRow).toHaveClass(/ops-table-row--selected/);
  const detail = page.getByRole('region', { name: `Voyage ${seed.seededTripReference}` });
  await expect(detail.getByTestId('trip-status')).toHaveText('Brouillon');
  await expect(detail.getByRole('form')).toHaveCount(0);
  await expect(
    detail.getByRole('region', {
      name: `Coûts prévisionnels du voyage ${seed.seededTripReference}`,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: /^(Créer|Enregistrer|Planifier|Annuler)/ }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Retour à la liste' }).click();
  await expect(page.locator('#trip-detail-panel')).toHaveCount(0);
  await expect(consult).toBeFocused();
  await expect(selectedRow).not.toHaveClass(/ops-table-row--selected/);

  const api = directAdminApi(page.request);
  const list = await api.get('/trips?limit=100');
  expect(list.status()).toBe(200);
  const seeded = (
    (await list.json()) as {
      items: Array<{ id: string; reference: string; routeVersionId: string }>;
    }
  ).items.find((trip) => trip.reference === seed.seededTripReference);
  expect(seeded).toBeDefined();
  const attempts = [
    await api.post('/trips', {
      reference: `ET-TEST-${seed.run}-9999`,
      routeVersionId: seeded?.routeVersionId,
    }),
    await api.post(`/trips/${seeded?.id}/schedule`, {}),
    await api.post(`/trips/${seeded?.id}/cancel`, { reason: 'Interdit' }),
    await api.post(`/trips/${seeded?.id}/vehicle`, { vehicleId: null }),
    await api.post(`/trips/${seeded?.id}/costs`, {
      status: 'DRAFT',
      currencyCode: 'EUR',
      items: [],
    }),
  ];
  for (const attempt of attempts) {
    expect(attempt.status()).toBe(403);
    expect(((await attempt.json()) as { code: string }).code).toBe('FORBIDDEN');
  }
  expect(errors).toEqual([]);
});

test('ops trips: without trip.read the menu is absent and the API refuses reads', async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  await signInAndEnroll(page, FIXTURES.tripDenied.email);
  await expect(mainNav(page).getByRole('link', { name: 'Voyages' })).toHaveCount(0);

  const forbidden = await directAdminApi(page.request).get('/trips');
  expect(forbidden.status()).toBe(403);
  expect(((await forbidden.json()) as { code: string }).code).toBe('FORBIDDEN');

  await page.goto(appUrl(ops, '/trips'));
  await expect(
    page.getByText('Vous n’avez pas la permission d’afficher cette page.'),
  ).toBeVisible();
  await expect(page.getByTestId('trips-workspace')).toHaveCount(0);
  expect(errors).toEqual([]);
});
