import type { ApiEnv } from '@euroteranga/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isolatedDatabase, staffActor, type StaffActor } from '../../support/admin-helpers.js';
import { client, db, type TestRealm } from '../../support/auth-helpers.js';
import {
  bookableFixture,
  bookingApi,
  customerActor,
  holdBody,
  type CustomerActor,
} from '../../support/booking-helpers.js';
import { cargoCreateBody, staffCargoApi } from '../../support/cargo-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

const customerCargoBody = (overrides: Record<string, unknown> = {}) => ({
  direction: 'PAR_DKR',
  senderName: 'Expéditeur Client',
  senderContact: '+33111111111',
  recipientName: 'Destinataire Client',
  recipientContact: '+221771111111',
  weightKg: '42.125',
  volumeLiters: 350,
  packageCount: 2,
  declaredContents: 'Effets personnels de test',
  declaredValue: { amountMinor: '12500', currencyCode: 'EUR', currencyMinorUnit: 2 },
  fragile: true,
  professional: false,
  pickupRequired: true,
  deliveryRequired: false,
  ...overrides,
});

function customerCargoApi(actor: CustomerActor) {
  const api = bookingApi(actor);
  return {
    list: (query = '') => api.get(`/cargo${query}`),
    detail: (reference: string) => api.get(`/cargo/${reference}`),
    create: (body: unknown, options: { csrf?: string | null } = {}) =>
      api.post('/cargo', body, options),
    quotes: (reference: string) => api.get(`/cargo/${reference}/quotes`),
    acceptQuote: (
      reference: string,
      quoteReference: string,
      body: unknown = {},
      options: { csrf?: string | null } = {},
    ) => api.post(`/cargo/${reference}/quotes/${quoteReference}/accept`, body, options),
  };
}

describe('CLIENT-CARGO-1 authenticated customer cargo', () => {
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let t: TestApp;
  let env: ApiEnv;
  let manager: StaffActor;
  let customerA: CustomerActor;
  let customerB: CustomerActor;

  beforeAll(async () => {
    database = await isolatedDatabase();
    env = integrationEnv({ DATABASE_URL: database.url });
    t = await startTestApp(env);
    [manager, customerA, customerB] = await Promise.all([
      staffActor(t.app, ['OPS_MANAGER']),
      customerActor(t.app),
      customerActor(t.app),
    ]);
  }, 60_000);

  afterAll(async () => {
    await t.app.close();
    await database.drop();
  });

  it('requires a CUSTOMER session and CSRF for creation', async () => {
    const anonymous = client(t.app, 'customer' satisfies TestRealm);
    expect((await anonymous.get('/v1/booking/cargo')).status).toBe(401);

    const withoutCsrf = await customerA.http.post(
      '/v1/booking/cargo',
      customerCargoBody(),
      customerA.cookie,
    );
    expect(withoutCsrf.status).toBe(403);
  });

  it(
    'creates an owner-scoped request and exposes only its authenticated customer projection',
    async () => {
    const created = await customerCargoApi(customerA).create(customerCargoBody());
    expect(created.status, created.text).toBe(201);
    const reference = created.body.reference as string;
    expect(reference).toMatch(/^ETC-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/);
    expect(created.body).toMatchObject({
      reference,
      direction: 'PAR_DKR',
      status: 'PREPARING',
      sender: { name: 'Expéditeur Client', contact: '+33111111111' },
      recipient: { name: 'Destinataire Client', contact: '+221771111111' },
      weightKg: '42.125',
      volumeLiters: 350,
      packageCount: 2,
      declaredContents: 'Effets personnels de test',
      declaredValue: { amountMinor: '12500', currencyCode: 'EUR', currencyMinorUnit: 2 },
      latestQuote: null,
    });
    expect(created.body.timeline).toHaveLength(1);
    expect(created.body.timeline[0]).toMatchObject({ sequence: 1, status: 'PREPARING' });

    const json = JSON.stringify(created.body);
    for (const forbidden of [
      'customerIdentityId',
      'vehicleId',
      'payloadCapacityKg',
      'cargoVolumeLiters',
      'tokenHash',
      'trackingTokens',
      'createdBy',
      'issuedBy',
      'acceptedBy',
      'cancelledBy',
    ]) {
      expect(json).not.toContain(forbidden);
    }

    const stored = await db(t.app).roadFreightShipment.findUniqueOrThrow({
      where: { reference },
      select: { customerIdentityId: true, bookingId: true },
    });
    expect(stored).toEqual({ customerIdentityId: customerA.id, bookingId: null });

    await expect(
      db(t.app).roadFreightShipmentEvent.create({
        data: {
          shipmentId: (
            await db(t.app).roadFreightShipment.findUniqueOrThrow({
              where: { reference },
              select: { id: true },
            })
          ).id,
          sequence: 2,
          type: 'BOOKED',
          lifecycleStatus: 'BOOKED',
          occurredAt: new Date(),
          actorIdentityId: customerA.id,
          payloadFingerprint: '0'.repeat(64),
        },
      }),
    ).rejects.toThrow(/only active STAFF may record road freight events/);
    },
  );

  it('keeps foreign, unowned, unknown and malformed freight indistinguishable', async () => {
    const owned = await customerCargoApi(customerA).create(customerCargoBody({ packageCount: 3 }));
    expect(owned.status).toBe(201);
    const ownedReference = owned.body.reference as string;

    const foreign = await staffCargoApi(manager).create(
      cargoCreateBody({ customerIdentityId: customerB.id }),
    );
    expect(foreign.status, foreign.text).toBe(201);
    const foreignReference = foreign.body.reference as string;

    const unowned = await staffCargoApi(manager).create(cargoCreateBody());
    expect(unowned.status, unowned.text).toBe(201);
    const unownedReference = unowned.body.reference as string;

    const list = await customerCargoApi(customerA).list();
    expect(list.status, list.text).toBe(200);
    const references = (list.body.items as Array<{ reference: string }>).map(
      (item) => item.reference,
    );
    expect(references).toContain(ownedReference);
    expect(references).not.toContain(foreignReference);
    expect(references).not.toContain(unownedReference);

    for (const reference of [foreignReference, unownedReference, 'ETC-000000000000']) {
      const response = await customerCargoApi(customerA).detail(reference);
      expect(response.status).toBe(404);
      expect(response.body.code).toBe('CARGO_NOT_FOUND');
    }
    const malformed = await customerCargoApi(customerA).detail('not-a-cargo-reference');
    expect(malformed.status).toBe(404);
    expect(malformed.body.code).toBe('CARGO_NOT_FOUND');
  });

  it(
    'accepts an optional owned booking reference but rejects a foreign booking before Cargo creation',
    async () => {
    const fixture = await bookableFixture(t.app);
    const ownHold = await bookingApi(customerA).post('/bookings', holdBody(fixture, 1, 5, ['1A']));
    expect(ownHold.status, ownHold.text).toBe(201);
    const foreignHold = await bookingApi(customerB).post(
      '/bookings',
      holdBody(fixture, 1, 5, ['1B']),
    );
    expect(foreignHold.status, foreignHold.text).toBe(201);

    const rejected = await customerCargoApi(customerA).create(
      customerCargoBody({ bookingReference: foreignHold.body.reference }),
    );
    expect(rejected.status).toBe(404);
    expect(rejected.body.code).toBe('CARGO_BOOKING_NOT_FOUND');

    // The own booking is valid from an authorization standpoint. The generic
    // booking fixture is deliberately not a Paris/Dakar corridor, so CARGO-1
    // correctly rejects its direction instead of silently linking it.
    const own = await customerCargoApi(customerA).create(
      customerCargoBody({ bookingReference: ownHold.body.reference }),
    );
    expect(own.status).toBe(409);
    expect(own.body.code).toBe('CARGO_ASSIGNMENT_INVALID');
    },
  );

  it('hides DRAFT quotes and exposes issued commercial terms without STAFF metadata', async () => {
    const created = await customerCargoApi(customerA).create(customerCargoBody());
    const reference = created.body.reference as string;
    const draft = await staffCargoApi(manager).createQuote(reference, {
      currencyCode: 'EUR',
      currencyMinorUnit: 2,
      lines: [
        {
          kind: 'CHARGE',
          label: 'Transport fret',
          amountMinor: '17500',
          notes: 'PRIVATE-OPS-NOTE-MUST-NOT-LEAK',
        },
        { kind: 'DISCOUNT', label: 'Remise', amountMinor: '2500' },
      ],
    });
    expect(draft.status, draft.text).toBe(201);
    const quoteReference = draft.body.reference as string;

    const beforeIssue = await customerCargoApi(customerA).quotes(reference);
    expect(beforeIssue.status, beforeIssue.text).toBe(200);
    expect(beforeIssue.body.items).toEqual([]);

    const issued = await staffCargoApi(manager).issueQuote(reference, quoteReference);
    expect(issued.status, issued.text).toBe(200);

    const visible = await customerCargoApi(customerA).quotes(reference);
    expect(visible.status, visible.text).toBe(200);
    expect(visible.body.items).toHaveLength(1);
    expect(visible.body.items[0]).toMatchObject({
      reference: quoteReference,
      status: 'ISSUED',
      currencyCode: 'EUR',
      currencyMinorUnit: 2,
      totalMinor: '15000',
      lines: [
        { kind: 'CHARGE', label: 'Transport fret', amountMinor: '17500', position: 0 },
        { kind: 'DISCOUNT', label: 'Remise', amountMinor: '2500', position: 1 },
      ],
    });
    const json = JSON.stringify(visible.body);
    expect(json).not.toContain('PRIVATE-OPS-NOTE-MUST-NOT-LEAK');
    expect(json).not.toContain(manager.email);
    expect(json).not.toContain('createdBy');
    expect(json).not.toContain('issuedBy');
  });

  it(
    'allows only the owner to accept an ISSUED quote and creates no payment or Finance revenue',
    async () => {
    const created = await customerCargoApi(customerA).create(customerCargoBody());
    const reference = created.body.reference as string;
    const quote = await staffCargoApi(manager).createQuote(reference, {
      currencyCode: 'EUR',
      currencyMinorUnit: 2,
      lines: [{ kind: 'CHARGE', label: 'Transport', amountMinor: '19999' }],
    });
    expect(quote.status, quote.text).toBe(201);
    const quoteReference = quote.body.reference as string;
    expect((await staffCargoApi(manager).issueQuote(reference, quoteReference)).status).toBe(200);

    const [paymentBefore, paymentQuoteBefore, revenueBefore] = await Promise.all([
      db(t.app).payment.count(),
      db(t.app).paymentQuote.count(),
      db(t.app).tripRevenue.count(),
    ]);

    const visible = await customerCargoApi(customerA).quotes(reference);
    const expectedUpdatedAt = visible.body.items[0].updatedAt as string;

    const foreign = await customerCargoApi(customerB).acceptQuote(reference, quoteReference, {
      expectedUpdatedAt,
    });
    expect(foreign.status).toBe(404);
    expect(foreign.body.code).toBe('CARGO_NOT_FOUND');

    const noCsrf = await customerCargoApi(customerA).acceptQuote(
      reference,
      quoteReference,
      { expectedUpdatedAt },
      { csrf: null },
    );
    expect(noCsrf.status).toBe(403);

    await expect(
      db(t.app).roadFreightQuote.update({
        where: { reference: quoteReference },
        data: {
          status: 'ACCEPTED',
          acceptedByIdentityId: customerB.id,
          acceptedAt: new Date(),
        },
      }),
    ).rejects.toThrow(/acceptance actor and time required/);

    const accepted = await customerCargoApi(customerA).acceptQuote(reference, quoteReference, {
      expectedUpdatedAt,
    });
    expect(accepted.status, accepted.text).toBe(200);
    expect(accepted.body).toMatchObject({
      reference: quoteReference,
      status: 'ACCEPTED',
      totalMinor: '19999',
    });

    const replay = await customerCargoApi(customerA).acceptQuote(reference, quoteReference, {
      expectedUpdatedAt: accepted.body.updatedAt,
    });
    expect(replay.status).toBe(409);
    expect(replay.body.code).toBe('CARGO_QUOTE_INVALID_TRANSITION');

    const [paymentAfter, paymentQuoteAfter, revenueAfter] = await Promise.all([
      db(t.app).payment.count(),
      db(t.app).paymentQuote.count(),
      db(t.app).tripRevenue.count(),
    ]);
    expect([paymentAfter, paymentQuoteAfter, revenueAfter]).toEqual([
      paymentBefore,
      paymentQuoteBefore,
      revenueBefore,
    ]);
    },
  );

  it(
    'audits customer reads and acceptance without copying contacts or tracking capabilities',
    async () => {
    const created = await customerCargoApi(customerA).create(
      customerCargoBody({
        senderContact: 'CUSTOMER-SENSITIVE-SENDER',
        recipientContact: 'CUSTOMER-SENSITIVE-RECIPIENT',
      }),
    );
    const reference = created.body.reference as string;
    await customerCargoApi(customerA).list();
    await customerCargoApi(customerA).detail(reference);

    const shipment = await db(t.app).roadFreightShipment.findUniqueOrThrow({
      where: { reference },
      select: { id: true },
    });
    const audits = await db(t.app).auditEvent.findMany({
      where: {
        actorIdentityId: customerA.id,
        OR: [{ resourceId: shipment.id }, { action: 'ROAD_FREIGHT_ACCESSED' }],
      },
    });
    const json = JSON.stringify(audits);
    expect(json).toContain('ROAD_FREIGHT_CREATED');
    expect(json).toContain('ROAD_FREIGHT_ACCESSED');
    expect(json).not.toContain('CUSTOMER-SENSITIVE-SENDER');
    expect(json).not.toContain('CUSTOMER-SENSITIVE-RECIPIENT');
    expect(json).not.toContain('tokenHash');
    },
  );
});
