import type { ApiEnv } from '@euroteranga/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isolatedDatabase, staffActor, type StaffActor } from '../../support/admin-helpers.js';
import { db } from '../../support/auth-helpers.js';
import { cargoCreateBody, staffCargoApi } from '../../support/cargo-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

const quoteBody = (overrides: Record<string, unknown> = {}) => ({
  currencyCode: 'EUR',
  currencyMinorUnit: 2,
  lines: [
    { kind: 'CHARGE', label: 'Transport fret', amountMinor: '15000' },
    { kind: 'DISCOUNT', label: 'Remise commerciale', amountMinor: '2000' },
  ],
  ...overrides,
});

describe('CARGO-PRICE-1 versioned commercial freight quotes', () => {
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let t: TestApp;
  let env: ApiEnv;
  let manager: StaffActor;
  let dispatcher: StaffActor;
  let reader: StaffActor;
  let denied: StaffActor;

  beforeAll(async () => {
    database = await isolatedDatabase();
    env = integrationEnv({ DATABASE_URL: database.url });
    t = await startTestApp(env);
    [manager, dispatcher, reader, denied] = await Promise.all([
      staffActor(t.app, ['OPS_MANAGER']),
      staffActor(t.app, ['DISPATCHER']),
      staffActor(t.app, ['CUSTOMER_SUPPORT']),
      staffActor(t.app, ['FINANCE']),
    ]);
  }, 60_000);

  afterAll(async () => {
    await t.app.close();
    await database.drop();
  });

  async function cargo(overrides: Record<string, unknown> = {}) {
    const response = await staffCargoApi(manager).create(cargoCreateBody(overrides));
    expect(response.status, response.text).toBe(201);
    return response.body.reference as string;
  }

  it('installs quote tables, guards and partial one-current-version indexes', async () => {
    const tables = await db(t.app).$queryRaw<Array<{ name: string }>>`
      SELECT tablename AS name
      FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename IN ('road_freight_quote', 'road_freight_quote_line')
      ORDER BY tablename
    `;
    expect(tables.map((row) => row.name)).toEqual([
      'road_freight_quote',
      'road_freight_quote_line',
    ]);

    const triggers = await db(t.app).$queryRaw<Array<{ name: string }>>`
      SELECT tgname AS name
      FROM pg_trigger
      WHERE NOT tgisinternal
        AND tgrelid IN ('road_freight_quote'::regclass, 'road_freight_quote_line'::regclass)
    `;
    expect(triggers.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        'road_freight_quote_guard',
        'road_freight_quote_line_guard',
        'road_freight_quote_no_truncate',
        'road_freight_quote_line_no_truncate',
      ]),
    );

    const indexes = await db(t.app).$queryRaw<Array<{ name: string }>>`
      SELECT indexname AS name
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN (
          'road_freight_quote_one_draft_per_shipment',
          'road_freight_quote_one_issued_per_shipment'
        )
      ORDER BY indexname
    `;
    expect(indexes.map((row) => row.name)).toEqual([
      'road_freight_quote_one_draft_per_shipment',
      'road_freight_quote_one_issued_per_shipment',
    ]);
  });

  it('requires pricing.read to read and pricing.manage in addition to cargo.manage to mutate', async () => {
    const reference = await cargo();
    const created = await staffCargoApi(manager).createQuote(reference, quoteBody());
    expect(created.status, created.text).toBe(201);
    const quoteReference = created.body.reference as string;

    expect((await staffCargoApi(reader).quotes(reference)).status).toBe(200);
    expect((await staffCargoApi(reader).quote(reference, quoteReference)).status).toBe(200);
    expect((await staffCargoApi(dispatcher).quotes(reference)).status).toBe(200);

    const dispatcherMutation = await staffCargoApi(dispatcher).createQuote(reference, quoteBody());
    expect(dispatcherMutation.status).toBe(403);
    expect(dispatcherMutation.body.code).toBe('FORBIDDEN');

    expect((await staffCargoApi(denied).quotes(reference)).status).toBe(403);
    expect(
      (await staffCargoApi(manager).issueQuote(reference, quoteReference, {}, { csrf: null }))
        .status,
    ).toBe(403);
  });

  it('keeps exact totals, snapshots versions and supersedes the prior issued quote atomically', async () => {
    const reference = await cargo({ weightKg: '100.000', volumeLiters: 500 });
    const paymentBefore = await db(t.app).payment.count();
    const paymentQuoteBefore = await db(t.app).paymentQuote.count();
    const revenueBefore = await db(t.app).tripRevenue.count();

    const first = await staffCargoApi(manager).createQuote(reference, quoteBody());
    expect(first.status, first.text).toBe(201);
    expect(first.body).toMatchObject({
      version: 1,
      status: 'DRAFT',
      totalMinor: '13000',
      snapshot: { weightKg: '100.000', volumeLiters: 500 },
    });
    expect(first.body.reference).toMatch(/^ETCQ-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/);

    const duplicateDraft = await staffCargoApi(manager).createQuote(reference, quoteBody());
    expect(duplicateDraft.status).toBe(409);
    expect(duplicateDraft.body.code).toBe('CARGO_QUOTE_DRAFT_EXISTS');

    const issuedFirst = await staffCargoApi(manager).issueQuote(reference, first.body.reference, {
      expectedUpdatedAt: first.body.updatedAt,
    });
    expect(issuedFirst.status, issuedFirst.text).toBe(200);
    expect(issuedFirst.body.status).toBe('ISSUED');

    const cargoUpdated = await staffCargoApi(manager).update(reference, {
      weightKg: '120.000',
      expectedUpdatedAt: (await staffCargoApi(manager).detail(reference)).body.updatedAt,
    });
    expect(cargoUpdated.status, cargoUpdated.text).toBe(200);

    const second = await staffCargoApi(manager).createQuote(
      reference,
      quoteBody({
        lines: [{ kind: 'CHARGE', label: 'Transport révisé', amountMinor: '20000' }],
      }),
    );
    expect(second.status, second.text).toBe(201);
    expect(second.body).toMatchObject({
      version: 2,
      status: 'DRAFT',
      totalMinor: '20000',
      snapshot: { weightKg: '120.000' },
    });

    const issuedSecond = await staffCargoApi(manager).issueQuote(reference, second.body.reference, {
      expectedUpdatedAt: second.body.updatedAt,
    });
    expect(issuedSecond.status, issuedSecond.text).toBe(200);
    expect(issuedSecond.body.status).toBe('ISSUED');

    const firstAfter = await staffCargoApi(manager).quote(reference, first.body.reference);
    expect(firstAfter.body.status).toBe('SUPERSEDED');
    expect(firstAfter.body.snapshot.weightKg).toBe('100.000');

    const accepted = await staffCargoApi(manager).acceptQuote(reference, second.body.reference, {
      expectedUpdatedAt: issuedSecond.body.updatedAt,
    });
    expect(accepted.status, accepted.text).toBe(200);
    expect(accepted.body.status).toBe('ACCEPTED');

    const third = await staffCargoApi(manager).createQuote(reference, quoteBody());
    expect(third.status, third.text).toBe(201);
    const blocked = await staffCargoApi(manager).issueQuote(reference, third.body.reference, {
      expectedUpdatedAt: third.body.updatedAt,
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('CARGO_QUOTE_ACCEPTED_BLOCKS_ISSUE');

    expect(await db(t.app).payment.count()).toBe(paymentBefore);
    expect(await db(t.app).paymentQuote.count()).toBe(paymentQuoteBefore);
    expect(await db(t.app).tripRevenue.count()).toBe(revenueBefore);
  });

  it('serializes concurrent draft creation and assigns one version only', async () => {
    const reference = await cargo();
    const results = await Promise.all([
      staffCargoApi(manager).createQuote(reference, quoteBody()),
      staffCargoApi(manager).createQuote(
        reference,
        quoteBody({
          lines: [{ kind: 'CHARGE', label: 'Concurrent', amountMinor: '17000' }],
        }),
      ),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(results.find((response) => response.status === 409)?.body.code).toBe(
      'CARGO_QUOTE_DRAFT_EXISTS',
    );

    const shipment = await db(t.app).roadFreightShipment.findUniqueOrThrow({
      where: { reference },
      select: { id: true },
    });
    const stored = await db(t.app).roadFreightQuote.findMany({
      where: { shipmentId: shipment.id },
      orderBy: { version: 'asc' },
    });
    expect(stored.map((quote) => quote.version)).toEqual([1]);
  });

  it('enforces frozen quote history and total rules for direct database writes', async () => {
    const reference = await cargo();
    const created = await staffCargoApi(manager).createQuote(reference, quoteBody());
    const quoteReference = created.body.reference as string;
    const shipment = await db(t.app).roadFreightShipment.findUniqueOrThrow({
      where: { reference },
      select: { id: true },
    });
    const quote = await db(t.app).roadFreightQuote.findUniqueOrThrow({
      where: { reference: quoteReference },
    });

    await expect(
      db(t.app).roadFreightQuote.update({
        where: { id: quote.id },
        data: { snapshotWeightKg: '999.000' },
      }),
    ).rejects.toThrow(/identity or snapshot is immutable/);

    await db(t.app).roadFreightQuoteLine.deleteMany({ where: { quoteId: quote.id } });
    await db(t.app).roadFreightQuoteLine.create({
      data: {
        quoteId: quote.id,
        kind: 'DISCOUNT',
        label: 'Remise impossible',
        amountMinor: 100n,
        position: 0,
      },
    });
    await expect(
      db(t.app).roadFreightQuote.update({
        where: { id: quote.id },
        data: {
          status: 'ISSUED',
          issuedByIdentityId: manager.id,
          issuedAt: new Date(),
        },
      }),
    ).rejects.toThrow(/total cannot be negative/);

    await db(t.app).roadFreightQuoteLine.deleteMany({ where: { quoteId: quote.id } });
    await db(t.app).roadFreightQuoteLine.create({
      data: {
        quoteId: quote.id,
        kind: 'CHARGE',
        label: 'Transport',
        amountMinor: 100n,
        position: 0,
      },
    });
    const issued = await staffCargoApi(manager).issueQuote(reference, quoteReference);
    expect(issued.status, issued.text).toBe(200);

    await expect(
      db(t.app).roadFreightQuoteLine.create({
        data: {
          quoteId: quote.id,
          kind: 'CHARGE',
          label: 'Mutation interdite',
          amountMinor: 1n,
          position: 1,
        },
      }),
    ).rejects.toThrow(/quote lines are frozen/);
    await expect(db(t.app).roadFreightQuote.delete({ where: { id: quote.id } })).rejects.toThrow(
      /quotes cannot be deleted/,
    );
    await expect(db(t.app).$executeRawUnsafe('TRUNCATE road_freight_quote_line')).rejects.toThrow(
      /quote history cannot be truncated/,
    );

    expect(await db(t.app).roadFreightQuote.count({ where: { shipmentId: shipment.id } })).toBe(1);
  });

  it('rolls the quote transition back if the audit write fails', async () => {
    const reference = await cargo();
    const created = await staffCargoApi(manager).createQuote(reference, quoteBody());
    const quoteReference = created.body.reference as string;

    await db(t.app).$executeRawUnsafe(`
      CREATE FUNCTION test_fail_cargo_quote_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'ROAD_FREIGHT_QUOTE_ISSUED' THEN
          RAISE EXCEPTION 'simulated cargo quote audit failure';
        END IF;
        RETURN NEW;
      END; $$
    `);
    await db(t.app).$executeRawUnsafe(
      'CREATE TRIGGER test_fail_cargo_quote_audit BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION test_fail_cargo_quote_audit()',
    );

    try {
      const failed = await staffCargoApi(manager).issueQuote(reference, quoteReference);
      expect(failed.status).toBe(500);
      expect(
        (
          await db(t.app).roadFreightQuote.findUniqueOrThrow({
            where: { reference: quoteReference },
          })
        ).status,
      ).toBe('DRAFT');
    } finally {
      await db(t.app).$executeRawUnsafe('DROP TRIGGER test_fail_cargo_quote_audit ON audit_event');
      await db(t.app).$executeRawUnsafe('DROP FUNCTION test_fail_cargo_quote_audit()');
    }

    expect((await staffCargoApi(manager).issueQuote(reference, quoteReference)).status).toBe(200);
  });
});
