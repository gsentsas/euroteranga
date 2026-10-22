import type { ApiEnv } from '@euroteranga/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminApi, isolatedDatabase, staffActor, type StaffActor } from '../../support/admin-helpers.js';
import { db } from '../../support/auth-helpers.js';
import { cargoCreateBody, cargoTripFixture, staffCargoApi } from '../../support/cargo-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

const quoteBody = {
  currencyCode: 'EUR',
  currencyMinorUnit: 2,
  lines: [
    { kind: 'CHARGE', label: 'Transport fret', amountMinor: '15000' },
    { kind: 'DISCOUNT', label: 'Remise commerciale', amountMinor: '2000' },
  ],
};

describe('OPS-PROFIT-1 trip profitability projection', () => {
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let t: TestApp;
  let env: ApiEnv;
  let manager: StaffActor;
  let reader: StaffActor;
  let denied: StaffActor;

  beforeAll(async () => {
    database = await isolatedDatabase();
    env = integrationEnv({ DATABASE_URL: database.url });
    t = await startTestApp(env);
    [manager, reader, denied] = await Promise.all([
      staffActor(t.app, ['SUPER_ADMIN']),
      staffActor(t.app, ['OPS_MANAGER']),
      staffActor(t.app, ['DISPATCHER']),
    ]);
  }, 60_000);

  afterAll(async () => {
    await t.app.close();
    await database.drop();
  });

  const profit = (actor: StaffActor, tripReference: string) =>
    adminApi(actor).get('/ops-profit/trips/' + tripReference);

  async function assignedCargo(
    tripReference: string,
    vehicleCode: string,
    overrides: Record<string, unknown>,
  ) {
    const created = await staffCargoApi(manager).create(cargoCreateBody(overrides));
    expect(created.status, created.text).toBe(201);
    const reference = created.body.reference as string;
    for (const type of ['BOOKED', 'RECEIVED', 'INSPECTED']) {
      const event = await staffCargoApi(manager).event(reference, { type });
      expect(event.status, event.text).toBe(201);
    }
    const assigned = await staffCargoApi(manager).assign(reference, {
      tripReference,
      vehicleCode,
    });
    expect(assigned.status, assigned.text).toBe(200);
    return reference;
  }

  it('keeps Finance actuals separate from budget and accepted Cargo commercial value', async () => {
    const fixture = await cargoTripFixture(t.app, manager, {
      payloadCapacityKg: 1000,
      cargoVolumeLiters: 2000,
    });

    const plan = await db(t.app).tripCostPlan.create({
      data: {
        tripId: fixture.tripId,
        status: 'ESTIMATED',
        currencyCode: 'EUR',
        currencyMinorUnit: 2,
      },
    });
    await db(t.app).tripCostItem.createMany({
      data: [
        {
          planId: plan.id,
          category: 'FUEL',
          label: 'Carburant prévisionnel',
          amountMinor: 30000n,
          position: 0,
        },
        {
          planId: plan.id,
          category: 'FERRY',
          label: 'Ferry prévisionnel',
          amountMinor: 20000n,
          position: 1,
        },
      ],
    });

    await db(t.app).tripRevenue.create({
      data: {
        reference: 'ETFR-0123456789AB',
        tripId: fixture.tripId,
        type: 'OPTION',
        amountMinor: 30000n,
        currencyCode: 'EUR',
        currencyMinorUnit: 2,
        description: 'Option opérationnelle',
        occurredAt: new Date(),
        createdByIdentityId: manager.id,
      },
    });
    await db(t.app).tripExpense.create({
      data: {
        reference: 'ETFE-0123456789AB',
        tripId: fixture.tripId,
        type: 'FUEL',
        amountMinor: 10000n,
        currencyCode: 'EUR',
        currencyMinorUnit: 2,
        description: 'Carburant réel',
        occurredAt: new Date(),
        createdByIdentityId: manager.id,
      },
    });

    const quotedCargo = await assignedCargo(fixture.tripReference, fixture.vehicleCode, {
      weightKg: '100.125',
      volumeLiters: 500,
      senderName: 'PRIVATE OPS PROFIT SENDER',
      recipientName: 'PRIVATE OPS PROFIT RECIPIENT',
      declaredContents: 'PRIVATE OPS PROFIT CONTENT',
    });
    const draft = await staffCargoApi(manager).createQuote(quotedCargo, quoteBody);
    expect(draft.status, draft.text).toBe(201);
    const issued = await staffCargoApi(manager).issueQuote(quotedCargo, draft.body.reference, {
      expectedUpdatedAt: draft.body.updatedAt,
    });
    expect(issued.status, issued.text).toBe(200);
    const accepted = await staffCargoApi(manager).acceptQuote(quotedCargo, draft.body.reference, {
      expectedUpdatedAt: issued.body.updatedAt,
    });
    expect(accepted.status, accepted.text).toBe(200);

    await assignedCargo(fixture.tripReference, fixture.vehicleCode, {
      weightKg: '50.125',
      volumeLiters: 250,
      packageCount: 1,
    });

    expect((await profit(denied, fixture.tripReference)).status).toBe(403);
    const response = await profit(reader, fixture.tripReference);
    expect(response.status, response.text).toBe(200);
    expect(response.body).toMatchObject({
      trip: {
        reference: fixture.tripReference,
        status: 'SCHEDULED',
      },
      financeActuals: [
        {
          currencyCode: 'EUR',
          currencyMinorUnit: 2,
          ticketRevenueMinor: '0',
          additionalRevenueMinor: '30000',
          netRevenueMinor: '30000',
          expenseMinor: '10000',
          contributionMinor: '20000',
          payoutMinor: '0',
          outstandingExpenseMinor: '10000',
        },
      ],
      plannedCost: {
        status: 'ESTIMATED',
        currencyCode: 'EUR',
        currencyMinorUnit: 2,
        plannedCostMinor: '50000',
        actualExpenseMinor: '10000',
        varianceMinor: '-40000',
        remainingBudgetMinor: '40000',
        varianceBasisPoints: '-8000',
      },
      cargo: {
        shipmentCount: 2,
        acceptedQuoteCount: 1,
        shipmentsWithoutAcceptedQuote: 1,
        commercial: [
          {
            currencyCode: 'EUR',
            currencyMinorUnit: 2,
            acceptedQuoteCount: 1,
            acceptedCommercialValueMinor: '13000',
            recognizedRevenueMinor: '0',
          },
        ],
        capacity: {
          vehicleCount: 1,
          vehicleCodes: [fixture.vehicleCode],
          payloadCapacityKg: '1000',
          cargoVolumeLiters: '2000',
          usedWeightKg: '150.250',
          usedVolumeLiters: '750',
        },
      },
      warnings: ['CARGO_COMMERCIAL_NOT_RECOGNIZED_REVENUE'],
      fxConversionApplied: false,
      cargoRevenueRecognitionApplied: false,
    });

    const projection = JSON.stringify(response.body);
    expect(projection).not.toContain('PRIVATE OPS PROFIT SENDER');
    expect(projection).not.toContain('PRIVATE OPS PROFIT RECIPIENT');
    expect(projection).not.toContain('PRIVATE OPS PROFIT CONTENT');
    expect(response.body.financeActuals[0].contributionMinor).toBe('20000');
    expect(response.body.cargo.commercial[0].recognizedRevenueMinor).toBe('0');

    expect(
      await db(t.app).auditEvent.count({
        where: {
          action: 'OPS_PROFIT_TRIP_ACCESSED',
          resourceId: fixture.tripId,
        },
      }),
    ).toBe(1);
  });

  it('returns a nullable plan and explicit warning when the voyage has no budget', async () => {
    const fixture = await cargoTripFixture(t.app, manager);
    const response = await profit(reader, fixture.tripReference);
    expect(response.status, response.text).toBe(200);
    expect(response.body.plannedCost).toBeNull();
    expect(response.body.warnings).toContain('NO_TRIP_COST_PLAN');
    expect(response.body.fxConversionApplied).toBe(false);
  });
});
