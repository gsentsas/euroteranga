import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isolatedDatabase } from '../../support/admin-helpers.js';
import { db } from '../../support/auth-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

/**
 * Vehicle invariants proven through direct database writes (Prisma and raw
 * SQL), bypassing the API and the service. Synthetic data only.
 */
describe('fleet database invariants (isolated database)', () => {
  let t: TestApp;
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let countryId: string;
  let otherCountryId: string;

  beforeAll(async () => {
    database = await isolatedDatabase();
    t = await startTestApp(integrationEnv({ DATABASE_URL: database.url }));
    countryId = (
      await db(t.app).country.create({ data: { iso2: 'QA', iso3: 'QAA', name: 'Pays A' } })
    ).id;
    otherCountryId = (
      await db(t.app).country.create({ data: { iso2: 'QB', iso3: 'QBB', name: 'Pays B' } })
    ).id;
  });

  afterAll(async () => {
    await t.app.close();
    await database.drop();
  });

  const code = () => `VH_${randomBytes(4).toString('hex').toUpperCase()}`;

  function vehicle(data: Record<string, unknown> = {}) {
    return db(t.app).vehicle.create({
      data: { code: code(), manufacturer: 'Constructeur', model: 'Modèle', ...data },
    });
  }

  function setStatus(id: string, status: 'PLANNED' | 'ACTIVE' | 'OUT_OF_SERVICE' | 'RETIRED') {
    return db(t.app).vehicle.update({
      where: { id },
      data: { status, retiredAt: status === 'RETIRED' ? new Date() : null },
    });
  }

  it('requires a unique, normalized code', async () => {
    await vehicle({ code: 'VH_UNIQUE' });
    await expect(vehicle({ code: 'VH_UNIQUE' })).rejects.toThrow();
    await expect(vehicle({ code: 'vh_lower' })).rejects.toThrow(/vehicle_code_normalized/);
    await expect(vehicle({ code: ' VH_PADDED' })).rejects.toThrow(/vehicle_code_normalized/);
  });

  it('keeps an optional VIN unique and well-shaped', async () => {
    await vehicle();
    await vehicle(); // several vehicles without VIN
    await vehicle({ vin: 'ZZZ00000000000001' });
    await expect(vehicle({ vin: 'ZZZ00000000000001' })).rejects.toThrow();
    await expect(vehicle({ vin: 'zzz00000000000002' })).rejects.toThrow(/vehicle_vin_shape/);
    await expect(vehicle({ vin: 'ZZZ0000000000000O' })).rejects.toThrow(/vehicle_vin_shape/);
    await expect(vehicle({ vin: 'ZZZ000000000003' })).rejects.toThrow(/vehicle_vin_shape/);
  });

  it('keeps a plate unique within its country, and plate and country together', async () => {
    await vehicle({ registrationPlate: 'TEST 001', registrationCountryId: countryId });
    await expect(
      vehicle({ registrationPlate: 'TEST 001', registrationCountryId: countryId }),
    ).rejects.toThrow();
    // Same plate in another country is a different registration.
    await expect(
      vehicle({ registrationPlate: 'TEST 001', registrationCountryId: otherCountryId }),
    ).resolves.toBeDefined();
    await expect(vehicle({ registrationPlate: 'TEST 002' })).rejects.toThrow(
      /vehicle_registration_complete/,
    );
    await expect(vehicle({ registrationCountryId: countryId })).rejects.toThrow(
      /vehicle_registration_complete/,
    );
    await expect(
      vehicle({ registrationPlate: 'test 003', registrationCountryId: countryId }),
    ).rejects.toThrow(/vehicle_registration_plate_normalized/);
    await expect(
      vehicle({ registrationPlate: 'TEST  004', registrationCountryId: countryId }),
    ).rejects.toThrow(/vehicle_registration_plate_normalized/);
    await expect(
      vehicle({
        registrationPlate: 'TEST 005',
        registrationCountryId: '01900000-0000-7000-8000-000000000000',
      }),
    ).rejects.toThrow();
  });

  it('bounds the model year and keeps names trimmed', async () => {
    await expect(vehicle({ modelYear: 1949 })).rejects.toThrow(/vehicle_model_year_range/);
    await expect(vehicle({ modelYear: 2101 })).rejects.toThrow(/vehicle_model_year_range/);
    await expect(vehicle({ modelYear: 1950 })).resolves.toBeDefined();
    await expect(vehicle({ manufacturer: ' Padded' })).rejects.toThrow(
      /vehicle_manufacturer_normalized/,
    );
    await expect(vehicle({ model: '' })).rejects.toThrow(/vehicle_model_normalized/);
  });

  it('keeps role and baggage/freight capacity physically coherent', async () => {
    const defaults = await vehicle();
    expect(defaults).toMatchObject({
      role: 'PASSENGER_COACH',
      payloadCapacityKg: null,
      cargoVolumeLiters: null,
    });

    await expect(
      vehicle({ role: 'CARGO_SUPPORT', payloadCapacityKg: 3_500, cargoVolumeLiters: 20_000 }),
    ).resolves.toMatchObject({
      role: 'CARGO_SUPPORT',
      payloadCapacityKg: 3_500,
      cargoVolumeLiters: 20_000,
    });
    await expect(vehicle({ payloadCapacityKg: 3_500 })).rejects.toThrow(
      /vehicle_load_capacity_pair/,
    );
    await expect(vehicle({ cargoVolumeLiters: 20_000 })).rejects.toThrow(
      /vehicle_load_capacity_pair/,
    );
    await expect(vehicle({ payloadCapacityKg: 0, cargoVolumeLiters: 20_000 })).rejects.toThrow(
      /vehicle_load_capacity_pair/,
    );
    await expect(vehicle({ payloadCapacityKg: 3_500, cargoVolumeLiters: 0 })).rejects.toThrow(
      /vehicle_load_capacity_pair/,
    );
  });

  it('creates vehicles as PLANNED only, and ties retiredAt to RETIRED', async () => {
    await expect(vehicle({ status: 'ACTIVE' })).rejects.toThrow(/must be created as PLANNED/);
    await expect(vehicle({ retiredAt: new Date() })).rejects.toThrow(
      /vehicle_retired_at_consistent/,
    );
    const planned = await vehicle();
    await expect(
      db(t.app).vehicle.update({ where: { id: planned.id }, data: { status: 'RETIRED' } }),
    ).rejects.toThrow(/vehicle_retired_at_consistent/);
    await expect(
      db(t.app).vehicle.update({ where: { id: planned.id }, data: { retiredAt: new Date() } }),
    ).rejects.toThrow(/vehicle_retired_at_consistent/);
  });

  it('allows exactly the documented transitions', async () => {
    const a = await vehicle();
    await expect(setStatus(a.id, 'ACTIVE')).resolves.toMatchObject({ status: 'ACTIVE' });
    await expect(setStatus(a.id, 'OUT_OF_SERVICE')).resolves.toMatchObject({
      status: 'OUT_OF_SERVICE',
    });
    await expect(setStatus(a.id, 'ACTIVE')).resolves.toMatchObject({ status: 'ACTIVE' });
    await expect(setStatus(a.id, 'PLANNED')).rejects.toThrow(/invalid vehicle status transition/);
    await expect(setStatus(a.id, 'RETIRED')).resolves.toMatchObject({ status: 'RETIRED' });

    const b = await vehicle();
    await expect(setStatus(b.id, 'OUT_OF_SERVICE')).rejects.toThrow(
      /invalid vehicle status transition/,
    );
    await expect(setStatus(b.id, 'RETIRED')).resolves.toMatchObject({ status: 'RETIRED' });

    const c = await vehicle();
    await setStatus(c.id, 'ACTIVE');
    await setStatus(c.id, 'OUT_OF_SERVICE');
    await expect(setStatus(c.id, 'PLANNED')).rejects.toThrow(/invalid vehicle status transition/);
    await expect(setStatus(c.id, 'RETIRED')).resolves.toMatchObject({ status: 'RETIRED' });
  });

  it('makes RETIRED terminal and frozen, even for raw SQL', async () => {
    const retired = await vehicle();
    await setStatus(retired.id, 'ACTIVE');
    await setStatus(retired.id, 'RETIRED');

    await expect(setStatus(retired.id, 'ACTIVE')).rejects.toThrow(/retired vehicles are immutable/);
    await expect(
      db(t.app).vehicle.update({ where: { id: retired.id }, data: { model: 'Changé' } }),
    ).rejects.toThrow(/retired vehicles are immutable/);
    await expect(
      db(t.app).$executeRawUnsafe(
        `UPDATE "vehicle" SET "status" = 'ACTIVE', "retired_at" = NULL WHERE "id" = '${retired.id}'`,
      ),
    ).rejects.toThrow(/retired vehicles are immutable/);
    expect(await db(t.app).vehicle.findUniqueOrThrow({ where: { id: retired.id } })).toMatchObject({
      status: 'RETIRED',
      model: 'Modèle',
    });
  });

  it('cannot be bypassed by direct writes: no delete, no truncate, immutable identity', async () => {
    const target = await vehicle();
    await expect(
      db(t.app).$executeRawUnsafe(
        `UPDATE "vehicle" SET "status" = 'OUT_OF_SERVICE' WHERE "id" = '${target.id}'`,
      ),
    ).rejects.toThrow(/invalid vehicle status transition/);
    await expect(db(t.app).vehicle.delete({ where: { id: target.id } })).rejects.toThrow(
      /vehicles cannot be deleted/,
    );
    await expect(db(t.app).$executeRawUnsafe('DELETE FROM "vehicle"')).rejects.toThrow(
      /vehicles cannot be deleted/,
    );
    // Since PR-06, trips reference vehicles: a plain TRUNCATE is refused by the
    // foreign key, and a CASCADE reaches this table's trigger.
    await expect(db(t.app).$executeRawUnsafe('TRUNCATE TABLE "vehicle"')).rejects.toThrow(
      /referenced in a foreign key constraint/,
    );
    await expect(db(t.app).$executeRawUnsafe('TRUNCATE TABLE "vehicle" CASCADE')).rejects.toThrow(
      /the vehicle registry cannot be truncated/,
    );
    await expect(
      db(t.app).vehicle.update({ where: { id: target.id }, data: { createdAt: new Date(0) } }),
    ).rejects.toThrow(/vehicle identity is immutable/);
    // Administrative data stays editable while not retired.
    await expect(
      db(t.app).vehicle.update({ where: { id: target.id }, data: { model: 'Nouveau modèle' } }),
    ).resolves.toMatchObject({ model: 'Nouveau modèle', status: 'PLANNED' });
  });

  it('protects the registration country referenced by a vehicle', async () => {
    const country = await db(t.app).country.create({
      data: { iso2: 'QC', iso3: 'QCC', name: 'Pays C' },
    });
    await vehicle({ registrationPlate: 'TEST 900', registrationCountryId: country.id });
    await expect(db(t.app).country.delete({ where: { id: country.id } })).rejects.toThrow();
  });

  it('seeds the explicit fleet permission matrix without wildcards', async () => {
    const grants = await db(t.app).authorizationRolePermission.findMany({
      where: { permissionKey: { in: ['fleet.read', 'fleet.manage'] } },
      orderBy: [{ permissionKey: 'asc' }, { roleKey: 'asc' }],
      select: { permissionKey: true, roleKey: true },
    });
    expect(grants.map((g) => `${g.permissionKey}:${g.roleKey}`)).toEqual([
      'fleet.manage:DIRECTOR',
      'fleet.manage:OPS_MANAGER',
      'fleet.manage:SUPER_ADMIN',
      'fleet.read:AUDITOR',
      'fleet.read:COMPLIANCE_AGENT',
      'fleet.read:DIRECTOR',
      'fleet.read:DISPATCHER',
      'fleet.read:OPS_MANAGER',
      'fleet.read:SUPER_ADMIN',
    ]);
  });
});
