import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminApi,
  isolatedDatabase,
  staffActor,
  type StaffActor,
} from '../../support/admin-helpers.js';
import { db } from '../../support/auth-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

const UNKNOWN_ID = '01900000-0000-7000-8000-000000000000';

const lines = [
  {
    category: 'FUEL',
    label: 'Carburant prévisionnel',
    amountMinor: '420000',
    notes: 'Paris à Dakar',
    position: 0,
  },
  {
    category: 'STOP_COST',
    label: 'Coûts des arrêts',
    amountMinor: '180000',
    position: 1,
  },
  {
    category: 'SUPPORT_VEHICLE',
    label: "Véhicule d'assistance",
    amountMinor: '95000',
    position: 2,
  },
] as const;

/** Internal operational costs through the real HTTP and PostgreSQL boundaries. */
describe('trip operational costs (isolated database)', () => {
  let t: TestApp;
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let manager: StaffActor;
  let reader: StaffActor;
  let denied: StaffActor;
  let tripId: string;

  beforeAll(async () => {
    database = await isolatedDatabase();
    t = await startTestApp(integrationEnv({ DATABASE_URL: database.url }));
    [manager, reader, denied] = await Promise.all([
      staffActor(t.app, ['SUPER_ADMIN']),
      staffActor(t.app, ['BOOKING_AGENT']),
      staffActor(t.app, ['FINANCE']),
    ]);

    const suffix = randomBytes(4).toString('hex').toUpperCase();
    const country = await db(t.app).country.create({
      data: { iso2: 'QC', iso3: 'QCC', name: 'Pays coûts' },
    });
    const [origin, destination] = await Promise.all([
      db(t.app).stop.create({
        data: {
          code: `COST_A_${suffix}`,
          name: 'Origine coûts',
          countryId: country.id,
          locality: 'Origine',
          latitude: 10,
          longitude: 10,
          timezone: 'Etc/UTC',
        },
      }),
      db(t.app).stop.create({
        data: {
          code: `COST_B_${suffix}`,
          name: 'Destination coûts',
          countryId: country.id,
          locality: 'Destination',
          latitude: 11,
          longitude: 11,
          timezone: 'Etc/UTC',
        },
      }),
    ]);
    const route = await db(t.app).route.create({
      data: { code: `COST_${suffix}`, name: 'Route coûts' },
    });
    const version = await db(t.app).routeVersion.create({
      data: { routeId: route.id, version: 1 },
    });
    await db(t.app).routeWaypoint.createMany({
      data: [
        { routeVersionId: version.id, sequence: 1, stopId: origin.id, boardingAllowed: true },
        {
          routeVersionId: version.id,
          sequence: 2,
          stopId: destination.id,
          alightingAllowed: true,
        },
      ],
    });
    await db(t.app).routeVersion.update({
      where: { id: version.id },
      data: { status: 'PUBLISHED', publishedAt: new Date() },
    });
    tripId = (
      await db(t.app).trip.create({
        data: { reference: `ET-COST-${suffix}`, routeVersionId: version.id },
      })
    ).id;
  });

  afterAll(async () => {
    await t.app.close();
    await database.drop();
  });

  const body = (
    status: 'DRAFT' | 'ESTIMATED' | 'LOCKED' = 'ESTIMATED',
    items: ReadonlyArray<Record<string, unknown>> = lines,
  ) => ({ status, currencyCode: 'EUR', items });

  const audits = () =>
    db(t.app).auditEvent.count({ where: { action: 'TRIP_COST_UPDATED', resourceId: tripId } });

  it('returns an empty EUR draft and enforces trip.read/trip.manage plus CSRF', async () => {
    const empty = await adminApi(reader).get(`/trips/${tripId}/costs`);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({
      id: null,
      tripId,
      status: 'DRAFT',
      currencyCode: 'EUR',
      currencyMinorUnit: 2,
      totalCostMinor: '0',
      createdAt: null,
      updatedAt: null,
      items: [],
    });
    expect((await adminApi(reader).get(`/trips/${UNKNOWN_ID}/costs`)).status).toBe(404);
    expect((await adminApi(manager).post(`/trips/${UNKNOWN_ID}/costs`, body())).status).toBe(404);

    const forbiddenRead = await adminApi(denied).get(`/trips/${tripId}/costs`);
    expect(forbiddenRead.status).toBe(403);
    expect(forbiddenRead.body.code).toBe('FORBIDDEN');
    const forbiddenWrite = await adminApi(reader).post(`/trips/${tripId}/costs`, body());
    expect(forbiddenWrite.status).toBe(403);
    expect(forbiddenWrite.body.code).toBe('FORBIDDEN');
    expect(
      (await adminApi(manager).post(`/trips/${tripId}/costs`, body(), { csrf: null })).status,
    ).toBe(403);
    expect(await db(t.app).tripCostPlan.count()).toBe(0);
  });

  it('replaces ordered lines atomically, derives the total and audits meaningful changes', async () => {
    const response = await adminApi(manager).post(`/trips/${tripId}/costs`, body());
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      tripId,
      status: 'ESTIMATED',
      currencyCode: 'EUR',
      currencyMinorUnit: 2,
      totalCostMinor: '695000',
      items: [
        { category: 'FUEL', amountMinor: '420000', position: 0 },
        { category: 'STOP_COST', amountMinor: '180000', position: 1 },
        { category: 'SUPPORT_VEHICLE', amountMinor: '95000', position: 2 },
      ],
    });
    expect(response.body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await audits()).toBe(1);
    const event = await db(t.app).auditEvent.findFirstOrThrow({
      where: { action: 'TRIP_COST_UPDATED', resourceId: tripId },
    });
    expect(event.actorIdentityId).toBe(manager.id);
    expect(event.metadata).toMatchObject({
      previousTotalCostMinor: '0',
      totalCostMinor: '695000',
      currencyCode: 'EUR',
      status: 'ESTIMATED',
    });

    const noOp = await adminApi(manager).post(`/trips/${tripId}/costs`, body());
    expect(noOp.status).toBe(200);
    expect(noOp.body.updatedAt).toBe(response.body.updatedAt);
    expect(await audits()).toBe(1);

    const replacement = [
      { ...lines[2], amountMinor: '105000', position: 0 },
      { ...lines[0], amountMinor: '430000', position: 1 },
    ];
    const changed = await adminApi(manager).post(
      `/trips/${tripId}/costs`,
      body('ESTIMATED', replacement),
    );
    expect(changed.status).toBe(200);
    expect(changed.body.totalCostMinor).toBe('535000');
    expect(changed.body.items.map((item: { category: string }) => item.category)).toEqual([
      'SUPPORT_VEHICLE',
      'FUEL',
    ]);
    expect(await audits()).toBe(2);
  });

  it('rejects malformed amounts, currencies, categories, totals and positions before writing', async () => {
    const baseline = await adminApi(manager).get(`/trips/${tripId}/costs`);
    const badBodies = [
      { ...body(), totalCostMinor: '1' },
      { ...body(), currencyCode: 'USD' },
      body('DRAFT', [{ ...lines[0], category: 'REVENUE' }]),
      body('DRAFT', [{ ...lines[0], amountMinor: '-1' }]),
      body('DRAFT', [{ ...lines[0], amountMinor: '12.50' }]),
      body('DRAFT', [{ ...lines[0], amountMinor: '10000000000000000' }]),
      body('DRAFT', [lines[0], { ...lines[1], position: 0 }]),
      body('DRAFT', [{ ...lines[0], position: 1 }]),
    ];
    for (const invalid of badBodies) {
      const response = await adminApi(manager).post(`/trips/${tripId}/costs`, invalid);
      expect(response.status, JSON.stringify(invalid)).toBe(400);
    }
    expect((await adminApi(manager).get(`/trips/${tripId}/costs`)).body).toEqual(baseline.body);
    expect(await audits()).toBe(2);
  });

  it('rolls the replacement back when its audit event cannot be written', async () => {
    await db(t.app).$executeRawUnsafe(`
      CREATE FUNCTION reject_trip_cost_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'TRIP_COST_UPDATED' THEN RAISE EXCEPTION 'audit unavailable'; END IF;
        RETURN NEW;
      END;
      $$;
    `);
    await db(t.app).$executeRawUnsafe(`
      CREATE TRIGGER reject_trip_cost_audit BEFORE INSERT ON audit_event
      FOR EACH ROW EXECUTE FUNCTION reject_trip_cost_audit()
    `);
    try {
      const failed = await adminApi(manager).post(
        `/trips/${tripId}/costs`,
        body('DRAFT', [{ ...lines[0], amountMinor: '1', position: 0 }]),
      );
      expect(failed.status).toBe(500);
    } finally {
      await db(t.app).$executeRawUnsafe('DROP TRIGGER reject_trip_cost_audit ON audit_event');
      await db(t.app).$executeRawUnsafe('DROP FUNCTION reject_trip_cost_audit()');
    }
    const current = await adminApi(manager).get(`/trips/${tripId}/costs`);
    expect(current.body.totalCostMinor).toBe('535000');
    expect(current.body.items).toHaveLength(2);
    expect(await audits()).toBe(2);
  });

  it('keeps an exact no-op idempotent but rejects cost changes after trip cancellation', async () => {
    const sourceTrip = await db(t.app).trip.findUniqueOrThrow({
      where: { id: tripId },
      select: { routeVersionId: true },
    });
    const suffix = randomBytes(4).toString('hex').toUpperCase();
    const cancelledTrip = await db(t.app).trip.create({
      data: {
        reference: `ET-COST-CANCEL-${suffix}`,
        routeVersionId: sourceTrip.routeVersionId,
      },
    });
    const initialBody = body('ESTIMATED', [{ ...lines[0], position: 0 }]);
    const initial = await adminApi(manager).post(`/trips/${cancelledTrip.id}/costs`, initialBody);
    expect(initial.status).toBe(200);

    const cancelled = await adminApi(manager).post(`/trips/${cancelledTrip.id}/cancel`, {
      reason: 'Annulation synthétique des coûts',
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('CANCELLED');

    const auditCount = () =>
      db(t.app).auditEvent.count({
        where: { action: 'TRIP_COST_UPDATED', resourceId: cancelledTrip.id },
      });
    expect(await auditCount()).toBe(1);

    const exactNoOp = await adminApi(manager).post(`/trips/${cancelledTrip.id}/costs`, initialBody);
    expect(exactNoOp.status).toBe(200);
    expect(exactNoOp.body.updatedAt).toBe(initial.body.updatedAt);
    expect(await auditCount()).toBe(1);

    const changed = await adminApi(manager).post(
      `/trips/${cancelledTrip.id}/costs`,
      body('ESTIMATED', [{ ...lines[0], amountMinor: '420001', position: 0 }]),
    );
    expect(changed.status).toBe(409);
    expect(changed.body.code).toBe('TRIP_CANCELLED');
    expect(await auditCount()).toBe(1);

    const persisted = await adminApi(manager).get(`/trips/${cancelledTrip.id}/costs`);
    expect(persisted.status).toBe(200);
    expect(persisted.body.totalCostMinor).toBe('420000');
  });

  it('enforces database ranges and makes LOCKED a terminal immutable snapshot', async () => {
    const plan = await db(t.app).tripCostPlan.findUniqueOrThrow({ where: { tripId } });
    await expect(
      db(t.app).tripCostPlan.create({
        data: { tripId: UNKNOWN_ID, status: 'DRAFT', currencyCode: 'EUR' },
      }),
    ).rejects.toThrow();
    await expect(
      db(t.app).$executeRawUnsafe(
        `INSERT INTO trip_cost_item (id, plan_id, category, label, amount_minor, position)
         VALUES (gen_random_uuid(), '${plan.id}', 'NOT_A_COST', 'Catégorie invalide', 1, 2)`,
      ),
    ).rejects.toThrow(/invalid input value for enum trip_cost_category/);
    await expect(
      db(t.app).$executeRawUnsafe(
        `UPDATE trip_cost_plan SET status = 'NOT_A_STATUS' WHERE id = '${plan.id}'`,
      ),
    ).rejects.toThrow(/invalid input value for enum trip_cost_status/);
    await expect(
      db(t.app).tripCostPlan.update({
        where: { id: plan.id },
        data: { currencyCode: 'USD' },
      }),
    ).rejects.toThrow(/trip_cost_plan_currency_shape/);
    await expect(
      db(t.app).tripCostItem.create({
        data: {
          planId: plan.id,
          category: 'OTHER',
          label: 'Montant invalide',
          amountMinor: -1n,
          position: 2,
        },
      }),
    ).rejects.toThrow(/trip_cost_item_amount_range/);
    await expect(
      db(t.app).tripCostItem.create({
        data: {
          planId: plan.id,
          category: 'OTHER',
          label: ' Libellé non normalisé ',
          amountMinor: 1n,
          position: 2,
        },
      }),
    ).rejects.toThrow(/trip_cost_item_label_shape/);
    await expect(
      db(t.app).tripCostItem.create({
        data: {
          planId: plan.id,
          category: 'OTHER',
          label: 'Position dupliquée',
          amountMinor: 1n,
          position: 0,
        },
      }),
    ).rejects.toThrow();

    const beforeLockAudits = await audits();
    const current = await adminApi(manager).get(`/trips/${tripId}/costs`);
    const locked = await adminApi(manager).post(`/trips/${tripId}/costs`, {
      status: 'LOCKED',
      currencyCode: 'EUR',
      items: current.body.items.map(
        ({ category, label, amountMinor, notes, position }: Record<string, unknown>) => ({
          category,
          label,
          amountMinor,
          ...(notes ? { notes } : {}),
          position,
        }),
      ),
    });
    expect(locked.status).toBe(200);
    expect(locked.body.status).toBe('LOCKED');
    expect(await audits()).toBe(beforeLockAudits + 1);

    const exactNoOp = await adminApi(manager).post(`/trips/${tripId}/costs`, {
      status: 'LOCKED',
      currencyCode: 'EUR',
      items: locked.body.items.map(
        ({ category, label, amountMinor, notes, position }: Record<string, unknown>) => ({
          category,
          label,
          amountMinor,
          ...(notes ? { notes } : {}),
          position,
        }),
      ),
    });
    expect(exactNoOp.status).toBe(200);
    expect(exactNoOp.body.updatedAt).toBe(locked.body.updatedAt);
    expect(await audits()).toBe(beforeLockAudits + 1);

    const changed = await adminApi(manager).post(
      `/trips/${tripId}/costs`,
      body('LOCKED', [{ ...lines[0], amountMinor: '2', position: 0 }]),
    );
    expect(changed.status).toBe(409);
    expect(changed.body.code).toBe('TRIP_COST_LOCKED');
    const item = await db(t.app).tripCostItem.findFirstOrThrow({ where: { planId: plan.id } });
    await expect(
      db(t.app).tripCostItem.update({ where: { id: item.id }, data: { amountMinor: 2n } }),
    ).rejects.toThrow(/locked trip cost plan items are immutable/);
    await expect(db(t.app).tripCostItem.delete({ where: { id: item.id } })).rejects.toThrow(
      /locked trip cost plan items are immutable/,
    );
    await expect(
      db(t.app).tripCostPlan.update({ where: { id: plan.id }, data: { status: 'ESTIMATED' } }),
    ).rejects.toThrow(/locked trip cost plan is immutable/);
    await expect(db(t.app).tripCostPlan.delete({ where: { id: plan.id } })).rejects.toThrow(
      /trip cost plans cannot be deleted/,
    );
  });
});
