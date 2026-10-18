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

const clientApp = appByName('client');
const opsApp = appByName('ops');
const CLIENT_ORIGIN = `http://localhost:${clientApp.port}`;

function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

async function addSessionCookie(
  context: BrowserContext,
  realm: 'customer' | 'staff',
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

/** Customer API through the page session (Origin and in-memory CSRF). */
function customerApi(request: APIRequestContext) {
  const headers = { Origin: CLIENT_ORIGIN };
  return {
    get: (path: string) => request.get(`${BROWSER_API_URL}/v1/booking${path}`, { headers }),
    async post(path: string, data: unknown = {}) {
      const csrf = await request.get(`${BROWSER_API_URL}/v1/auth/customer/csrf`, { headers });
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

/**
 * No rule covers these synthetic journeys, so the evaluation needs a human
 * review: the reviewer records a reasoned COMPLIANT decision (PR-12 path).
 */
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
        reason: 'Revue synthétique du scénario navigateur check-in.',
        previousReviewId: null,
      },
    );
    expect(reviewed.status()).toBe(201);
  } finally {
    await reviewer.context.close();
  }
}

/**
 * PR-14. Dedicated customer, trips, bookings and travellers: nothing is
 * shared with the PR-10..PR-13 scenarios. Synthetic data only.
 */
test.describe('PR-14 check-in and boarding', () => {
  test.describe.configure({ mode: 'serial' });

  test('customer sees the six gates, assigns a seat, checks in and gets a PII-free QR', async ({
    browser,
    page,
  }) => {
    test.setTimeout(120_000);
    const errors = trackPageErrors(page);
    const seed = checkInSeed();
    await addSessionCookie(page.context(), 'customer', preauthenticatedSession('checkInCustomer'));
    await makeCompliant(
      browser,
      page.request,
      seed.customerBookingReference,
      seed.readyPassenger.reference,
    );
    await page.goto(appUrl(clientApp, '/compte'));

    const section = page.getByTestId('customer-check-in');
    await expect(section).toContainText('il ne remplace pas les documents de voyage');
    const ready = section.getByTestId(`check-in-${seed.readyPassenger.reference}`);
    const checks = ready.getByRole('list', { name: 'Contrôles avant check-in' });
    await expect(checks.getByRole('listitem').filter({ hasText: 'Siège' })).toContainText(
      'À régulariser',
    );
    await expect(checks.getByRole('listitem').filter({ hasText: 'Conformité' })).toContainText(
      'OK',
    );
    await expect(ready.getByRole('button', { name: 'Effectuer le check-in' })).toBeDisabled();
    await ready.getByLabel('Siège').selectOption('1A');
    await ready.getByRole('button', { name: 'Affecter le siège' }).click();
    await expect(section.getByRole('status')).toContainText('Siège 1A affecté.');
    await expect(checks.getByRole('listitem')).toHaveCount(6);
    for (const item of await checks.getByRole('listitem').all()) {
      await expect(item).toContainText('OK');
    }
    await ready.getByRole('button', { name: 'Effectuer le check-in' }).click();
    await expect(section.getByRole('status')).toContainText(/Enregistrement effectué : ETK-/);
    await expect(ready).toContainText('Enregistrement effectué');
    await expect(ready).toContainText('1A');
    await expect(ready).toContainText(seed.customerTripReference);
    await ready.getByRole('button', { name: 'Afficher le QR d’embarquement' }).click();
    const qr = ready.getByRole('img', { name: /QR d’embarquement ETK-/ });
    await expect(qr).toBeVisible();
    const source = decodeURIComponent((await qr.getAttribute('src')) ?? '');
    expect(source.startsWith('data:image/svg+xml;charset=utf-8,<svg')).toBe(true);
    for (const personal of [
      'Aminata',
      'Prête',
      seed.customerBookingReference,
      seed.readyPassenger.reference,
      seed.customerTripReference,
    ]) {
      expect(source).not.toContain(personal);
    }
    await expect(ready).toContainText('Le QR ne remplace pas les documents de voyage.');

    // The other traveller stays blocked, with explicit next actions.
    const blocked = section.getByTestId(`check-in-${seed.blockedPassenger.reference}`);
    await expect(
      blocked
        .getByRole('list', { name: 'Contrôles avant check-in' })
        .getByRole('listitem')
        .filter({ hasText: 'Conformité' }),
    ).toContainText('À régulariser');
    const todo = blocked.getByRole('list', { name: 'À faire avant le check-in' });
    await expect(todo).toContainText('Faire vérifier la conformité');
    await expect(todo).toContainText('Affecter un siège à ce voyageur.');
    await expect(blocked.getByRole('button', { name: 'Effectuer le check-in' })).toBeDisabled();
    const refused = await customerApi(page.request).post(
      `/bookings/${seed.customerBookingReference}/passengers/${seed.blockedPassenger.reference}/check-in`,
    );
    expect(refused.status()).toBe(409);
    expect(((await refused.json()) as { code: string }).code).toBe('CHECK_IN_NOT_READY');
    expect(errors).toEqual([]);
  });

  test('OPS counter agent assigns the seat and checks the passenger in, without boarding', async ({
    browser,
    page,
  }) => {
    test.setTimeout(120_000);
    const errors = trackPageErrors(page);
    const seed = checkInSeed();
    const customerContext = await browser.newContext();
    try {
      await addSessionCookie(
        customerContext,
        'customer',
        preauthenticatedSession('checkInCustomer'),
      );
      const customerPage = await customerContext.newPage();
      await makeCompliant(
        browser,
        customerPage.request,
        seed.counterBookingReference,
        seed.counterPassenger.reference,
      );
    } finally {
      await customerContext.close();
    }

    await addSessionCookie(page.context(), 'staff', preauthenticatedSession('checkInAgent'));
    await page.goto(appUrl(opsApp, '/'));
    await page
      .getByRole('navigation', { name: 'Navigation principale' })
      .getByRole('link', { name: 'Check-in / Embarquement' })
      .click();
    await expect(page).toHaveURL(appUrl(opsApp, '/check-in'));
    const workspace = page.getByTestId('check-in-workspace');
    // checkin.manage is not boarding: no boarding panel for the counter agent.
    await expect(page.getByTestId('boarding-panel')).toHaveCount(0);
    await workspace.getByLabel('Référence réservation').fill(seed.counterBookingReference);
    await workspace.getByRole('button', { name: 'Filtrer' }).click();
    const row = workspace.getByRole('row').filter({ hasText: seed.counterPassenger.reference });
    await expect(row).toContainText('Siège non affecté');
    await row.getByRole('button', { name: 'Consulter' }).click();
    await expect(page.locator('#check-in-detail-panel')).toBeFocused();

    const detail = page.getByTestId('check-in-detail');
    await expect(detail).toContainText('Coura Comptoir');
    await expect(detail).toContainText('Non prêt');
    await expect(detail.getByRole('button', { name: 'Enregistrer le passager' })).toBeDisabled();
    await detail.getByLabel('Siège réservé').selectOption('1A');
    await detail.getByRole('button', { name: 'Affecter le siège' }).click();
    await expect(workspace.getByRole('status')).toContainText('Siège 1A affecté.');
    await expect(detail.getByTestId('check-in-seat')).toHaveText('1A');
    await expect(detail.getByTestId('check-in-readiness').locator('tbody tr')).toHaveCount(6);
    await expect(detail).toContainText('Prêt pour le check-in');
    await detail.getByRole('button', { name: 'Enregistrer le passager' }).click();
    await expect(workspace.getByRole('status')).toContainText(/Passager enregistré : ETK-/);
    await expect(detail).toContainText('Enregistré');
    await expect(detail).toContainText('Comptoir');
    await expect(page.getByRole('button', { name: /forcer|ignorer|contourner/i })).toHaveCount(0);
    // The counter agent cannot board through the API either.
    const scan = await directAdminApi(page.request).post('/boarding/scan', {
      qrPayload: 'ETPAX1:ETQ-0000000000000000',
      deviceId: 'counter-01',
    });
    expect(scan.status()).toBe(403);
    expect(errors).toEqual([]);
  });

  test('boarding operator scans the QR, boards once, and a second scan adds nothing', async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    const seed = checkInSeed();
    await addSessionCookie(page.context(), 'staff', preauthenticatedSession('boardingOperator'));
    const api = directAdminApi(page.request);
    const detail = await api.get(
      `/check-in/bookings/${seed.counterBookingReference}/passengers/${seed.counterPassenger.reference}`,
    );
    expect(detail.status()).toBe(200);
    const checkIn = ((await detail.json()) as { checkIn: { qrPayload: string; reference: string } })
      .checkIn;

    await page.goto(appUrl(opsApp, '/check-in'));
    const panel = page.getByTestId('boarding-panel');
    await panel.getByLabel('Code QR d’embarquement').fill(checkIn.qrPayload);
    await panel.getByLabel('Poste d’embarquement').fill('gate-e2e');
    await panel.getByRole('button', { name: 'Vérifier le code' }).click();
    const resolution = panel.getByTestId('boarding-resolution');
    await expect(resolution).toContainText('Coura Comptoir');
    await expect(resolution).toContainText('1A');
    await expect(resolution).toContainText('Prêt à embarquer');
    await panel.getByRole('button', { name: 'Embarquer' }).click();
    await expect(panel.getByRole('status')).toContainText(/Voyageur embarqué \(ETE-/);
    await expect(resolution).toContainText('Déjà embarqué');
    await expect(panel.getByRole('button', { name: 'Embarquer' })).toHaveCount(0);

    const second = await api.post('/boarding/scan', {
      qrPayload: checkIn.qrPayload,
      deviceId: 'gate-e2e-2',
    });
    expect(second.status()).toBe(409);
    expect(((await second.json()) as { code: string }).code).toBe('PASSENGER_ALREADY_BOARDED');
    const after = (await (
      await api.get(
        `/check-in/bookings/${seed.counterBookingReference}/passengers/${seed.counterPassenger.reference}`,
      )
    ).json()) as { checkIn: { boarding: { deviceId: string } | null } };
    expect(after.checkIn.boarding).toMatchObject({ deviceId: 'gate-e2e' });
    expect(errors).toEqual([]);
  });

  test('staff without check-in permissions has no menu entry, no page and receives 403', async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await addSessionCookie(page.context(), 'staff', preauthenticatedSession('checkInDenied'));
    await page.goto(appUrl(opsApp, '/'));
    const nav = page.getByRole('navigation', { name: 'Navigation principale' });
    await expect(nav.getByRole('link', { name: 'Paiements' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Check-in / Embarquement' })).toHaveCount(0);
    const api = directAdminApi(page.request);
    expect((await api.get('/check-in/booking-passengers')).status()).toBe(403);
    expect(
      (
        await api.post('/boarding/scan', {
          qrPayload: 'ETPAX1:ETQ-0000000000000000',
          deviceId: 'x1',
        })
      ).status(),
    ).toBe(403);
    await page.goto(appUrl(opsApp, '/check-in'));
    await expect(
      page.getByText('Vous n’avez pas la permission d’afficher cette page.'),
    ).toBeVisible();
    await expect(page.getByTestId('check-in-workspace')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
