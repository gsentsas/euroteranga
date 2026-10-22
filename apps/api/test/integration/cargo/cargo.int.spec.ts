import type { ApiEnv } from '@euroteranga/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminApi,
  isolatedDatabase,
  operatorVehicle,
  staffActor,
  type StaffActor,
} from '../../support/admin-helpers.js';
import { createIdentity, db } from '../../support/auth-helpers.js';
import { cargoCreateBody, cargoTripFixture, staffCargoApi } from '../../support/cargo-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

describe('CARGO-1 road freight, RBAC, capacity and history', () => {
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let t: TestApp;
  let env: ApiEnv;
  let manager: StaffActor;
  let reader: StaffActor;
  let denied: StaffActor;
  let fixture: Awaited<ReturnType<typeof cargoTripFixture>>;

  beforeAll(async () => {
    database = await isolatedDatabase();
    env = integrationEnv({ DATABASE_URL: database.url });
    t = await startTestApp(env);
    [manager, reader, denied] = await Promise.all([
      staffActor(t.app, ['OPS_MANAGER']),
      staffActor(t.app, ['CUSTOMER_SUPPORT']),
      staffActor(t.app, ['FINANCE']),
    ]);
    fixture = await cargoTripFixture(t.app, manager);
  }, 60_000);

  afterAll(async () => {
    await t.app.close();
    await database.drop();
  });

  it('installs the additive schema, guards and least-privilege permissions', async () => {
    const tables = await db(t.app).$queryRaw<Array<{ name: string }>>`
      SELECT tablename AS name FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename IN ('road_freight_shipment', 'road_freight_shipment_event')
      ORDER BY tablename`;
    expect(tables.map((row) => row.name)).toEqual([
      'road_freight_shipment',
      'road_freight_shipment_event',
    ]);

    const triggers = await db(t.app).$queryRaw<Array<{ name: string }>>`
      SELECT tgname AS name FROM pg_trigger
      WHERE NOT tgisinternal
        AND tgrelid IN (
          'road_freight_shipment'::regclass,
          'road_freight_shipment_event'::regclass,
          'vehicle'::regclass
        )`;
    expect(triggers.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        'road_freight_shipment_guard',
        'road_freight_assignment_guard',
        'road_freight_event_guard',
        'road_freight_shipment_projection_guard',
        'road_freight_event_projection_guard',
        'road_freight_vehicle_capacity_guard',
      ]),
    );

    const grants = await db(t.app).authorizationPermission.findMany({
      where: { key: { startsWith: 'cargo.' } },
      include: { roles: true },
      orderBy: { key: 'asc' },
    });
    expect(grants.map((permission) => permission.key)).toEqual(['cargo.manage', 'cargo.read']);
    expect(
      grants
        .find((permission) => permission.key === 'cargo.manage')
        ?.roles.map((role) => role.roleKey),
    ).not.toContain('CUSTOMER_SUPPORT');
  });

  it('separates cargo.read from cargo.manage and requires CSRF', async () => {
    const created = await staffCargoApi(manager).create(cargoCreateBody());
    expect(created.status, created.text).toBe(201);
    const reference = created.body.reference as string;
    expect(reference).toMatch(/^ETC-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/);

    expect((await staffCargoApi(reader).detail(reference)).status).toBe(200);
    expect((await staffCargoApi(reader).list(`?reference=${reference}`)).status).toBe(200);
    expect((await staffCargoApi(reader).event(reference, { type: 'BOOKED' })).status).toBe(403);
    expect((await staffCargoApi(denied).detail(reference)).status).toBe(403);
    expect(
      (await staffCargoApi(manager).event(reference, { type: 'BOOKED' }, { csrf: null })).status,
    ).toBe(403);
  });

  it('links an existing CUSTOMER directly and rejects a STAFF identity as customer', async () => {
    const customer = await createIdentity(t.app, { realm: 'customer' });
    const linked = await staffCargoApi(manager).create(
      cargoCreateBody({ customerIdentityId: customer.id }),
    );
    expect(linked.status, linked.text).toBe(201);
    expect(linked.body.customer).toEqual({ id: customer.id, email: customer.email });

    const invalid = await staffCargoApi(manager).create(
      cargoCreateBody({ customerIdentityId: manager.id }),
    );
    expect(invalid.status).toBe(404);
    expect(invalid.body.code).toBe('CARGO_CUSTOMER_NOT_FOUND');

    await expect(
      db(t.app).roadFreightShipment.create({
        data: {
          reference: 'ETC-ZZZZZZZZZZZZ',
          direction: 'PAR_DKR',
          customerIdentityId: manager.id,
          senderName: 'SQL sender',
          senderContact: 'sql-sender',
          recipientName: 'SQL recipient',
          recipientContact: 'sql-recipient',
          weightKg: '1.000',
          volumeLiters: 1,
          packageCount: 1,
          declaredContents: 'SQL guard probe',
        },
      }),
    ).rejects.toThrow(/customer identity must be CUSTOMER/);
  });

  it('progresses, assigns to the convoy and refuses kg/L oversubscription', async () => {
    const first = await staffCargoApi(manager).create(
      cargoCreateBody({ weightKg: '700.000', volumeLiters: 1500 }),
    );
    expect(first.status, first.text).toBe(201);
    const firstReference = first.body.reference as string;
    for (const type of ['BOOKED', 'RECEIVED', 'INSPECTED']) {
      const response = await staffCargoApi(manager).event(firstReference, { type });
      expect(response.status, `${type}: ${response.text}`).toBe(201);
    }
    const assigned = await staffCargoApi(manager).assign(firstReference, {
      tripReference: fixture.tripReference,
      vehicleCode: fixture.vehicleCode,
      expectedTripReference: null,
      expectedVehicleCode: null,
    });
    expect(assigned.status, assigned.text).toBe(200);
    expect(assigned.body).toMatchObject({
      lifecycleStatus: 'ASSIGNED',
      trip: { reference: fixture.tripReference },
      vehicle: { code: fixture.vehicleCode },
    });

    const replacementVehicleId = await operatorVehicle(
      manager,
      {
        code: `CG_ALT_${firstReference.slice(-8)}`,
        name: `Cargo replacement ${firstReference.slice(-8)}`,
        manufacturer: 'Test',
        model: 'Cargo',
        role: 'MIXED',
        payloadCapacityKg: 1000,
        cargoVolumeLiters: 2000,
      },
      ['ACTIVE'],
    );
    const convoyChange = await adminApi(manager).post(`/trips/${fixture.tripId}/vehicle`, {
      vehicleId: replacementVehicleId,
      expectedVehicleId: fixture.vehicleId,
      reason: 'Test CARGO-1 : fret encore affecté',
    });
    expect(convoyChange.status).toBe(409);
    expect(convoyChange.body.code).toBe('TRIP_CARGO_ASSIGNMENT_CONFLICT');
    await expect(
      db(t.app).trip.update({
        where: { id: fixture.tripId },
        data: { vehicleId: replacementVehicleId },
      }),
    ).rejects.toThrow(/active road freight would be orphaned/);

    const reduceKg = await adminApi(manager).post(`/fleet/vehicles/${fixture.vehicleId}`, {
      payloadCapacityKg: 600,
      cargoVolumeLiters: 1600,
    });
    expect(reduceKg.status).toBe(409);
    expect(reduceKg.body.code).toBe('VEHICLE_CARGO_ASSIGNMENT_CONFLICT');

    const reduceVolume = await adminApi(manager).post(`/fleet/vehicles/${fixture.vehicleId}`, {
      payloadCapacityKg: 800,
      cargoVolumeLiters: 1400,
    });
    expect(reduceVolume.status).toBe(409);
    expect(reduceVolume.body.code).toBe('VEHICLE_CARGO_ASSIGNMENT_CONFLICT');

    const removeCapacity = await adminApi(manager).post(`/fleet/vehicles/${fixture.vehicleId}`, {
      payloadCapacityKg: null,
      cargoVolumeLiters: null,
    });
    expect(removeCapacity.status).toBe(409);
    expect(removeCapacity.body.code).toBe('VEHICLE_CARGO_ASSIGNMENT_CONFLICT');

    const disableVehicle = await adminApi(manager).post(
      `/fleet/vehicles/${fixture.vehicleId}/status`,
      { status: 'OUT_OF_SERVICE', reason: 'Test fret actif' },
    );
    expect(disableVehicle.status).toBe(409);
    expect(disableVehicle.body.code).toBe('VEHICLE_CARGO_ASSIGNMENT_CONFLICT');

    const validReduction = await adminApi(manager).post(`/fleet/vehicles/${fixture.vehicleId}`, {
      payloadCapacityKg: 800,
      cargoVolumeLiters: 1600,
    });
    expect(validReduction.status, validReduction.text).toBe(200);

    await expect(
      db(t.app).vehicle.update({
        where: { id: fixture.vehicleId },
        data: { payloadCapacityKg: 600, cargoVolumeLiters: 1600 },
      }),
    ).rejects.toThrow(/active road freight conflicts with vehicle capacity or status/);

    const second = await staffCargoApi(manager).create(
      cargoCreateBody({ weightKg: '400.000', volumeLiters: 600 }),
    );
    const secondReference = second.body.reference as string;
    for (const type of ['BOOKED', 'RECEIVED', 'INSPECTED']) {
      expect((await staffCargoApi(manager).event(secondReference, { type })).status).toBe(201);
    }
    const overflow = await staffCargoApi(manager).assign(secondReference, {
      tripReference: fixture.tripReference,
      vehicleCode: fixture.vehicleCode,
    });
    expect(overflow.status).toBe(409);
    expect(overflow.body.code).toBe('CARGO_CAPACITY_EXCEEDED');

    const stored = await db(t.app).roadFreightShipment.findUniqueOrThrow({
      where: { reference: secondReference },
    });
    expect(stored.lifecycleStatus).toBe('INSPECTED');
    expect(stored.tripId).toBeNull();
    expect(stored.vehicleId).toBeNull();
  });

  it('continues the cargo lifecycle after the assigned trip starts', async () => {
    const running = await cargoTripFixture(t.app, manager);
    const created = await staffCargoApi(manager).create(
      cargoCreateBody({ weightKg: '100.000', volumeLiters: 100 }),
    );
    const reference = created.body.reference as string;
    for (const type of ['BOOKED', 'RECEIVED', 'INSPECTED']) {
      expect((await staffCargoApi(manager).event(reference, { type })).status).toBe(201);
    }
    expect(
      (
        await staffCargoApi(manager).assign(reference, {
          tripReference: running.tripReference,
          vehicleCode: running.vehicleCode,
        })
      ).status,
    ).toBe(200);
    expect((await staffCargoApi(manager).event(reference, { type: 'LOADED' })).status).toBe(201);

    const manifest = await adminApi(manager).post(
      `/manifests/trips/${running.tripReference}`,
    );
    expect(manifest.status, manifest.text).toBe(201);

    const policy = await adminApi(manager).post(
      `/departure/trips/${running.tripReference}/permit-policy`,
      { requirements: [] },
    );
    expect(policy.status, policy.text).toBe(201);

    const authorization = await adminApi(manager).post(
      `/departure/trips/${running.tripReference}/authorize`,
      {},
    );
    expect(authorization.status, authorization.text).toBe(200);

    const departed = await adminApi(manager).post(
      `/departure/trips/${running.tripReference}/depart`,
      {},
    );
    expect(departed.status, departed.text).toBe(200);
    expect(departed.body.trip.status).toBe('IN_PROGRESS');

    for (const type of ['DEPARTED', 'IN_TRANSIT', 'ARRIVED', 'AVAILABLE', 'DELIVERED']) {
      const response = await staffCargoApi(manager).event(reference, { type });
      expect(response.status, `${type}: ${response.text}`).toBe(201);
    }
    expect((await staffCargoApi(manager).detail(reference)).body.lifecycleStatus).toBe('DELIVERED');
  });

  it('keeps exceptions separate, deduplicates events and freezes facts after loading', async () => {
    const created = await staffCargoApi(manager).create(
      cargoCreateBody({ weightKg: '100.000', volumeLiters: 100 }),
    );
    const reference = created.body.reference as string;
    const occurredAt = new Date().toISOString();

    const booked = await staffCargoApi(manager).event(reference, {
      type: 'BOOKED',
      occurredAt,
      clientEventId: 'cargo-booked-0001',
    });
    expect(booked.status).toBe(201);
    const replay = await staffCargoApi(manager).event(reference, {
      type: 'BOOKED',
      occurredAt,
      clientEventId: 'cargo-booked-0001',
    });
    expect(replay.status).toBe(201);
    expect(replay.body.created).toBe(false);

    expect((await staffCargoApi(manager).event(reference, { type: 'RECEIVED' })).status).toBe(201);
    expect((await staffCargoApi(manager).event(reference, { type: 'CUSTOMS_HOLD' })).status).toBe(
      201,
    );
    expect((await staffCargoApi(manager).event(reference, { type: 'INSPECTED' })).status).toBe(409);
    expect(
      (await staffCargoApi(manager).event(reference, { type: 'EXCEPTION_RESOLVED' })).status,
    ).toBe(201);
    expect((await staffCargoApi(manager).event(reference, { type: 'INSPECTED' })).status).toBe(201);

    expect(
      (
        await staffCargoApi(manager).assign(reference, {
          tripReference: fixture.tripReference,
          vehicleCode: fixture.vehicleCode,
        })
      ).status,
    ).toBe(200);
    expect((await staffCargoApi(manager).event(reference, { type: 'LOADED' })).status).toBe(201);
    const frozen = await staffCargoApi(manager).update(reference, {
      weightKg: '101.000',
      expectedUpdatedAt: (await staffCargoApi(manager).detail(reference)).body.updatedAt,
    });
    expect(frozen.status).toBe(409);
    expect(frozen.body.code).toBe('CARGO_DETAILS_FROZEN');
  });

  it('audits sensitive reads and writes without copying contact values into audit JSON', async () => {
    const created = await staffCargoApi(manager).create(
      cargoCreateBody({
        senderContact: 'SENSITIVE-SENDER-CONTACT',
        recipientContact: 'SENSITIVE-RECIPIENT-CONTACT',
      }),
    );
    const reference = created.body.reference as string;
    await staffCargoApi(manager).list(`?reference=${reference}`);
    await staffCargoApi(manager).detail(reference);
    const shipment = await db(t.app).roadFreightShipment.findUniqueOrThrow({
      where: { reference },
    });
    const audits = await db(t.app).auditEvent.findMany({
      where: {
        OR: [
          { resourceId: shipment.id },
          { action: 'ROAD_FREIGHT_ACCESSED', actorIdentityId: manager.id },
        ],
      },
    });
    const json = JSON.stringify(audits);
    expect(json).toContain('ROAD_FREIGHT_CREATED');
    expect(json).toContain('ROAD_FREIGHT_ACCESSED');
    expect(json).not.toContain('SENSITIVE-SENDER-CONTACT');
    expect(json).not.toContain('SENSITIVE-RECIPIENT-CONTACT');

    await expect(
      db(t.app).roadFreightShipment.delete({ where: { id: shipment.id } }),
    ).rejects.toThrow(/cannot be deleted/);
  });
});
