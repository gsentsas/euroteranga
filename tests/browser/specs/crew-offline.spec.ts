import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { appByName, appUrl } from '../apps.js';
import { checkInSeed, preauthenticatedSession, type PreauthenticatedFixture } from '../fixtures.js';
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
});
