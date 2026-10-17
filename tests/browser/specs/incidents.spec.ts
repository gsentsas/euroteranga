import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { appByName, appUrl } from '../apps.js';
import { preauthenticatedSession } from '../fixtures.js';
import { BROWSER_API_URL } from '../staff.js';

const ops = appByName('ops');
const crew = appByName('crew');

function trackPageErrors(page: Page) {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  return { pageErrors, consoleErrors };
}

async function sessionCookie(context: BrowserContext, realm: 'staff' | 'crew', token: string) {
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

async function offlineEvents(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('euroteranga-crew-offline-v1');
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const request = db.transaction('events', 'readonly').objectStore('events').getAll();
    const events = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result as Record<string, unknown>[]);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return events;
  });
}

test.describe('PR-21 operational incidents', () => {
  test('OPS requires the critical breakdown milestone before the next transition', async ({
    context,
    page,
  }) => {
    const errors = trackPageErrors(page);
    await sessionCookie(context, 'staff', preauthenticatedSession('permitManager'));

    const reference = 'ETI-BCDFGHJKMNPQ';
    const ownerId = '01900000-0000-7000-8000-000000000201';
    const tripId = '01900000-0000-7000-8000-000000000202';
    let status: 'ACTION_REQUIRED' | 'MITIGATING' = 'ACTION_REQUIRED';
    let actions: Array<Record<string, unknown>> = [];
    let actionBody: Record<string, unknown> = {};
    let transitionBody: Record<string, unknown> = {};

    const summary = () => ({
      id: '01900000-0000-7000-8000-000000000203',
      reference,
      type: 'BREAKDOWN',
      severity: 'CRITICAL',
      status,
      source: 'STAFF',
      description: 'Panne moteur critique immobilisant le véhicule pendant le trajet.',
      locationLabel: 'Aire de sécurité',
      openedAt: '2026-10-17T09:00:00.000Z',
      recordedAt: '2026-10-17T09:00:01.000Z',
      resolvedAt: null,
      closedAt: null,
      ownerIdentityId: ownerId,
      trip: { id: tripId, reference: 'ET-INCIDENT-E2E', status: 'IN_PROGRESS' },
      vehicle: { id: '01900000-0000-7000-8000-000000000204', code: 'BUS-E2E' },
      waypoint: null,
      baggage: null,
      actionCount: actions.length,
      attachmentCount: 0,
    });

    await page.route(/\/v1\/admin\/incidents(?:\?.*)?$/u, (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [summary()], nextCursor: null }),
      });
    });
    await page.route('**/v1/admin/incidents/owners', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [{ id: ownerId, email: 'ops.incident@example.test' }] }),
      }),
    );
    await page.route(`**/v1/admin/incidents/${reference}`, (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...summary(), actions, attachments: [] }),
      });
    });
    await page.route(`**/v1/admin/incidents/${reference}/actions`, async (route) => {
      actionBody = route.request().postDataJSON() as Record<string, unknown>;
      actions = [
        {
          id: '01900000-0000-7000-8000-000000000205',
          sequence: 1,
          type: 'ACTION_PLAN',
          content: String(actionBody.content),
          clientActionId: String(actionBody.clientActionId),
          createdByIdentityId: ownerId,
          createdAt: '2026-10-17T09:05:00.000Z',
        },
      ];
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ created: true, action: actions[0] }),
      });
    });
    await page.route(`**/v1/admin/incidents/${reference}/transition`, async (route) => {
      transitionBody = route.request().postDataJSON() as Record<string, unknown>;
      status = 'MITIGATING';
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify(summary()),
      });
    });

    await page.goto(appUrl(ops, '/incidents'));
    const workspace = page.getByTestId('incident-workspace');
    await expect(workspace.getByText(reference)).toBeVisible();
    await workspace
      .getByTestId('incident-list')
      .getByRole('button', { name: 'Ouvrir', exact: true })
      .click();

    const detail = page.getByTestId('incident-detail');
    await expect(detail).toContainText('Panne');
    await expect(detail).toContainText('Critique');
    await expect(detail).toContainText('Action requise');
    await expect(detail).toContainText('Plan d’action');
    await expect(detail.getByTestId('incident-next-transition')).toBeDisabled();

    await detail.getByLabel('Type d’action').selectOption('ACTION_PLAN');
    await detail
      .getByLabel('Contenu opérationnel')
      .fill('Immobiliser le véhicule et organiser la continuité du trajet.');
    await detail.getByRole('button', { name: 'Ajouter au journal' }).click();
    await expect(detail.getByText('Immobiliser le véhicule', { exact: false })).toBeVisible();
    await expect(detail.getByTestId('incident-next-transition')).toBeEnabled();

    await detail.getByTestId('incident-next-transition').click();
    await expect(detail).toContainText('Traitement en cours');
    expect(actionBody).toMatchObject({ type: 'ACTION_PLAN' });
    expect(String(actionBody.clientActionId)).toMatch(/^act-[0-9a-f-]{36}$/u);
    await expect
      .poll(() => transitionBody)
      .toEqual({ status: 'MITIGATING', expectedStatus: 'ACTION_REQUIRED' });
    expect(errors.pageErrors).toEqual([]);
    expect(errors.consoleErrors).toEqual([]);
  });

  test('Crew records an incident offline in the existing queue without unrelated PII', async ({
    context,
    page,
  }) => {
    const errors = trackPageErrors(page);
    await sessionCookie(context, 'crew', preauthenticatedSession('crew'));

    const tripReference = 'ET-INCIDENT-CREW';
    await page.route('**/v1/crew/trips', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          serverTime: '2026-10-17T09:00:00.000Z',
          items: [
            {
              assignmentId: '01900000-0000-7000-8000-000000000210',
              snapshotExpiresAt: '2030-10-17T15:00:00.000Z',
              trip: {
                reference: tripReference,
                status: 'IN_PROGRESS',
                plannedDepartureAt: '2026-10-17T08:00:00.000Z',
                plannedArrivalAt: '2026-10-18T18:00:00.000Z',
                vehicleCode: 'BUS-E2E',
                route: { code: 'PAR-DKR', name: 'Paris → Dakar' },
                waypoints: [],
              },
            },
          ],
        }),
      }),
    );

    await page.goto(appUrl(crew, '/session'));
    await expect(page.getByRole('heading', { name: 'Opérations équipage' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Voyage', exact: true })).toHaveValue(
      tripReference,
    );

    await context.setOffline(true);
    await expect(page.getByText('Hors ligne', { exact: true })).toBeVisible();
    await page.getByLabel('Type d’incident').selectOption('WEATHER');
    await page.getByLabel('Sévérité').selectOption('HIGH');
    await page
      .getByLabel('Description opérationnelle')
      .fill('Vent violent et visibilité réduite ralentissant fortement le trajet.');
    await page.getByLabel('Lieu (optionnel)').fill('Secteur côtier');
    await page.getByTestId('crew-report-incident').click();

    await expect(
      page.getByText('Incident enregistré sur cet appareil — synchronisation en attente.'),
    ).toBeVisible();
    await expect(page.getByText('1 en attente')).toBeVisible();
    await expect(page.getByText('Incident · Météo · Élevée', { exact: false })).toBeVisible();

    const events = await offlineEvents(page);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'INCIDENT_REPORTED',
      tripReference,
      status: 'PENDING',
      payload: {
        incidentType: 'WEATHER',
        severity: 'HIGH',
        description: 'Vent violent et visibilité réduite ralentissant fortement le trajet.',
        locationLabel: 'Secteur côtier',
      },
    });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('booking');
    expect(serialized).not.toContain('passenger');
    expect(errors.pageErrors).toEqual([]);
    expect(errors.consoleErrors).toEqual([]);
    await context.setOffline(false);
  });
});
