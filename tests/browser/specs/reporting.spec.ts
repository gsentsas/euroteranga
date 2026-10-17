import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { appByName, appUrl } from '../apps.js';
import { preauthenticatedSession } from '../fixtures.js';
import { BROWSER_API_URL } from '../staff.js';

const ops = appByName('ops');

async function staffSession(context: BrowserContext, token: string) {
  await context.addCookies([
    {
      name: 'et_staff_session',
      value: token,
      url: BROWSER_API_URL,
      httpOnly: true,
      secure: false,
      sameSite: 'Strict',
    },
  ]);
}

function trackPageErrors(page: Page) {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  return { pageErrors, consoleErrors };
}

function overview(empty = false) {
  return {
    period: {
      from: '2026-09-18T00:00:00.000Z',
      to: '2026-10-18T00:00:00.000Z',
      semantics: '[from,to) on trip.plannedDepartureAt',
    },
    filters: { routeId: null, tripId: null, vehicleId: null, status: null },
    activity: {
      tripCount: empty ? 0 : 3,
      draftTripCount: 0,
      scheduledTripCount: empty ? 0 : 1,
      inProgressTripCount: 0,
      completedTripCount: empty ? 0 : 2,
      cancelledTripCount: 0,
    },
    commercial: {
      bookingCount: empty ? 0 : 11,
      confirmedBookingCount: empty ? 0 : 10,
      cancelledBookingCount: empty ? 0 : 1,
      passengerCount: empty ? 0 : 12,
      soldSeatCount: empty ? 0 : 12,
      offeredSeatCapacity: empty ? 0 : 24,
      loadFactor: empty ? null : 0.5,
      cancellationRate: empty ? null : 1 / 11,
    },
    finance: {
      fxConversionApplied: false,
      currencies: empty
        ? []
        : [
            {
              currencyCode: 'EUR',
              currencyMinorUnit: 2,
              ticketRevenueMinor: '240000',
              additionalRevenueMinor: '10000',
              grossRevenueMinor: '250000',
              refundMinor: '20000',
              netRevenueMinor: '230000',
              expenseMinor: '80000',
              contributionMinor: '150000',
              contributionRate: 150000 / 230000,
              payoutMinor: '50000',
              outstandingExpenseMinor: '30000',
              averageTicketRevenuePerConfirmedBookingMinor: '24000',
              averageNetRevenuePerPassengerMinor: '19166',
              averageNetRevenuePerSoldSeatMinor: '19166',
              profitableTripCount: 2,
              lossTripCount: 0,
              breakEvenTripCount: 0,
            },
            {
              currencyCode: 'XOF',
              currencyMinorUnit: 0,
              ticketRevenueMinor: '0',
              additionalRevenueMinor: '0',
              grossRevenueMinor: '0',
              refundMinor: '0',
              netRevenueMinor: '0',
              expenseMinor: '50000',
              contributionMinor: '-50000',
              contributionRate: null,
              payoutMinor: '0',
              outstandingExpenseMinor: '50000',
              averageTicketRevenuePerConfirmedBookingMinor: null,
              averageNetRevenuePerPassengerMinor: null,
              averageNetRevenuePerSoldSeatMinor: null,
              profitableTripCount: 0,
              lossTripCount: 1,
              breakEvenTripCount: 0,
            },
          ],
    },
    operations: {
      departureSampleCount: empty ? 0 : 2,
      onTimeDepartureCount: empty ? 0 : 1,
      delayedDepartureCount: empty ? 0 : 1,
      averageDelayMinutes: empty ? null : 7.5,
      maximumDelayMinutes: empty ? null : 15,
      actualDurationSampleCount: empty ? 0 : 2,
      averageActualDurationMinutes: empty ? null : 1260,
    },
    incidents: {
      incidentCount: empty ? 0 : 2,
      openIncidentCount: empty ? 0 : 1,
      resolvedIncidentCount: empty ? 0 : 1,
      severity: { LOW: 0, MEDIUM: 1, HIGH: 1, CRITICAL: 0 },
      averageResolutionMinutes: empty ? null : 45,
    },
    baggage: {
      baggageCount: empty ? 0 : 15,
      loadedBaggageCount: empty ? 0 : 14,
      deliveredBaggageCount: empty ? 0 : 13,
      anomalyBaggageCount: empty ? 0 : 1,
      baggageIncidentCount: empty ? 0 : 1,
      anomalyRate: empty ? null : 1 / 15,
    },
    fleet: {
      vehicleCount: 4,
      activeVehicleCount: 3,
      outOfServiceVehicleCount: 1,
      retiredVehicleCount: 0,
      usedVehicleCount: empty ? 0 : 2,
      activeUsedVehicleCount: empty ? 0 : 2,
      utilizationRate: empty ? 0 : 2 / 3,
      tripsPerUsedVehicle: empty ? null : 1.5,
    },
    routes: empty
      ? []
      : [
          {
            routeVersionId: '01900000-0000-7000-8000-000000000301',
            routeId: '01900000-0000-7000-8000-000000000302',
            routeCode: 'PAR-DKR',
            routeName: 'Paris Dakar',
            routeVersion: 2,
            tripCount: 3,
            passengerCount: 12,
            soldSeatCount: 12,
            offeredSeatCapacity: 24,
            loadFactor: 0.5,
            cancellationCount: 1,
            incidentCount: 2,
            currencies: [
              {
                currencyCode: 'EUR',
                currencyMinorUnit: 2,
                ticketRevenueMinor: '240000',
                additionalRevenueMinor: '10000',
                grossRevenueMinor: '250000',
                refundMinor: '20000',
                netRevenueMinor: '230000',
                expenseMinor: '80000',
                contributionMinor: '150000',
                contributionRate: 150000 / 230000,
                payoutMinor: '50000',
                outstandingExpenseMinor: '30000',
                averageTicketRevenuePerConfirmedBookingMinor: null,
                averageNetRevenuePerPassengerMinor: null,
                averageNetRevenuePerSoldSeatMinor: null,
                profitableTripCount: 0,
                lossTripCount: 0,
                breakEvenTripCount: 0,
              },
            ],
          },
        ],
    recentTrips: empty
      ? []
      : [
          {
            id: '01900000-0000-7000-8000-000000000303',
            reference: 'ET-REPORT-E2E',
            status: 'COMPLETED',
            plannedDepartureAt: '2026-10-17T08:00:00.000Z',
            plannedArrivalAt: '2026-10-18T08:00:00.000Z',
            route: {
              id: '01900000-0000-7000-8000-000000000302',
              code: 'PAR-DKR',
              name: 'Paris Dakar',
              version: 2,
            },
            vehicle: { id: '01900000-0000-7000-8000-000000000304', code: 'BUS-01' },
            bookingCount: 5,
            cancelledBookingCount: 0,
            passengerCount: 6,
            soldSeatCount: 6,
            offeredSeatCapacity: 8,
            loadFactor: 0.75,
            incidentCount: 1,
            currencies: [],
          },
        ],
    privacy: { containsPassengerPii: false },
  };
}

test.describe('PR-23 operational reporting', () => {
  test('OPS_MANAGER sees KPI and never combines EUR with XOF', async ({ context, page }) => {
    const errors = trackPageErrors(page);
    await staffSession(context, preauthenticatedSession('permitManager'));
    await page.route(/\/v1\/admin\/reporting\/overview(?:\?.*)?$/u, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(overview()),
      }),
    );

    await page.goto(appUrl(ops, '/reporting'));
    const workspace = page.getByTestId('reporting-workspace');
    await expect(workspace).toBeVisible();
    const loadFactorKpi = workspace.locator('article').filter({ hasText: 'Taux de remplissage' });
    await expect(loadFactorKpi.getByText('50 %', { exact: true })).toBeVisible();

    const finance = workspace.getByRole('table', { name: 'Performance financière par devise' });
    await expect(finance.getByRole('row').filter({ hasText: 'EUR' })).toContainText('1 500,00 EUR');
    await expect(finance.getByRole('row').filter({ hasText: 'XOF' })).toContainText('-50 000 XOF');
    await expect(finance.getByRole('row').filter({ hasText: 'EUR' })).not.toContainText('XOF');
    await expect(workspace.getByRole('button', { name: 'Export CSV' })).toBeVisible();
    await expect(workspace.getByRole('button', { name: 'Export XLSX' })).toBeVisible();
    expect(errors.pageErrors).toEqual([]);
    expect(errors.consoleErrors).toEqual([]);
  });

  test('empty period stays explicit and never renders NaN', async ({ context, page }) => {
    await staffSession(context, preauthenticatedSession('permitManager'));
    await page.route(/\/v1\/admin\/reporting\/overview(?:\?.*)?$/u, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(overview(true)),
      }),
    );
    await page.goto(appUrl(ops, '/reporting'));
    const workspace = page.getByTestId('reporting-workspace');
    await expect(workspace).toContainText('Aucun mouvement financier');
    await expect(workspace).toContainText('Aucun trajet sur la période');
    await expect(workspace).not.toContainText('NaN');
    await expect(workspace).not.toContainText('Infinity');
  });

  test('FINANCE does not receive reporting by default', async ({ context, page }) => {
    await staffSession(context, preauthenticatedSession('permitDenied'));
    await page.goto(appUrl(ops, '/reporting'));
    await expect(
      page.getByText('Vous n’avez pas la permission d’afficher cette page.', { exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId('reporting-workspace')).toHaveCount(0);
  });
});
