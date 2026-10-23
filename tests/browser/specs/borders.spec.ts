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

async function offlineDatabaseDump(page: Page) {
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

test.describe('PR-20 operational border crossings', () => {
  test('OPS exposes only the valid next transition and refreshes border state after recording it', async ({
    context,
    page,
  }) => {
    const errors = trackPageErrors(page);
    await sessionCookie(context, 'staff', preauthenticatedSession('permitManager'));

    const tripId = '01900000-0000-7000-8000-000000000020';
    const waypointId = '01900000-0000-7000-8000-000000000021';
    let borderState: 'PENDING' | 'ARRIVED' = 'PENDING';
    let postBody: Record<string, unknown> = {};

    const tripSummary = {
      id: tripId,
      reference: 'ET-BORDER-E2E',
      status: 'IN_PROGRESS',
      plannedDepartureAt: '2026-10-17T08:00:00.000Z',
      plannedArrivalAt: '2026-10-18T18:00:00.000Z',
      vehicle: { id: '01900000-0000-7000-8000-000000000022', code: 'BUS-E2E' },
      route: { code: 'PAR-DKR', name: 'Paris → Dakar' },
      config: null,
      lastObservation: null,
      providerStatus: 'UNAVAILABLE',
    };
    const tripDetail = {
      ...tripSummary,
      observations: [],
      publicTokens: [],
    };

    await page.route('**/v1/admin/tracking/trips', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [tripSummary] }),
      }),
    );
    await page.route('**/v1/admin/tracking/devices', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [] }),
      }),
    );
    await page.route(`**/v1/admin/tracking/trips/${tripId}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(tripDetail),
      }),
    );
    await page.route(`**/v1/admin/tracking/trips/${tripId}/comfort`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          tripId,
          tripReference: tripSummary.reference,
          tripStatus: tripSummary.status,
          route: tripSummary.route,
          plannedDepartureAt: tripSummary.plannedDepartureAt,
          plannedArrivalAt: tripSummary.plannedArrivalAt,
          progressSequence: 0,
          lastUpdatedAt: null,
          currentStep: null,
          nextStep: null,
          nextPause: null,
          steps: [],
          events: [],
        }),
      }),
    );
    await page.route(`**/v1/admin/borders/trips/${tripId}`, (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          trip: { id: tripId, reference: 'ET-BORDER-E2E', status: 'IN_PROGRESS' },
          borders: [
            {
              routeWaypointId: waypointId,
              sequence: 2,
              code: 'BORDER-E2E',
              name: 'Frontière test',
              currentState: borderState,
              latestOccurredAt: borderState === 'ARRIVED' ? '2026-10-17T09:00:00.000Z' : null,
            },
          ],
          events:
            borderState === 'ARRIVED'
              ? [
                  {
                    id: '01900000-0000-7000-8000-000000000023',
                    tripId,
                    routeWaypointId: waypointId,
                    type: 'ARRIVED',
                    source: 'STAFF',
                    clientEventId: 'evt-browser-border-arrived',
                    occurredAt: '2026-10-17T09:00:00.000Z',
                    recordedAt: '2026-10-17T09:00:01.000Z',
                    waypoint: { sequence: 2, code: 'BORDER-E2E', name: 'Frontière test' },
                  },
                ]
              : [],
        }),
      });
    });
    await page.route(`**/v1/admin/borders/trips/${tripId}/events`, async (route) => {
      postBody = route.request().postDataJSON() as Record<string, unknown>;
      borderState = 'ARRIVED';
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          created: true,
          event: {
            id: '01900000-0000-7000-8000-000000000023',
            tripId,
            routeWaypointId: waypointId,
            type: 'ARRIVED',
            source: 'STAFF',
            clientEventId: String(postBody.clientEventId),
            occurredAt: String(postBody.occurredAt),
            recordedAt: '2026-10-17T09:00:01.000Z',
            waypoint: { sequence: 2, code: 'BORDER-E2E', name: 'Frontière test' },
          },
        }),
      });
    });

    await page.goto(appUrl(ops, '/tracking'));
    const workspace = page.getByTestId('tracking-workspace');
    await expect(workspace.getByText('ET-BORDER-E2E')).toBeVisible();
    await workspace.getByRole('button', { name: 'Détail' }).click();

    const panel = page.getByTestId('border-ops-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Il ne vaut ni décision douanière, ni visa');
    await expect(panel.getByTestId('border-ops-table')).toContainText('À venir');
    await expect(panel.getByRole('button', { name: 'Signaler l’arrivée' })).toBeVisible();

    await panel.getByRole('button', { name: 'Signaler l’arrivée' }).click();
    await expect(
      panel.getByRole('status').filter({ hasText: 'Événement frontière enregistré.' }),
    ).toBeVisible();
    await expect(panel.getByTestId('border-ops-table')).toContainText('Arrivé');
    await expect(panel.getByRole('button', { name: 'Démarrer le contrôle' })).toBeVisible();

    expect(postBody).toMatchObject({ routeWaypointId: waypointId, type: 'ARRIVED' });
    expect(String(postBody.clientEventId)).toMatch(/^evt-[0-9a-f-]{36}$/u);
    expect(Number.isNaN(Date.parse(String(postBody.occurredAt)))).toBe(false);
    expect(errors.pageErrors).toEqual([]);
    expect(errors.consoleErrors).toEqual([]);
  });

  test('Crew records ARRIVED offline and immediately derives the next valid border action', async ({
    context,
    page,
  }) => {
    const errors = trackPageErrors(page);
    await sessionCookie(context, 'crew', preauthenticatedSession('crew'));

    const tripReference = 'ET-BORDER-CREW';
    const waypointId = '01900000-0000-7000-8000-000000000031';
    await page.route('**/v1/crew/trips', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          serverTime: '2026-10-17T09:00:00.000Z',
          items: [
            {
              assignmentId: '01900000-0000-7000-8000-000000000030',
              snapshotExpiresAt: '2030-10-17T15:00:00.000Z',
              trip: {
                reference: tripReference,
                status: 'IN_PROGRESS',
                plannedDepartureAt: '2026-10-17T08:00:00.000Z',
                plannedArrivalAt: '2026-10-18T18:00:00.000Z',
                vehicleCode: 'BUS-E2E',
                route: { code: 'PAR-DKR', name: 'Paris → Dakar' },
                waypoints: [
                  {
                    id: waypointId,
                    sequence: 2,
                    kind: 'CHECKPOINT',
                    code: 'BORDER-E2E',
                    name: 'Frontière test',
                    checkpointType: 'BORDER',
                    borderState: 'PENDING',
                  },
                ],
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

    const borders = page.getByRole('region', { name: 'Passages frontière' });
    await expect(borders).toContainText('État : À venir');
    await expect(borders.getByRole('button', { name: 'Signaler l’arrivée' })).toBeVisible();

    await context.setOffline(true);
    await expect(page.getByText('Hors ligne', { exact: true })).toBeVisible();
    await borders.getByRole('button', { name: 'Signaler l’arrivée' }).click();

    await expect(
      page.getByText(
        'Événement frontière enregistré sur cet appareil — synchronisation en attente.',
      ),
    ).toBeVisible();
    await expect(borders).toContainText('État : Arrivé');
    await expect(borders.getByRole('button', { name: 'Démarrer le contrôle' })).toBeVisible();
    await expect(page.getByText('1 en attente')).toBeVisible();
    await expect(page.getByText('Frontière · ARRIVED')).toBeVisible();

    const events = await offlineDatabaseDump(page);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'BORDER_EVENT',
      tripReference,
      payload: { routeWaypointId: waypointId, eventType: 'ARRIVED' },
      status: 'PENDING',
    });
    expect(errors.pageErrors).toEqual([]);
    expect(errors.consoleErrors).toEqual([]);
    await context.setOffline(false);
  });
});
