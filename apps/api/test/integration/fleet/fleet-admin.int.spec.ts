import { randomBytes } from 'node:crypto';
import request from 'supertest';
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

let vinSequence = 0;
/** Synthetic VIN (shape only): ZZZ prefix, never a real vehicle. */
const syntheticVin = () => `ZZZ${String(vinSequence++).padStart(14, '0')}`;
const syntheticCode = () => `VH_${randomBytes(4).toString('hex').toUpperCase()}`;

/**
 * Vehicle administration through the HTTP API: permissions, CSRF, CRUD,
 * lifecycle, audit, concurrency and atomicity. Own database: one test
 * installs a temporary failing trigger on audit_event.
 */
describe('fleet administration API (isolated database)', () => {
  let t: TestApp;
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let admin: StaffActor;
  let manager: StaffActor;
  let reader: StaffActor;
  let countryId: string;

  beforeAll(async () => {
    database = await isolatedDatabase();
    t = await startTestApp(integrationEnv({ DATABASE_URL: database.url }));
    [admin, manager, reader] = await Promise.all([
      staffActor(t.app, ['SUPER_ADMIN']),
      staffActor(t.app, ['OPS_MANAGER']),
      staffActor(t.app, ['DISPATCHER']),
    ]);
    countryId = (
      await db(t.app).country.create({ data: { iso2: 'QF', iso3: 'QFF', name: 'Pays flotte' } })
    ).id;
  });

  afterAll(async () => {
    await t.app.close();
    await database.drop();
  });

  async function createVehicle(actor: StaffActor = admin, overrides: Record<string, unknown> = {}) {
    const response = await adminApi(actor).post('/fleet/vehicles', {
      code: syntheticCode(),
      manufacturer: 'Constructeur synthétique',
      model: 'Modèle synthétique',
      ...overrides,
    });
    if (response.status !== 201) throw new Error(`vehicle: ${response.status} ${response.text}`);
    return response.body as { id: string; code: string; status: string };
  }

  const transition = (actor: StaffActor, id: string, body: Record<string, unknown>) =>
    adminApi(actor).post(`/fleet/vehicles/${id}/status`, body);

  describe('authorization', () => {
    it('lets fleet.read holders read and refuses others with 403', async () => {
      const vehicle = await createVehicle();
      const api = adminApi(reader);
      expect((await api.get('/fleet/vehicles')).status).toBe(200);
      expect((await api.get(`/fleet/vehicles/${vehicle.id}`)).status).toBe(200);

      const denied = adminApi(await staffActor(t.app, ['BOOKING_AGENT']));
      for (const path of ['/fleet/vehicles', `/fleet/vehicles/${vehicle.id}`]) {
        const response = await denied.get(path);
        expect(response.status, path).toBe(403);
        expect(response.body.code).toBe('FORBIDDEN');
      }
    });

    it('lets fleet.manage holders mutate and refuses read-only roles with 403', async () => {
      const created = await createVehicle(manager);
      expect(created.status).toBe('PLANNED');
      const before = await db(t.app).vehicle.count();
      const api = adminApi(reader);
      const attempts = [
        await api.post('/fleet/vehicles', {
          code: syntheticCode(),
          manufacturer: 'x',
          model: 'y',
        }),
        await api.post(`/fleet/vehicles/${created.id}`, { model: 'Interdit' }),
        await api.post(`/fleet/vehicles/${created.id}/status`, {
          status: 'ACTIVE',
          reason: 'Interdit',
        }),
      ];
      for (const attempt of attempts) {
        expect(attempt.status).toBe(403);
        expect(attempt.body.code).toBe('FORBIDDEN');
      }
      expect(await db(t.app).vehicle.count()).toBe(before);
      expect(
        await db(t.app).vehicle.findUniqueOrThrow({ where: { id: created.id } }),
      ).toMatchObject({ status: 'PLANNED', model: 'Modèle synthétique' });
    });

    it('requires a valid CSRF token on every mutation', async () => {
      const api = adminApi(admin);
      const vehicle = await createVehicle();
      const body = { code: syntheticCode(), manufacturer: 'x', model: 'y' };
      expect((await api.post('/fleet/vehicles', body, { csrf: null })).status).toBe(403);
      expect((await api.post('/fleet/vehicles', body, { csrf: 'v1.9999999999.x.y' })).status).toBe(
        403,
      );
      expect(
        (await api.post(`/fleet/vehicles/${vehicle.id}`, { model: 'z' }, { csrf: null })).status,
      ).toBe(403);
      expect(
        (
          await api.post(
            `/fleet/vehicles/${vehicle.id}/status`,
            { status: 'ACTIVE', reason: 'Sans CSRF' },
            { csrf: null },
          )
        ).status,
      ).toBe(403);
      expect(
        await db(t.app).vehicle.findUniqueOrThrow({ where: { id: vehicle.id } }),
      ).toMatchObject({ status: 'PLANNED' });
    });

    it('exposes no delete endpoint', async () => {
      const vehicle = await createVehicle();
      const csrf = await admin.csrf();
      const response = await request(t.app.getHttpServer())
        .delete(`/v1/admin/fleet/vehicles/${vehicle.id}`)
        .set('Origin', admin.http.origin)
        .set('Cookie', admin.cookie)
        .set('X-CSRF-Token', csrf);
      expect(response.status).toBe(404);
      expect(await db(t.app).vehicle.count({ where: { id: vehicle.id } })).toBe(1);
    });
  });

  describe('registry', () => {
    it('creates a normalized PLANNED vehicle with an optional registration', async () => {
      const vin = syntheticVin();
      const response = await adminApi(admin).post('/fleet/vehicles', {
        code: ' bus_test_01 ',
        vin: vin.toLowerCase(),
        registrationPlate: '  test   0001 ',
        registrationCountryId: countryId,
        manufacturer: ' Constructeur ',
        model: 'Modèle',
        modelYear: 2022,
      });
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        code: 'BUS_TEST_01',
        vin,
        registrationPlate: 'TEST 0001',
        registrationCountry: { id: countryId, iso2: 'QF' },
        manufacturer: 'Constructeur',
        modelYear: 2022,
        status: 'PLANNED',
        retiredAt: null,
      });
      expect(
        (
          await adminApi(admin).post('/fleet/vehicles', {
            code: syntheticCode(),
            manufacturer: 'x',
            model: 'y',
            status: 'ACTIVE',
          })
        ).status,
      ).toBe(400);
    });

    it('refuses duplicate code, VIN and registration with a stable error', async () => {
      const api = adminApi(admin);
      const vin = syntheticVin();
      const first = await createVehicle(admin, {
        vin,
        registrationPlate: 'TEST 0002',
        registrationCountryId: countryId,
      });
      for (const duplicate of [
        { code: first.code },
        { vin },
        { registrationPlate: 'test 0002', registrationCountryId: countryId },
      ]) {
        const response = await api.post('/fleet/vehicles', {
          code: syntheticCode(),
          manufacturer: 'x',
          model: 'y',
          ...duplicate,
        });
        expect(response.status, JSON.stringify(duplicate)).toBe(409);
        expect(response.body.code).toBe('VEHICLE_IDENTIFIER_CONFLICT');
      }
      // Updates hit the same rules.
      const second = await createVehicle();
      const conflict = await api.post(`/fleet/vehicles/${second.id}`, { vin });
      expect(conflict.status).toBe(409);
      expect(conflict.body.code).toBe('VEHICLE_IDENTIFIER_CONFLICT');
    });

    it('refuses an unknown country and an incomplete registration', async () => {
      const api = adminApi(admin);
      const unknown = await api.post('/fleet/vehicles', {
        code: syntheticCode(),
        manufacturer: 'x',
        model: 'y',
        registrationPlate: 'TEST 0003',
        registrationCountryId: UNKNOWN_ID,
      });
      expect(unknown.status).toBe(404);
      expect(unknown.body.code).toBe('COUNTRY_NOT_FOUND');
      const incomplete = await api.post('/fleet/vehicles', {
        code: syntheticCode(),
        manufacturer: 'x',
        model: 'y',
        registrationPlate: 'TEST 0004',
      });
      expect(incomplete.status).toBe(422);
      expect(incomplete.body.code).toBe('VEHICLE_REGISTRATION_INCOMPLETE');
    });

    it('updates administrative data only; never the status', async () => {
      const api = adminApi(admin);
      const vehicle = await createVehicle(admin, {
        registrationPlate: 'TEST 0005',
        registrationCountryId: countryId,
      });
      const updated = await api.post(`/fleet/vehicles/${vehicle.id}`, {
        model: 'Modèle révisé',
        modelYear: 2021,
      });
      expect(updated.status).toBe(200);
      expect(updated.body).toMatchObject({
        model: 'Modèle révisé',
        modelYear: 2021,
        status: 'PLANNED',
      });

      for (const forbidden of [{ status: 'ACTIVE' }, { retiredAt: new Date().toISOString() }]) {
        expect((await api.post(`/fleet/vehicles/${vehicle.id}`, forbidden)).status).toBe(400);
      }
      // Removing the plate alone would leave a country without plate.
      const partial = await api.post(`/fleet/vehicles/${vehicle.id}`, { registrationPlate: null });
      expect(partial.status).toBe(422);
      const cleared = await api.post(`/fleet/vehicles/${vehicle.id}`, {
        registrationPlate: null,
        registrationCountryId: null,
      });
      expect(cleared.body).toMatchObject({ registrationPlate: null, registrationCountry: null });
      expect((await api.post(`/fleet/vehicles/${UNKNOWN_ID}`, { model: 'x' })).status).toBe(404);
      expect((await api.post('/fleet/vehicles/not-a-uuid', { model: 'x' })).status).toBe(400);
      expect(
        (await db(t.app).vehicle.findUniqueOrThrow({ where: { id: vehicle.id } })).status,
      ).toBe('PLANNED');
    });

    it('paginates newest first with a bounded keyset cursor and a status filter', async () => {
      const api = adminApi(admin);
      for (let index = 0; index < 3; index += 1) await createVehicle();
      const first = await api.get('/fleet/vehicles?limit=2');
      expect(first.body.items).toHaveLength(2);
      expect(first.body.nextCursor).toBe(first.body.items[1].id);
      const second = await api.get(`/fleet/vehicles?limit=2&cursor=${first.body.nextCursor}`);
      for (const item of second.body.items as Array<{ id: string }>) {
        expect(item.id < first.body.nextCursor).toBe(true);
      }
      const planned = await api.get('/fleet/vehicles?status=PLANNED&limit=100');
      expect(
        (planned.body.items as Array<{ status: string }>).every((v) => v.status === 'PLANNED'),
      ).toBe(true);
      expect((await api.get('/fleet/vehicles?limit=101')).status).toBe(400);
      expect((await api.get('/fleet/vehicles?status=BROKEN')).status).toBe(400);
      expect((await api.get(`/fleet/vehicles/${UNKNOWN_ID}`)).status).toBe(404);
    });
  });

  describe('lifecycle', () => {
    it('follows the allowed transitions and keeps the reason in the history', async () => {
      const vehicle = await createVehicle();
      const steps: Array<[string, string]> = [
        ['ACTIVE', 'Mise en service'],
        ['OUT_OF_SERVICE', 'Panne synthétique'],
        ['ACTIVE', 'Réparé'],
        ['RETIRED', 'Fin de vie'],
      ];
      for (const [status, reason] of steps) {
        const response = await transition(admin, vehicle.id, { status, reason });
        expect(response.status, status).toBe(200);
        expect(response.body.status).toBe(status);
      }
      const detail = await adminApi(reader).get(`/fleet/vehicles/${vehicle.id}`);
      expect(detail.body).toMatchObject({ status: 'RETIRED', retiredAt: expect.any(String) });
      expect(
        (detail.body.statusHistory as Array<{ from: string; to: string; reason: string }>).map(
          (entry) => [entry.from, entry.to, entry.reason],
        ),
      ).toEqual([
        ['ACTIVE', 'RETIRED', 'Fin de vie'],
        ['OUT_OF_SERVICE', 'ACTIVE', 'Réparé'],
        ['ACTIVE', 'OUT_OF_SERVICE', 'Panne synthétique'],
        ['PLANNED', 'ACTIVE', 'Mise en service'],
      ]);
      // The history exposes no actor identity.
      expect(JSON.stringify(detail.body.statusHistory)).not.toContain(admin.email);
    });

    it('refuses invalid transitions with a stable 409 and changes nothing', async () => {
      const vehicle = await createVehicle();
      const invalid = await transition(admin, vehicle.id, {
        status: 'OUT_OF_SERVICE',
        reason: 'Impossible depuis PLANNED',
      });
      expect(invalid.status).toBe(409);
      expect(invalid.body.code).toBe('VEHICLE_STATUS_TRANSITION_INVALID');
      expect(
        (await transition(admin, vehicle.id, { status: 'PLANNED', reason: 'Retour' })).status,
      ).toBe(400);
      expect((await transition(admin, vehicle.id, { status: 'ACTIVE' })).status).toBe(400);
      await transition(admin, vehicle.id, { status: 'ACTIVE', reason: 'Mise en service' });
      const same = await transition(admin, vehicle.id, { status: 'ACTIVE', reason: 'Encore' });
      expect(same.body.code).toBe('VEHICLE_STATUS_TRANSITION_INVALID');
      expect(
        await db(t.app).auditEvent.count({
          where: { resourceId: vehicle.id, action: 'VEHICLE_STATUS_CHANGED' },
        }),
      ).toBe(1);
      expect(
        (await transition(admin, UNKNOWN_ID, { status: 'ACTIVE', reason: 'Inconnu' })).status,
      ).toBe(404);
    });

    it('makes RETIRED terminal for transitions and administrative updates', async () => {
      const vehicle = await createVehicle();
      await transition(admin, vehicle.id, { status: 'RETIRED', reason: 'Jamais mis en service' });
      for (const status of ['ACTIVE', 'OUT_OF_SERVICE', 'RETIRED']) {
        const response = await transition(admin, vehicle.id, { status, reason: 'Après retrait' });
        expect(response.status).toBe(409);
        expect(response.body.code).toBe('VEHICLE_STATUS_TRANSITION_INVALID');
      }
      const update = await adminApi(admin).post(`/fleet/vehicles/${vehicle.id}`, { model: 'x' });
      expect(update.status).toBe(409);
      expect(update.body.code).toBe('VEHICLE_RETIRED');
    });

    it('refuses a transition decided on a stale status (expectedStatus)', async () => {
      const vehicle = await createVehicle();
      await transition(admin, vehicle.id, { status: 'ACTIVE', reason: 'Mise en service' });
      const stale = await transition(manager, vehicle.id, {
        status: 'RETIRED',
        reason: 'Décidé sur une fiche périmée',
        expectedStatus: 'PLANNED',
      });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('VEHICLE_STATUS_CONFLICT');
      expect(
        (await db(t.app).vehicle.findUniqueOrThrow({ where: { id: vehicle.id } })).status,
      ).toBe('ACTIVE');
    });
  });

  describe('audit', () => {
    it('audits create, update and status changes in the same transaction, with the request id', async () => {
      const vehicle = await createVehicle();
      await adminApi(admin).post(`/fleet/vehicles/${vehicle.id}`, { model: 'Modèle audité' });
      const response = await admin.http
        .post(
          `/v1/admin/fleet/vehicles/${vehicle.id}/status`,
          { status: 'ACTIVE', reason: 'Mise en service auditée' },
          admin.cookie,
          await admin.csrf(),
        )
        .set('X-Request-Id', 'fleet-status-0001');
      expect(response.status).toBe(200);

      const events = await db(t.app).auditEvent.findMany({
        where: { resourceType: 'vehicle', resourceId: vehicle.id },
        orderBy: { occurredAt: 'asc' },
      });
      expect(events.map((event) => event.action)).toEqual([
        'VEHICLE_CREATED',
        'VEHICLE_UPDATED',
        'VEHICLE_STATUS_CHANGED',
      ]);
      expect(events[1]).toMatchObject({
        before: { model: 'Modèle synthétique' },
        after: { model: 'Modèle audité' },
      });
      expect(events[2]).toMatchObject({
        requestId: 'fleet-status-0001',
        actorIdentityId: admin.id,
        actorRealm: 'STAFF',
        before: { status: 'PLANNED' },
        after: { status: 'ACTIVE' },
        metadata: { reason: 'Mise en service auditée' },
      });
    });

    it('rolls the status change back when its audit event cannot be written', async () => {
      const vehicle = await createVehicle();
      await db(t.app).$executeRawUnsafe(`
        CREATE FUNCTION test_fail_vehicle_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.action IN ('VEHICLE_STATUS_CHANGED', 'VEHICLE_UPDATED') THEN
            RAISE EXCEPTION 'simulated audit failure';
          END IF;
          RETURN NEW;
        END; $$`);
      await db(t.app).$executeRawUnsafe(
        'CREATE TRIGGER test_fail_vehicle_audit BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION test_fail_vehicle_audit()',
      );
      try {
        const status = await transition(admin, vehicle.id, {
          status: 'ACTIVE',
          reason: 'Jamais appliqué',
        });
        expect(status.status).toBe(500);
        const update = await adminApi(admin).post(`/fleet/vehicles/${vehicle.id}`, {
          model: 'Jamais appliqué',
        });
        expect(update.status).toBe(500);
        expect(
          await db(t.app).vehicle.findUniqueOrThrow({ where: { id: vehicle.id } }),
        ).toMatchObject({ status: 'PLANNED', statusChangedAt: null, model: 'Modèle synthétique' });
      } finally {
        await db(t.app).$executeRawUnsafe('DROP TRIGGER test_fail_vehicle_audit ON audit_event');
        await db(t.app).$executeRawUnsafe('DROP FUNCTION test_fail_vehicle_audit()');
      }
      expect(
        (await transition(admin, vehicle.id, { status: 'ACTIVE', reason: 'Appliqué' })).status,
      ).toBe(200);
    });
  });

  describe('concurrency', () => {
    it('two identical concurrent transitions: exactly one applies', async () => {
      const vehicle = await createVehicle();
      await transition(admin, vehicle.id, { status: 'ACTIVE', reason: 'Mise en service' });
      const results = await Promise.all([
        transition(admin, vehicle.id, { status: 'OUT_OF_SERVICE', reason: 'Panne A' }),
        transition(manager, vehicle.id, { status: 'OUT_OF_SERVICE', reason: 'Panne B' }),
      ]);
      expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
      expect(
        await db(t.app).auditEvent.count({
          where: { resourceId: vehicle.id, action: 'VEHICLE_STATUS_CHANGED' },
        }),
      ).toBe(2);
    });

    it('concurrent conflicting transitions never produce an impossible lifecycle', async () => {
      for (let round = 0; round < 3; round += 1) {
        const vehicle = await createVehicle();
        await transition(admin, vehicle.id, { status: 'ACTIVE', reason: 'Mise en service' });
        const results = await Promise.all([
          transition(admin, vehicle.id, {
            status: 'RETIRED',
            reason: 'Retrait',
            expectedStatus: 'ACTIVE',
          }),
          transition(manager, vehicle.id, {
            status: 'OUT_OF_SERVICE',
            reason: 'Panne',
            expectedStatus: 'ACTIVE',
          }),
        ]);
        // Both decided on ACTIVE: only one may apply.
        expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
        const stored = await db(t.app).vehicle.findUniqueOrThrow({ where: { id: vehicle.id } });
        const winner = results.find((response) => response.status === 200)?.body.status;
        expect(stored.status).toBe(winner);
        expect(stored.retiredAt !== null).toBe(stored.status === 'RETIRED');
        const history = await db(t.app).auditEvent.findMany({
          where: { resourceId: vehicle.id, action: 'VEHICLE_STATUS_CHANGED' },
          orderBy: { occurredAt: 'asc' },
        });
        expect(history.map((event) => (event.after as { status: string }).status)).toEqual([
          'ACTIVE',
          winner,
        ]);
      }
    });
  });
});
