import { expect, test, type Page } from '@playwright/test';
import { appByName, appUrl } from '../apps.js';
import { FIXTURES, preauthenticatedSession, tripSeed } from '../fixtures.js';
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
  // Read first: no form is open until an explicit "Modifier".
  await expect(detail.getByRole('form')).toHaveCount(0);

  // Only the times are entered (UTC); the order comes from the route version.
  await detail.getByRole('tab', { name: 'Itinéraire' }).click();
  await detail.getByRole('button', { name: 'Modifier l’horaire' }).click();
  const timetable = detail.getByRole('form', { name: `Horaire du voyage ${reference}` });
  await timetable
    .getByLabel(`Départ de ${seed.originCode} (UTC)`, { exact: true })
    .fill('2030-01-15T08:00');
  await timetable
    .getByLabel(`Arrivée à ${seed.destinationCode} (UTC)`, { exact: true })
    .fill('2030-01-15T12:00');
  await timetable.getByRole('button', { name: 'Enregistrer l’horaire' }).click();
  await expect(notice(page, `Horaire du voyage ${reference} enregistré.`)).toBeVisible();
  await expect(timetable).toHaveCount(0);

  await detail.getByRole('tab', { name: 'Véhicules' }).click();
  await detail.getByRole('button', { name: 'Affecter un véhicule principal' }).click();
  const vehicleForm = detail.getByRole('form', { name: `Véhicule du voyage ${reference}` });
  await vehicleForm
    .getByLabel('Véhicule à affecter', { exact: true })
    .selectOption({ label: `${seed.vehicleCode} — ${seed.vehicleLabel}` });
  await vehicleForm.getByRole('button', { name: 'Enregistrer le véhicule' }).click();
  await expect(
    notice(page, `Véhicule du voyage ${reference} : ${seed.vehicleCode}.`),
  ).toBeVisible();
  await expect(detail.getByTestId('trip-vehicle')).toContainText(seed.vehicleCode);

  await detail.getByRole('button', { name: 'Affecter un véhicule d’appoint' }).click();
  const supportVehicleForm = detail.getByRole('form', {
    name: `Véhicule d’appoint du voyage ${reference}`,
  });
  await supportVehicleForm
    .getByLabel('Véhicule CARGO_SUPPORT à affecter', { exact: true })
    .selectOption({
      label: `${seed.supportVehicleCode} — ${seed.supportVehicleLabel} · 1200 kg · 20 m³`,
    });
  await supportVehicleForm
    .getByRole('button', { name: 'Enregistrer le véhicule d’appoint' })
    .click();
  await expect(
    notice(page, `Véhicule d’appoint du voyage ${reference} : ${seed.supportVehicleCode}.`),
  ).toBeVisible();
  await expect(detail.getByTestId('trip-support-vehicle')).toContainText(seed.supportVehicleCode);
  await expect(detail.getByTestId('trip-support-vehicle')).toContainText('1200 kg');
  await expect(detail.getByTestId('trip-support-vehicle')).toContainText('20 m³');

  // The address keeps the open record and its tab: a reload reopens it there.
  await expect(page).toHaveURL(/[?&]fiche=[^&]+&onglet=vehicules/u);
  await page.reload();
  await expect(detail.getByRole('tab', { name: 'Véhicules' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(detail.getByTestId('trip-support-vehicle')).toContainText(seed.supportVehicleCode);
  await expect(detail.getByTestId('trip-support-vehicle')).toContainText('20 m³');

  await detail.getByRole('tab', { name: 'Coûts' }).click();
  await detail.getByRole('button', { name: 'Modifier les coûts' }).click();
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
  const costView = detail.getByRole('region', {
    name: `Coûts prévisionnels du voyage ${reference}`,
  });
  await expect(costView.getByTestId('trip-cost-total')).toHaveText(/6\s?000,00 €/u);
  await costView.getByRole('button', { name: 'Modifier les coûts' }).click();
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
  const reloadedCosts = detail.getByRole('region', {
    name: `Coûts prévisionnels du voyage ${reference}`,
  });
  await expect(reloadedCosts.getByTestId('trip-cost-total')).toHaveText(/6\s?200,00 €/u);

  await detail.getByRole('button', { name: 'Planifier le voyage' }).click();
  await expect(notice(page, `Voyage ${reference} planifié.`)).toBeVisible();
  await expect(detail.getByTestId('trip-status')).toHaveText('Planifié');
  // The timetable is now read-only and frozen.
  await detail.getByRole('tab', { name: 'Itinéraire' }).click();
  await expect(detail.getByRole('button', { name: 'Modifier l’horaire' })).toHaveCount(0);
  await expect(detail.getByRole('form', { name: `Horaire du voyage ${reference}` })).toHaveCount(0);
  const frozen = detail.getByRole('table', { name: `Horaire du voyage ${reference} (UTC)` });
  await expect(frozen.getByRole('row').filter({ hasText: seed.originCode })).toContainText(
    '15/01/2030 08:00 UTC',
  );
  await expect(frozen.getByRole('row').filter({ hasText: seed.destinationCode })).toContainText(
    '15/01/2030 12:00 UTC',
  );

  // Cancellation is out of the way: "Plus" → sensitive zone → reason → confirmation.
  await expect(detail.getByRole('form', { name: `Annuler le voyage ${reference}` })).toHaveCount(0);
  await detail.getByRole('button', { name: 'Plus' }).click();
  await detail.getByRole('menuitem', { name: 'Annuler le voyage…' }).click();
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

  await detail.getByRole('tab', { name: 'Historique' }).click();
  const history = detail
    .getByRole('list', { name: `Historique du voyage ${reference}` })
    .getByRole('listitem');
  await expect(history).toHaveCount(8);
  await expect(history.nth(0)).toContainText(
    'Annulation (Planifié → Annulé) — Annulation synthétique',
  );
  await expect(page.getByRole('row').filter({ hasText: reference })).toContainText('Annulé');
  expect(errors).toEqual([]);
});

test('ops trips: the cockpit summarises a trip from real data, with keyboard tabs, deep links and explicit edits', async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  const seed = tripSeed();
  const reference = seed.seededTripReference;
  // Pre-created session: this scenario does not consume the shared login-IP budget.
  await page.context().addCookies([
    {
      name: 'et_staff_session',
      value: preauthenticatedSession('tripCockpitAdmin'),
      url: BROWSER_API_URL,
      httpOnly: true,
      secure: false,
      sameSite: 'Strict',
    },
  ]);
  await page.goto(appUrl(ops, '/'));
  await mainNav(page).getByRole('link', { name: 'Voyages' }).click();
  await page.getByRole('button', { name: `Consulter le voyage ${reference}` }).click();
  const detail = page.getByRole('region', { name: `Voyage ${reference}` });

  // Header: the route version's own ends; no timetable is invented for this draft.
  await expect(
    detail.getByRole('heading', {
      level: 2,
      name: `Voyage ${reference} ${seed.originCode} vers ${seed.destinationCode}`,
    }),
  ).toBeVisible();
  await expect(detail.getByTestId('trip-status')).toHaveText('Brouillon');
  await expect(detail.getByText('Horaire à définir')).toHaveCount(2);

  // KPI row: each figure comes from its own source; empty sources say so.
  const kpis = detail.getByRole('region', { name: 'Indicateurs clés' });
  await expect(kpis).toContainText('Aucun plan de sièges affecté');
  await expect(kpis).toContainText('Aucun chiffrage enregistré');
  // Audited Finance reads wait for an explicit request.
  await expect(kpis.getByRole('button', { name: 'Charger les chiffres Finance' })).toBeVisible();

  // Alerts are derived from the trip's facts only.
  const alerts = detail.getByRole('region', { name: 'Alertes & actions' });
  await expect(alerts).toContainText('Aucun véhicule principal n’est affecté.');
  await expect(alerts).toContainText('Horaire incomplet : 2 points sans heure prévue.');
  await expect(alerts).toContainText('Aucun plan de sièges n’est affecté au voyage.');
  await expect(alerts).toContainText('Aucune grille tarifaire n’est affectée.');

  // Tabs: one per real feature (all permissions here), keyboard pattern, URL.
  const tablist = detail.getByRole('tablist', { name: `Rubriques du voyage ${reference}` });
  await expect(tablist.getByRole('tab')).toHaveText([
    'Vue d’ensemble',
    'Itinéraire',
    'Passagers',
    'Bagages',
    'Colis & fret',
    'Tarification',
    'Coûts',
    'Véhicules',
    'Documents',
    'Historique',
  ]);
  await tablist.getByRole('tab', { name: 'Vue d’ensemble' }).focus();
  await page.keyboard.press('ArrowRight');
  const itineraryTab = tablist.getByRole('tab', { name: 'Itinéraire' });
  await expect(itineraryTab).toBeFocused();
  await expect(itineraryTab).toHaveAttribute('aria-selected', 'true');
  await expect(detail.getByRole('tabpanel', { name: 'Itinéraire' })).toBeVisible();
  await expect(
    detail.getByRole('table', { name: `Horaire du voyage ${reference} (UTC)` }),
  ).toBeVisible();
  await page.keyboard.press('End');
  await expect(tablist.getByRole('tab', { name: 'Historique' })).toBeFocused();
  await expect(page).toHaveURL(/[?&]onglet=historique/u);
  // Opening the cockpit wrote nothing to the trip's audit-backed history.
  await expect(detail.getByRole('tabpanel', { name: 'Historique' })).toContainText(
    'Aucun événement enregistré.',
  );
  await page.keyboard.press('Home');
  await expect(tablist.getByRole('tab', { name: 'Vue d’ensemble' })).toHaveAttribute(
    'aria-selected',
    'true',
  );

  // Deep link straight to a tab of this trip.
  const link = new URL(page.url());
  link.searchParams.set('onglet', 'tarification');
  await page.goto(link.toString());
  await expect(detail.getByRole('tab', { name: 'Tarification' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(detail.getByTestId('trip-fare-table')).toHaveText('Aucune');

  // Read first, edit second: the "Modifier" menu opens one editor; closing saves nothing.
  await detail.getByRole('button', { name: 'Modifier', exact: true }).click();
  const editMenu = detail.getByRole('menu', { name: 'Modifier le voyage' });
  await expect(editMenu.getByRole('menuitem')).toHaveText([
    'Horaire',
    'Véhicule principal',
    'Véhicule d’appoint',
    'Plan de sièges',
    'Tarification',
    'Coûts prévisionnels',
  ]);
  await editMenu.getByRole('menuitem', { name: 'Horaire' }).click();
  const timetable = detail.getByRole('form', { name: `Horaire du voyage ${reference}` });
  await expect(timetable).toBeVisible();
  await expect(detail.getByRole('group', { name: 'Modification de l’horaire' })).toBeFocused();
  await detail.getByRole('button', { name: 'Fermer l’édition' }).click();
  await expect(timetable).toHaveCount(0);
  await expect(detail.getByRole('button', { name: 'Modifier l’horaire' })).toBeFocused();

  // Menus close on Escape and give the focus back to their button.
  const more = detail.getByRole('button', { name: 'Plus' });
  await more.click();
  await expect(detail.getByRole('menuitem', { name: 'Documents' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(detail.getByRole('menuitem', { name: 'Historique' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(detail.getByRole('menu')).toHaveCount(0);
  await expect(more).toBeFocused();

  // An explicit request reads the Finance projection: no flow yet, said as such.
  await detail.getByRole('tab', { name: 'Vue d’ensemble' }).click();
  await kpis.getByRole('button', { name: 'Charger les chiffres Finance' }).click();
  await expect(kpis).toContainText('CA réel');
  await expect(kpis).toContainText('Aucun flux Finance');

  // Header shortcuts open the existing pages, pre-filled with the trip.
  await detail.getByRole('link', { name: 'Manifeste' }).click();
  await expect(page).toHaveURL(appUrl(ops, `/manifests?voyage=${reference}`));
  await expect(page.getByLabel('Référence du voyage', { exact: true })).toHaveValue(reference);
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
  // No finance.read for this profile: the Finance figures are absent, not invented.
  const kpis = detail.getByRole('region', { name: 'Indicateurs clés' });
  await expect(kpis).toContainText('Coûts prévus');
  await expect(kpis).not.toContainText('CA réel');
  await expect(kpis).not.toContainText('Marge réelle');
  await detail.getByRole('tab', { name: 'Coûts' }).click();
  await expect(
    detail.getByRole('region', {
      name: `Coûts prévisionnels du voyage ${seed.seededTripReference}`,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: /^(Créer|Enregistrer|Planifier|Annuler|Modifier|Affecter)/ }),
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
    await api.post(`/trips/${seeded?.id}/support-vehicle`, { supportVehicleId: null }),
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
