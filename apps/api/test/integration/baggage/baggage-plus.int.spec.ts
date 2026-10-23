import type { ApiEnv } from '@euroteranga/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isolatedDatabase, staffActor, type StaffActor } from '../../support/admin-helpers.js';
import { db } from '../../support/auth-helpers.js';
import {
  confirmedPassenger,
  customerBaggageApi,
  staffBaggageApi,
  staffBaggagePolicyApi,
} from '../../support/baggage-helpers.js';
import { customerActor, type CustomerActor } from '../../support/booking-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

describe('BAGGAGE-PLUS-1 versioned allowance and excess pricing', () => {
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let t: TestApp;
  let env: ApiEnv;
  let manager: StaffActor;
  let customer: CustomerActor;
  let subject: Awaited<ReturnType<typeof confirmedPassenger>>;
  let policyId: string;
  let versionOneId: string;
  let fareTableVersionId: string;
  let currencyCode: string;
  let currencyMinorUnit: number;

  beforeAll(async () => {
    database = await isolatedDatabase();
    env = integrationEnv({ DATABASE_URL: database.url });
    t = await startTestApp(env);
    [manager, customer] = await Promise.all([
      staffActor(t.app, ['OPS_MANAGER']),
      customerActor(t.app),
    ]);
    subject = await confirmedPassenger(t.app, env, customer);

    const booking = await db(t.app).booking.findUniqueOrThrow({
      where: { reference: subject.bookingReference },
      select: {
        fareEntry: {
          select: {
            fareTableVersionId: true,
            fareTableVersion: {
              select: {
                fareTable: {
                  select: { currencyCode: true, currencyMinorUnit: true },
                },
              },
            },
          },
        },
      },
    });
    fareTableVersionId = booking.fareEntry.fareTableVersionId;
    currencyCode = booking.fareEntry.fareTableVersion.fareTable.currencyCode;
    currencyMinorUnit = booking.fareEntry.fareTableVersion.fareTable.currencyMinorUnit;

    const created = await staffBaggagePolicyApi(manager).create({
      code: 'TEST_STANDARD',
      name: 'Standard synthétique',
      currencyCode,
      currencyMinorUnit,
      active: true,
    });
    if (created.status !== 201) {
      throw new Error(`policy fixture failed: ${created.status} ${created.text}`);
    }
    policyId = created.body.id as string;

    const version = await staffBaggagePolicyApi(manager).createVersion(policyId, {
      fareTableVersionId,
      includedPieces: 2,
      includedWeightKgPerPiece: '23.000',
    });
    if (version.status !== 201) {
      throw new Error(`policy version fixture failed: ${version.status} ${version.text}`);
    }
    versionOneId = version.body.versions.find(
      (candidate: { status: string }) => candidate.status === 'DRAFT',
    ).id as string;

    const tiers = await staffBaggagePolicyApi(manager).replaceTiers(policyId, versionOneId, {
      tiers: [
        {
          code: 'SYNTHETIC_23',
          label: 'Palier test 23',
          maxExcessWeightKg: '23.000',
          chargeMinor: '1111',
          position: 0,
        },
        {
          code: 'SYNTHETIC_32',
          label: 'Palier test 32',
          maxExcessWeightKg: '32.000',
          chargeMinor: '2222',
          position: 1,
        },
      ],
    });
    if (tiers.status !== 201) {
      throw new Error(`policy tiers fixture failed: ${tiers.status} ${tiers.text}`);
    }
    const published = await staffBaggagePolicyApi(manager).publish(policyId, versionOneId);
    if (published.status !== 201) {
      throw new Error(`policy publish fixture failed: ${published.status} ${published.text}`);
    }
  }, 90_000);

  afterAll(async () => {
    await t.app.close();
    await database.drop();
  });

  async function register(type: 'SUITCASE' | 'TRAVEL_BAG' | 'BOX' | 'OTHER' = 'SUITCASE') {
    const response = await customerBaggageApi(customer).register(
      subject.bookingReference,
      subject.passengerReference,
      { type },
    );
    expect(response.status, response.text).toBe(201);
    return response;
  }

  it('publishes an admin-managed policy without hard-coded commercial prices', async () => {
    const detail = await staffBaggagePolicyApi(manager).detail(policyId);
    expect(detail.status, detail.text).toBe(200);
    expect(detail.body).toMatchObject({
      code: 'TEST_STANDARD',
      currencyCode,
      currencyMinorUnit,
      versions: [
        {
          id: versionOneId,
          version: 1,
          status: 'PUBLISHED',
          includedPieces: 2,
          includedWeightKgPerPiece: '23.000',
          fareTableVersion: { id: fareTableVersionId },
          tiers: [
            {
              code: 'SYNTHETIC_23',
              maxExcessWeightKg: '23.000',
              chargeMinor: '1111',
            },
            {
              code: 'SYNTHETIC_32',
              maxExcessWeightKg: '32.000',
              chargeMinor: '2222',
            },
          ],
        },
      ],
    });

    const invalidMoney = await staffBaggagePolicyApi(manager).replaceTiers(
      policyId,
      versionOneId,
      {
        tiers: [
          {
            code: 'INVALID',
            label: 'Invalid',
            maxExcessWeightKg: '5.000',
            chargeMinor: 12.34,
            position: 0,
          },
        ],
      },
    );
    expect(invalidMoney.status).toBe(400);
  });

  it('snapshots piece order and derives included, priced and unpriced excess from STAFF weight', async () => {
    const [paymentBefore, quoteBefore, revenueBefore] = await Promise.all([
      db(t.app).payment.count(),
      db(t.app).paymentQuote.count(),
      db(t.app).tripRevenue.count(),
    ]);

    const first = await register('SUITCASE');
    const second = await register('TRAVEL_BAG');
    const third = await register('BOX');
    const fourth = await register('OTHER');

    expect(first.body.allowance).toMatchObject({
      status: 'PENDING_WEIGHT',
      pieceOrdinal: 1,
      policy: {
        code: 'TEST_STANDARD',
        version: 1,
        includedPieces: 2,
        includedWeightKgPerPiece: '23.000',
      },
      includedWeightKg: null,
      excessWeightKg: null,
      excessCharge: null,
    });
    expect(second.body.allowance.pieceOrdinal).toBe(2);
    expect(third.body.allowance.pieceOrdinal).toBe(3);
    expect(fourth.body.allowance.pieceOrdinal).toBe(4);

    const included = await staffBaggageApi(manager).weight(first.body.reference, {
      measuredWeightKg: '22.000',
    });
    expect(included.status, included.text).toBe(201);
    const includedView = await customerBaggageApi(customer).detail(first.body.reference);
    expect(includedView.body.allowance).toMatchObject({
      status: 'INCLUDED',
      pieceOrdinal: 1,
      includedWeightKg: '23.000',
      excessWeightKg: '0.000',
      excessCharge: {
        amountMinor: '0',
        currencyCode,
        currencyMinorUnit,
      },
    });

    const priced = await staffBaggageApi(manager).weight(second.body.reference, {
      measuredWeightKg: '30.000',
    });
    expect(priced.status, priced.text).toBe(201);
    const pricedView = await customerBaggageApi(customer).detail(second.body.reference);
    expect(pricedView.body.allowance).toMatchObject({
      status: 'EXCESS_PRICED',
      pieceOrdinal: 2,
      includedWeightKg: '23.000',
      excessWeightKg: '7.000',
      excessCharge: {
        amountMinor: '1111',
        currencyCode,
        currencyMinorUnit,
      },
    });

    const extra = await staffBaggageApi(manager).weight(third.body.reference, {
      measuredWeightKg: '20.000',
    });
    expect(extra.status, extra.text).toBe(201);
    const extraView = await customerBaggageApi(customer).detail(third.body.reference);
    expect(extraView.body.allowance).toMatchObject({
      status: 'EXCESS_PRICED',
      pieceOrdinal: 3,
      includedWeightKg: '0.000',
      excessWeightKg: '20.000',
      excessCharge: {
        amountMinor: '1111',
        currencyCode,
        currencyMinorUnit,
      },
    });

    const unpriced = await staffBaggageApi(manager).weight(fourth.body.reference, {
      measuredWeightKg: '40.000',
    });
    expect(unpriced.status, unpriced.text).toBe(201);
    const unpricedView = await customerBaggageApi(customer).detail(fourth.body.reference);
    expect(unpricedView.body.allowance).toMatchObject({
      status: 'EXCESS_UNPRICED',
      pieceOrdinal: 4,
      includedWeightKg: '0.000',
      excessWeightKg: '40.000',
      excessCharge: null,
    });

    const [paymentAfter, quoteAfter, revenueAfter] = await Promise.all([
      db(t.app).payment.count(),
      db(t.app).paymentQuote.count(),
      db(t.app).tripRevenue.count(),
    ]);
    expect([paymentAfter, quoteAfter, revenueAfter]).toEqual([
      paymentBefore,
      quoteBefore,
      revenueBefore,
    ]);

    await expect(
      db(t.app).baggage.update({
        where: { reference: second.body.reference },
        data: { excessChargeMinor: 999999n },
      }),
    ).rejects.toThrow(/commercial snapshots change only with an official weight/);
  });

  it('keeps old baggage on the retired policy and gives new baggage the replacement version', async () => {
    const historical = await register('SUITCASE');
    expect(historical.body.allowance.policy.version).toBe(1);

    const created = await staffBaggagePolicyApi(manager).createVersion(policyId, {
      fareTableVersionId,
      includedPieces: 1,
      includedWeightKgPerPiece: '20.000',
    });
    expect(created.status, created.text).toBe(201);
    const versionTwo = created.body.versions.find(
      (candidate: { status: string }) => candidate.status === 'DRAFT',
    );
    expect(versionTwo.version).toBe(2);

    expect(
      (
        await staffBaggagePolicyApi(manager).replaceTiers(policyId, versionTwo.id, {
          tiers: [
            {
              code: 'SYNTHETIC_V2',
              label: 'Palier version 2',
              maxExcessWeightKg: '50.000',
              chargeMinor: '3333',
              position: 0,
            },
          ],
        })
      ).status,
    ).toBe(201);
    expect((await staffBaggagePolicyApi(manager).publish(policyId, versionTwo.id)).status).toBe(201);

    const oldWeighted = await staffBaggageApi(manager).weight(historical.body.reference, {
      measuredWeightKg: '25.000',
    });
    expect(oldWeighted.status, oldWeighted.text).toBe(201);
    const oldView = await customerBaggageApi(customer).detail(historical.body.reference);
    expect(oldView.body.allowance.policy.version).toBe(1);
    expect(oldView.body.allowance.excessCharge.amountMinor).toBe('1111');

    const fresh = await register('BOX');
    expect(fresh.body.allowance.policy).toMatchObject({
      version: 2,
      includedPieces: 1,
      includedWeightKgPerPiece: '20.000',
    });

    const versions = await db(t.app).baggagePolicyVersion.findMany({
      where: { baggagePolicyId: policyId },
      orderBy: { version: 'asc' },
      select: { version: true, status: true },
    });
    expect(versions).toEqual([
      { version: 1, status: 'RETIRED' },
      { version: 2, status: 'PUBLISHED' },
    ]);
  });

  it('serializes concurrent registrations so allowance piece ordinals never collide', async () => {
    const before = await db(t.app).baggage.count({
      where: {
        bookingPassenger: {
          booking: { reference: subject.bookingReference },
          passenger: { reference: subject.passengerReference },
        },
      },
    });
    const [a, b] = await Promise.all([register('SUITCASE'), register('TRAVEL_BAG')]);
    const stored = await db(t.app).baggage.findMany({
      where: { reference: { in: [a.body.reference, b.body.reference] } },
      orderBy: { allowancePieceOrdinal: 'asc' },
      select: { allowancePieceOrdinal: true },
    });
    expect(stored).toEqual([
      { allowancePieceOrdinal: before + 1 },
      { allowancePieceOrdinal: before + 2 },
    ]);
  });

  it('keeps published tiers and version history immutable in PostgreSQL', async () => {
    const tier = await db(t.app).baggageExcessTier.findFirstOrThrow({
      where: { baggagePolicyVersionId: versionOneId },
      select: { id: true },
    });
    await expect(
      db(t.app).baggageExcessTier.update({
        where: { id: tier.id },
        data: { chargeMinor: 4444n },
      }),
    ).rejects.toThrow(/published baggage excess tiers are immutable/);

    await expect(
      db(t.app).baggagePolicyVersion.update({
        where: { id: versionOneId },
        data: { includedPieces: 9 },
      }),
    ).rejects.toThrow(/invalid baggage policy version transition/);
  });
});
