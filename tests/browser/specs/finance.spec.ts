import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { appByName, appUrl } from '../apps.js';
import { preauthenticatedSession } from '../fixtures.js';
import { BROWSER_API_URL } from '../staff.js';

const ops = appByName('ops');

function trackPageErrors(page: Page) {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  return { pageErrors, consoleErrors };
}

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

const tripReference = 'ET-FINANCE-E2E';

function financeSummary() {
  return {
    trip: {
      id: '01900000-0000-7000-8000-000000000220',
      reference: tripReference,
      status: 'SCHEDULED',
    },
    currencies: [
      {
        currencyCode: 'EUR',
        currencyMinorUnit: 2,
        ticketRevenueMinor: '20000',
        additionalRevenueMinor: '10000',
        grossRevenueMinor: '30000',
        refundMinor: '5000',
        netRevenueMinor: '25000',
        expenseMinor: '4000',
        contributionMinor: '21000',
        payoutMinor: '1000',
        outstandingExpenseMinor: '3000',
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
        payoutMinor: '0',
        outstandingExpenseMinor: '50000',
      },
    ],
    payments: [
      {
        id: '01900000-0000-7000-8000-000000000221',
        reference: 'ETP-0123456789AB',
        amountMinor: '20000',
        currencyCode: 'EUR',
        currencyMinorUnit: 2,
        booking: { reference: 'ETB-0123456789AB', cancelledAt: null },
        refunds: [
          {
            id: '01900000-0000-7000-8000-000000000222',
            reference: 'ETRF-0123456789AB',
            amountMinor: '5000',
            reason: 'Remboursement synthétique',
            recordedAt: '2026-10-17T10:00:00.000Z',
            creditNote: {
              reference: 'ETCN-0123456789AB',
              issuedAt: '2026-10-17T10:00:00.000Z',
            },
          },
        ],
      },
    ],
    revenues: [
      {
        id: '01900000-0000-7000-8000-000000000223',
        reference: 'ETFR-0123456789AB',
        type: 'OPTION',
        status: 'ACTIVE',
        amountMinor: '10000',
        currencyCode: 'EUR',
        currencyMinorUnit: 2,
        description: 'Option synthétique',
        occurredAt: '2026-10-17T09:00:00.000Z',
        createdAt: '2026-10-17T09:00:01.000Z',
        voidedAt: null,
        voidReason: null,
        baggage: null,
      },
    ],
    expenses: [
      {
        id: '01900000-0000-7000-8000-000000000224',
        reference: 'ETFE-0123456789AB',
        type: 'FUEL',
        status: 'ACTIVE',
        amountMinor: '4000',
        currencyCode: 'EUR',
        currencyMinorUnit: 2,
        description: 'Carburant synthétique',
        vendorLabel: 'Fournisseur test',
        occurredAt: '2026-10-17T09:30:00.000Z',
        createdAt: '2026-10-17T09:30:01.000Z',
        voidedAt: null,
        voidReason: null,
        payouts: [
          {
            id: '01900000-0000-7000-8000-000000000225',
            reference: 'ETPO-0123456789AB',
            amountMinor: '1000',
            currencyCode: 'EUR',
            currencyMinorUnit: 2,
            note: 'Acompte synthétique',
            paidAt: '2026-10-17T09:40:00.000Z',
            recordedAt: '2026-10-17T09:40:01.000Z',
          },
        ],
        receipts: [],
      },
      {
        id: '01900000-0000-7000-8000-000000000226',
        reference: 'ETFE-ABCDEFGHJKMN',
        type: 'TOLL',
        status: 'ACTIVE',
        amountMinor: '50000',
        currencyCode: 'XOF',
        currencyMinorUnit: 0,
        description: 'Péage synthétique',
        vendorLabel: null,
        occurredAt: '2026-10-17T09:35:00.000Z',
        createdAt: '2026-10-17T09:35:01.000Z',
        voidedAt: null,
        voidReason: null,
        payouts: [],
        receipts: [],
      },
    ],
    fxConversionApplied: false,
  };
}

async function mockFinance(page: Page) {
  await page.route('**/v1/admin/finance/trips/' + tripReference, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(financeSummary()),
    }),
  );
}

async function loadTrip(page: Page) {
  await page.getByLabel('Référence voyage').fill(tripReference);
  await page.getByRole('button', { name: 'Charger le voyage' }).click();
  await expect(
    page.getByRole('heading', { name: 'Contribution du voyage ' + tripReference }),
  ).toBeVisible();
}

test.describe('PR-22 operational finance', () => {
  test('DIRECTOR sees exact per-currency contribution and finance/refund actions', async ({
    context,
    page,
  }) => {
    const errors = trackPageErrors(page);
    await staffSession(context, preauthenticatedSession('complianceRuleManager'));
    await mockFinance(page);

    await page.goto(appUrl(ops, '/finance'));
    await expect(page.getByTestId('finance-workspace')).toBeVisible();
    await loadTrip(page);

    const workspace = page.getByTestId('finance-workspace');
    await expect(workspace).toContainText('Aucune conversion de change');
    const profitability = workspace.getByRole('table', {
      name: 'Rentabilité opérationnelle par devise',
    });
    await expect(profitability.getByRole('row').filter({ hasText: 'EUR' })).toContainText(
      '210,00 EUR',
    );
    await expect(profitability.getByRole('row').filter({ hasText: 'XOF' })).toContainText(
      '-50 000 XOF',
    );

    await expect(
      workspace.getByRole('heading', { name: 'Ajouter une recette hors billet' }),
    ).toBeVisible();
    await expect(workspace.getByRole('heading', { name: 'Ajouter une dépense' })).toBeVisible();
    await expect(
      workspace.getByRole('button', { name: 'Enregistrer le remboursement et l’avoir' }),
    ).toBeVisible();
    await expect(workspace).toContainText('ETCN-0123456789AB');
    await expect(workspace.getByRole('button', { name: 'Export CSV' })).toBeVisible();
    await expect(workspace.getByRole('button', { name: 'Export XLSX' })).toBeVisible();

    expect(errors.pageErrors).toEqual([]);
    expect(errors.consoleErrors).toEqual([]);
  });

  test('OPS_MANAGER has read-only Finance: no revenue, expense, payout or refund controls', async ({
    context,
    page,
  }) => {
    const errors = trackPageErrors(page);
    await staffSession(context, preauthenticatedSession('permitManager'));
    await mockFinance(page);

    await page.goto(appUrl(ops, '/finance'));
    await loadTrip(page);

    const workspace = page.getByTestId('finance-workspace');
    await expect(workspace).toContainText('210,00 EUR');
    await expect(
      workspace.getByRole('heading', { name: 'Ajouter une recette hors billet' }),
    ).toHaveCount(0);
    await expect(workspace.getByRole('heading', { name: 'Ajouter une dépense' })).toHaveCount(0);
    await expect(
      workspace.getByRole('button', { name: 'Enregistrer le remboursement et l’avoir' }),
    ).toHaveCount(0);
    await expect(workspace.getByRole('button', { name: 'Enregistrer le règlement' })).toHaveCount(
      0,
    );

    expect(errors.pageErrors).toEqual([]);
    expect(errors.consoleErrors).toEqual([]);
  });
});
