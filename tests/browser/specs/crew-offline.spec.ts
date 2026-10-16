import { createHash, randomBytes } from 'node:crypto';
import { createDatabaseClient } from '@euroteranga/database';
import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
  type Route,
} from '@playwright/test';
import { appByName, appUrl } from '../apps.js';
import {
  checkInSeed,
  FIXTURES,
  preauthenticatedSession,
  type PreauthenticatedFixture,
} from '../fixtures.js';
import { BROWSER_API_URL, directAdminApi } from '../staff.js';

const crewApp = appByName('crew');
const CLIENT_ORIGIN = `http://localhost:${appByName('client').port}`;

function trackPageErrors(page: Page) {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  return { pageErrors, consoleErrors };
}

async function addSessionCookie(
  context: BrowserContext,
  realm: 'customer' | 'staff' | 'crew',
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

function customerApi(request: APIRequestContext) {
  const headers = { Origin: CLIENT_ORIGIN };
  return {
    get: (path: string) => request.get(`${BROWSER_API_URL}/v1/booking${path}`, { headers }),
    async post(path: string, data: unknown = {}) {
      const csrf = await request.get(`${BROWSER_API_URL}/v1/auth/customer/csrf`, { headers });
      expect(csrf.status()).toBe(200);
      const { csrfToken } = (await csrf.json()) as { csrfToken: string };
      return request.post(`${BROWSER_API_URL}/v1/booking${path}`, {
        headers: { ...headers, 'X-CSRF-Token': csrfToken },
        data,
      });
    },
  };
}

async function staffPage(browser: Browser, fixture: PreauthenticatedFixture) {
  const context = await browser.newContext();
  await addSessionCookie(context, 'staff', preauthenticatedSession(fixture));
  return { context, page: await context.newPage() };
}

async function makeCompliant(
  browser: Browser,
  request: APIRequestContext,
  bookingReference: string,
  passengerReference: string,
) {
  const customer = customerApi(request);
  const evaluated = await customer.post(
    `/bookings/${bookingReference}/passengers/${passengerReference}/compliance-evaluations`,
  );
  expect(evaluated.status()).toBe(200);
  const evaluation = ((await evaluated.json()) as { evaluation: { reference: string } }).evaluation;
  const reviewer = await staffPage(browser, 'checkInReviewer');
  try {
    const reviewed = await directAdminApi(reviewer.page.request).post(
      `/compliance/evaluations/${evaluation.reference}/reviews`,
      {
        decision: 'COMPLIANT',
        reason: 'Revue synthétique du scénario navigateur PR-18 Crew offline.',
        previousReviewId: null,
      },
    );
    expect(reviewed.status()).toBe(201);
  } finally {
    await reviewer.context.close();
  }
}

async function prepareCrewCheckIn(browser: Browser) {
  const seed = checkInSeed();
  const context = await browser.newContext();
  await addSessionCookie(context, 'customer', preauthenticatedSession('checkInCustomer'));
  const page = await context.newPage();
  const api = customerApi(page.request);
  await makeCompliant(
    browser,
    page.request,
    seed.crewBookingReference,
    seed.crewPassenger.reference,
  );
  const seat = await api.post(
    `/bookings/${seed.crewBookingReference}/passengers/${seed.crewPassenger.reference}/seat`,
    { seatLabel: '1A' },
  );
  expect(seat.status()).toBe(201);
  const checked = await api.post(
    `/bookings/${seed.crewBookingReference}/passengers/${seed.crewPassenger.reference}/check-in`,
  );
  expect(checked.status()).toBe(201);
  const body = (await checked.json()) as { checkIn: { qrPayload: string; reference: string } };
  return { seed, context, api, qrPayload: body.checkIn.qrPayload };
}

async function createEphemeralCrewSession() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for the Crew browser test');
  const db = createDatabaseClient({ databaseUrl });
  try {
    const identity = await db.authIdentity.findUniqueOrThrow({
      where: {
        realm_normalizedEmail: {
          realm: 'CREW',
          normalizedEmail: FIXTURES.crew.email,
        },
      },
    });
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 60 * 60_000);
    const session = await db.authSession.create({
      data: {
        identityId: identity.id,
        tokenHash: new Uint8Array(createHash('sha256').update(token).digest()),
        authVersion: identity.authVersion,
        idleExpiresAt: expiresAt,
        absoluteExpiresAt: expiresAt,
      },
    });
    return { token, sessionId: session.id };
  } finally {
    await db.$disconnect();
  }
}

async function expireCrewSession(sessionId: string) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for the Crew browser test');
  const db = createDatabaseClient({ databaseUrl });
  try {
    await db.authSession.update({
      where: { id: sessionId },
      data: { idleExpiresAt: new Date(Date.now() - 1_000) },
    });
  } finally {
    await db.$disconnect();
  }
}

async function offlineDatabaseDump(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('euroteranga-crew-offline-v1');
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const read = <T>(storeName: string) =>
      new Promise<T[]>((resolve, reject) => {
        const request = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
        request.onsuccess = () => resolve(request.result as T[]);
        request.onerror = () => reject(request.error);
      });
    const [trips, events] = await Promise.all([
      read<Record<string, unknown>>('trips'),
      read<Record<string, unknown>>('events'),
    ]);
    db.close();
    return { trips, events };
  });
}

interface SyncCapture {
  requests: number;
  clientEventIds: string[];
}

async function mockAcknowledgedCrewSync(
  page: Page,
  tripReference: string,
  capture: SyncCapture,
  beforeResponse?: () => Promise<void>,
) {
  await page.route('**/v1/crew/trips/*/events/sync', async (route: Route) => {
    capture.requests += 1;
    const body = route.request().postDataJSON() as {
      events: Array<{ clientEventId: string }>;
    };
    capture.clientEventIds.push(...body.events.map(({ clientEventId }) => clientEventId));
    await beforeResponse?.();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: {
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Origin': `http://localhost:${crewApp.port}`,
      },
      body: JSON.stringify({
        tripReference,
        results: body.events.map(({ clientEventId }) => ({
          clientEventId,
          status: 'ACKNOWLEDGED',
          created: false,
          boardingReference: 'ETE-HOTFIX23TEST',
        })),
      }),
    });
  });
}

test.describe('PR-18 Crew PWA offline operations', () => {
  test.describe.configure({ mode: 'serial' });

  test('boards offline, survives reload and synchronizes exactly once after reconnect', async ({
    browser,
    context,
    page,
  }) => {
    test.setTimeout(120_000);
    const errors = trackPageErrors(page);
    const prepared = await prepareCrewCheckIn(browser);

    try {
      await addSessionCookie(context, 'crew', preauthenticatedSession('crew'));
      await page.goto(appUrl(crewApp, '/session'));
      await expect(page.getByRole('heading', { name: 'Opérations équipage' })).toBeVisible();
      await expect(page.getByRole('combobox', { name: 'Voyage', exact: true })).toHaveValue(
        prepared.seed.crewTripReference,
      );
      await expect(page.getByText('En ligne', { exact: true })).toBeVisible();
      await expect(page.getByText('0 en attente')).toBeVisible();

      await page.evaluate(async () => {
        if (!('serviceWorker' in navigator)) throw new Error('service worker unavailable');
        await navigator.serviceWorker.ready;
      });
      // One controlled online reload lets the service worker observe/cache
      // all actually used Next static chunks before the network is cut.
      await page.reload();
      await expect(page.getByRole('combobox', { name: 'Voyage', exact: true })).toHaveValue(
        prepared.seed.crewTripReference,
      );

      await context.setOffline(true);
      await expect(page.getByText('Hors ligne', { exact: true })).toBeVisible();

      await page.getByLabel('Code QR passager').fill(prepared.qrPayload);
      await page.getByRole('button', { name: 'Enregistrer l’embarquement' }).click();
      await expect(
        page.getByText('Embarquement enregistré sur cet appareil — synchronisation en attente.'),
      ).toBeVisible();
      await expect(page.getByText('1 en attente')).toBeVisible();
      await expect(page.getByText('En attente', { exact: true })).toBeVisible();

      const offlineDump = await offlineDatabaseDump(page);
      expect(offlineDump.events).toHaveLength(1);
      const serialized = JSON.stringify(offlineDump);
      for (const pii of [
        'Daba',
        'Equipage',
        prepared.seed.crewBookingReference,
        prepared.seed.crewPassenger.reference,
      ]) {
        expect(serialized).not.toContain(pii);
      }
      expect(serialized).toContain(prepared.seed.crewTripReference);
      expect(serialized).toContain(prepared.qrPayload);

      await page.reload();
      await expect(page.getByRole('heading', { name: 'Opérations équipage' })).toBeVisible();
      await expect(page.getByText('Hors ligne', { exact: true })).toBeVisible();
      await expect(page.getByText('1 en attente')).toBeVisible();
      await expect(page.getByRole('combobox', { name: 'Voyage', exact: true })).toHaveValue(
        prepared.seed.crewTripReference,
      );

      await context.setOffline(false);
      await expect(page.getByText('En ligne', { exact: true })).toBeVisible();
      await expect(page.getByText('Toutes les actions sont synchronisées.')).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByText('0 en attente')).toBeVisible();

      const overview = await prepared.api.get(
        `/bookings/${prepared.seed.crewBookingReference}/check-in`,
      );
      expect(overview.status()).toBe(200);
      const overviewBody = (await overview.json()) as {
        items: Array<{
          passenger: { reference: string };
          checkIn: { boarding: { reference: string } | null } | null;
        }>;
      };
      const passenger = overviewBody.items.find(
        (item) => item.passenger.reference === prepared.seed.crewPassenger.reference,
      );
      expect(passenger?.checkIn?.boarding?.reference).toMatch(/^ETE-/u);

      const afterSync = await offlineDatabaseDump(page);
      expect(afterSync.events).toEqual([]);
      expect(errors.pageErrors).toEqual([]);
      expect(errors.consoleErrors).toEqual([]);
    } finally {
      if (!context.pages()[0]?.isClosed()) await context.setOffline(false);
      await prepared.context.close();
    }
  });

  test('keeps a single local event when the boarding action is submitted twice offline', async ({
    context,
    page,
  }) => {
    test.setTimeout(120_000);
    const seed = checkInSeed();
    // The first test already boarded the dedicated passenger server-side.
    // This scenario verifies local deduplication only, using a fresh opaque QR
    // string that is intentionally never synchronized.
    await addSessionCookie(context, 'crew', preauthenticatedSession('crew'));
    await page.goto(appUrl(crewApp, '/session'));
    await expect(page.getByRole('combobox', { name: 'Voyage', exact: true })).toHaveValue(
      seed.crewTripReference,
    );
    await context.setOffline(true);
    await expect(page.getByText('Hors ligne', { exact: true })).toBeVisible();

    const fakeQr = 'ETPAX1:ETQ-ZZZZZZZZZZZZZZZZ';
    await page.getByLabel('Code QR passager').fill(fakeQr);
    const button = page.getByRole('button', { name: 'Enregistrer l’embarquement' });
    await button.dblclick({ delay: 10 });
    await expect(page.getByText('1 en attente')).toBeVisible();
    const dump = await offlineDatabaseDump(page);
    expect(dump.events).toHaveLength(1);

    await context.setOffline(false);
  });

  test('retries transient reconnect validation before synchronizing the pending queue', async ({
    context,
    page,
  }) => {
    test.setTimeout(30_000);
    const seed = checkInSeed();
    await addSessionCookie(context, 'crew', preauthenticatedSession('crew'));
    await page.goto(appUrl(crewApp, '/session'));
    await expect(page.getByRole('combobox', { name: 'Voyage', exact: true })).toHaveValue(
      seed.crewTripReference,
    );

    await context.setOffline(true);
    await expect(page.getByText('Hors ligne', { exact: true })).toBeVisible();
    await page.getByLabel('Code QR passager').fill('ETPAX1:ETQ-XXXXXXXXXXXXXXX1');
    await page.getByRole('button', { name: 'Enregistrer l’embarquement' }).click();
    await expect(page.getByText('1 en attente')).toBeVisible();
    const beforeReconnect = await offlineDatabaseDump(page);
    expect(beforeReconnect.events).toHaveLength(1);
    const queuedClientEventId = beforeReconnect.events[0]?.clientEventId;
    expect(queuedClientEventId).toEqual(expect.any(String));

    let validationRequests = 0;
    const sync = { requests: 0, clientEventIds: [] } satisfies SyncCapture;
    let releaseSyncResponse: (() => void) | undefined;
    const syncResponseGate = new Promise<void>((resolve) => {
      releaseSyncResponse = resolve;
    });
    await page.route('**/v1/auth/crew/me', async (route) => {
      validationRequests += 1;
      if (validationRequests === 1) {
        await route.abort('failed');
        return;
      }
      await route.continue();
    });
    await mockAcknowledgedCrewSync(
      page,
      seed.crewTripReference,
      sync,
      async () => syncResponseGate,
    );
    await page.clock.install();
    await page.clock.pauseAt(new Date());

    await context.setOffline(false);
    await page.clock.runFor(0);
    await expect(page.getByText('Core API indisponible', { exact: false })).toBeVisible();
    expect(validationRequests).toBe(1);
    expect(sync.requests).toBe(0);
    await expect(page.getByRole('button', { name: 'Synchroniser' })).toBeDisabled();
    const afterFailure = await offlineDatabaseDump(page);
    expect(afterFailure.events).toHaveLength(1);
    expect(afterFailure.events[0]).toMatchObject({ status: 'PENDING' });

    await page.clock.fastForward(999);
    expect(validationRequests).toBe(1);
    expect(sync.requests).toBe(0);
    expect((await offlineDatabaseDump(page)).events[0]).toMatchObject({ status: 'PENDING' });

    await page.clock.fastForward(1);
    await expect.poll(() => validationRequests).toBe(2);
    await expect(page.getByText('En ligne', { exact: true })).toBeVisible();
    await page.clock.runFor(0);
    await expect.poll(() => sync.requests).toBe(1);
    expect((await offlineDatabaseDump(page)).events[0]).toMatchObject({
      clientEventId: queuedClientEventId,
      status: 'SYNCING',
    });
    releaseSyncResponse?.();
    await expect(page.getByText('Toutes les actions sont synchronisées.')).toBeVisible();
    expect(validationRequests).toBe(2);
    expect(sync.clientEventIds).toEqual([queuedClientEventId]);
    expect((await offlineDatabaseDump(page)).events).toEqual([]);
  });

  test('retries a server 500 and synchronizes only after the full refresh succeeds', async ({
    context,
    page,
  }) => {
    test.setTimeout(30_000);
    const seed = checkInSeed();
    await addSessionCookie(context, 'crew', preauthenticatedSession('crew'));
    await page.goto(appUrl(crewApp, '/session'));
    await expect(page.getByRole('combobox', { name: 'Voyage', exact: true })).toHaveValue(
      seed.crewTripReference,
    );

    await context.setOffline(true);
    await page.getByLabel('Code QR passager').fill('ETPAX1:ETQ-XXXXXXXXXXXXXXX2');
    await page.getByRole('button', { name: 'Enregistrer l’embarquement' }).click();
    const queued = await offlineDatabaseDump(page);
    const queuedClientEventId = queued.events[0]?.clientEventId;
    expect(queued.events).toHaveLength(1);
    expect(queuedClientEventId).toEqual(expect.any(String));

    let tripRefreshes = 0;
    await page.route('**/v1/crew/trips', async (route) => {
      tripRefreshes += 1;
      if (tripRefreshes === 1) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          headers: {
            'Access-Control-Allow-Credentials': 'true',
            'Access-Control-Allow-Origin': `http://localhost:${crewApp.port}`,
          },
          body: JSON.stringify({ code: 'TEMPORARY_FAILURE', message: 'Synthetic server failure.' }),
        });
        return;
      }
      await route.continue();
    });
    const sync = { requests: 0, clientEventIds: [] } satisfies SyncCapture;
    await mockAcknowledgedCrewSync(page, seed.crewTripReference, sync);
    await page.clock.install();
    await page.clock.pauseAt(new Date());

    await context.setOffline(false);
    await page.clock.runFor(0);
    await expect(page.getByText('voyages conservés', { exact: false })).toBeVisible();
    expect(tripRefreshes).toBe(1);
    expect(sync.requests).toBe(0);
    expect((await offlineDatabaseDump(page)).events[0]).toMatchObject({ status: 'PENDING' });

    await page.clock.fastForward(999);
    expect(tripRefreshes).toBe(1);
    expect(sync.requests).toBe(0);
    expect((await offlineDatabaseDump(page)).events[0]).toMatchObject({ status: 'PENDING' });
    await page.clock.fastForward(1);
    await expect.poll(() => tripRefreshes).toBe(2);
    await expect(page.getByText('En ligne', { exact: true })).toBeVisible();
    await page.clock.runFor(0);
    await expect.poll(() => sync.requests).toBe(1);
    expect(sync.clientEventIds).toEqual([queuedClientEventId]);
    expect((await offlineDatabaseDump(page)).events).toEqual([]);
  });

  test('cancels transient reconnect retry when the browser goes offline again', async ({
    context,
    page,
  }) => {
    const seed = checkInSeed();
    await addSessionCookie(context, 'crew', preauthenticatedSession('crew'));
    await page.goto(appUrl(crewApp, '/session'));
    await expect(page.getByRole('combobox', { name: 'Voyage', exact: true })).toHaveValue(
      seed.crewTripReference,
    );
    await context.setOffline(true);
    await page.getByLabel('Code QR passager').fill('ETPAX1:ETQ-XXXXXXXXXXXXXXX3');
    await page.getByRole('button', { name: 'Enregistrer l’embarquement' }).click();

    let validationRequests = 0;
    await page.route('**/v1/auth/crew/me', async (route) => {
      validationRequests += 1;
      if (validationRequests === 1) {
        await route.abort('failed');
        return;
      }
      await route.continue();
    });
    const sync = { requests: 0, clientEventIds: [] } satisfies SyncCapture;
    await mockAcknowledgedCrewSync(page, seed.crewTripReference, sync);
    await page.clock.install();
    await page.clock.pauseAt(new Date());

    await context.setOffline(false);
    await page.clock.runFor(0);
    await expect(page.getByText('Core API indisponible', { exact: false })).toBeVisible();
    expect(validationRequests).toBe(1);
    await context.setOffline(true);
    await expect(page.getByText('Hors ligne', { exact: true })).toBeVisible();
    await page.clock.fastForward(60_000);

    expect(validationRequests).toBe(1);
    expect(sync.requests).toBe(0);
    expect((await offlineDatabaseDump(page)).events[0]).toMatchObject({ status: 'PENDING' });
  });

  test('cancels transient reconnect retry when the Crew workspace unmounts', async ({
    context,
    page,
  }) => {
    const seed = checkInSeed();
    await addSessionCookie(context, 'crew', preauthenticatedSession('crew'));
    await page.goto(appUrl(crewApp, '/session'));
    await expect(page.getByRole('combobox', { name: 'Voyage', exact: true })).toHaveValue(
      seed.crewTripReference,
    );
    await context.setOffline(true);

    let validationRequests = 0;
    await page.route('**/v1/auth/crew/me', async (route) => {
      validationRequests += 1;
      if (validationRequests === 1) {
        await route.abort('failed');
        return;
      }
      await route.continue();
    });
    await page.clock.install();
    await page.clock.pauseAt(new Date());

    await context.setOffline(false);
    await page.clock.runFor(0);
    await expect(page.getByText('Core API indisponible', { exact: false })).toBeVisible();
    expect(validationRequests).toBe(1);
    await page.goto(appUrl(crewApp, '/connexion'));
    await page.clock.fastForward(60_000);
    expect(validationRequests).toBe(1);
  });

  test('coalesces concurrent online events into one refresh and one queue sync', async ({
    context,
    page,
  }) => {
    test.setTimeout(30_000);
    const seed = checkInSeed();
    await addSessionCookie(context, 'crew', preauthenticatedSession('crew'));
    await page.goto(appUrl(crewApp, '/session'));
    await expect(page.getByRole('combobox', { name: 'Voyage', exact: true })).toHaveValue(
      seed.crewTripReference,
    );
    await context.setOffline(true);
    await page.getByLabel('Code QR passager').fill('ETPAX1:ETQ-XXXXXXXXXXXXXXX4');
    await page.getByRole('button', { name: 'Enregistrer l’embarquement' }).click();
    const queuedClientEventId = (await offlineDatabaseDump(page)).events[0]?.clientEventId;

    let validationRequests = 0;
    let releaseFirstRequest: (() => void) | undefined;
    const firstRequestGate = new Promise<void>((resolve) => {
      releaseFirstRequest = resolve;
    });
    await page.route('**/v1/auth/crew/me', async (route) => {
      validationRequests += 1;
      if (validationRequests === 1) await firstRequestGate;
      await route.continue();
    });
    const sync = { requests: 0, clientEventIds: [] } satisfies SyncCapture;
    await mockAcknowledgedCrewSync(page, seed.crewTripReference, sync);
    await page.clock.install();
    await page.clock.pauseAt(new Date());

    await context.setOffline(false);
    await page.clock.runFor(0);
    await expect.poll(() => validationRequests).toBe(1);
    await page.evaluate(() => {
      window.dispatchEvent(new Event('online'));
      window.dispatchEvent(new Event('online'));
      window.dispatchEvent(new Event('online'));
    });
    await page.clock.runFor(0);
    expect(validationRequests).toBe(1);
    expect(sync.requests).toBe(0);
    expect((await offlineDatabaseDump(page)).events[0]).toMatchObject({
      clientEventId: queuedClientEventId,
      status: 'PENDING',
    });

    releaseFirstRequest?.();
    await expect(page.getByText('En ligne', { exact: true })).toBeVisible();
    await page.clock.runFor(0);
    await expect.poll(() => sync.requests).toBe(1);
    expect(validationRequests).toBe(1);
    expect(sync.clientEventIds).toEqual([queuedClientEventId]);
    expect((await offlineDatabaseDump(page)).events).toEqual([]);
  });

  test('preserves pending scans when the Crew session expires before reconnect', async ({
    context,
    page,
  }) => {
    test.setTimeout(120_000);
    const seed = checkInSeed();
    const session = await createEphemeralCrewSession();
    await addSessionCookie(context, 'crew', session.token);
    await page.goto(appUrl(crewApp, '/session'));
    await expect(page.getByRole('combobox', { name: 'Voyage', exact: true })).toHaveValue(
      seed.crewTripReference,
    );
    await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) throw new Error('service worker unavailable');
      await navigator.serviceWorker.ready;
    });
    await page.reload();

    await context.setOffline(true);
    await page.getByLabel('Code QR passager').fill('ETPAX1:ETQ-YYYYYYYYYYYYYYYY');
    await page.getByRole('button', { name: 'Enregistrer l’embarquement' }).click();
    await expect(page.getByText('1 en attente')).toBeVisible();
    const beforeExpiry = await offlineDatabaseDump(page);
    const queuedClientEventId = beforeExpiry.events[0]?.clientEventId;
    expect(queuedClientEventId).toEqual(expect.any(String));
    await expireCrewSession(session.sessionId);

    let validationRequests = 0;
    let csrfRequests = 0;
    let syncRequests = 0;
    await page.route('**/v1/auth/crew/me', async (route) => {
      validationRequests += 1;
      await route.continue();
    });
    await page.route('**/v1/auth/crew/csrf', async (route) => {
      csrfRequests += 1;
      await route.continue();
    });
    await page.route('**/v1/crew/trips/*/events/sync', async (route) => {
      syncRequests += 1;
      await route.continue();
    });
    await page.clock.install();
    await page.clock.pauseAt(new Date());

    await context.setOffline(false);
    await page.clock.runFor(0);
    await expect(page).toHaveURL(appUrl(crewApp, '/connexion'));
    const dump = await offlineDatabaseDump(page);
    expect(dump.events).toHaveLength(1);
    expect(dump.events[0]).toMatchObject({
      clientEventId: queuedClientEventId,
      tripReference: seed.crewTripReference,
      status: 'PENDING',
    });
    expect(validationRequests).toBe(1);
    expect(csrfRequests).toBe(0);
    expect(syncRequests).toBe(0);

    await page.clock.fastForward(60_000);
    expect(validationRequests).toBe(1);
    expect(csrfRequests).toBe(0);
    expect(syncRequests).toBe(0);
  });
});
