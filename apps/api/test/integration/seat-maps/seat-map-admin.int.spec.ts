import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminApi,
  isolatedDatabase,
  staffActor,
  type StaffActor,
} from '../../support/admin-helpers.js';
import { db } from '../../support/auth-helpers.js';
import {
  basicLayout,
  createDraft,
  createSeatMap,
  publishedSeatMap,
  syntheticSeatMapCode,
} from '../../support/seat-map-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

const UNKNOWN_ID = '01900000-0000-7000-8000-000000000000';

/**
 * Seat-map catalogue through the HTTP API, on its own database (one test
 * installs a temporary failing trigger on audit_event).
 */
describe('seat-map administration API (isolated database)', () => {
  let t: TestApp;
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let admin: StaffActor;
  let manager: StaffActor;
  let reader: StaffActor;

  beforeAll(async () => {
    database = await isolatedDatabase();
    t = await startTestApp(integrationEnv({ DATABASE_URL: database.url }));
    [admin, manager, reader] = await Promise.all([
      staffActor(t.app, ['SUPER_ADMIN']),
      staffActor(t.app, ['OPS_MANAGER']),
      staffActor(t.app, ['DISPATCHER']),
    ]);
  });

  afterAll(async () => {
    await t.app.close();
    await database.drop();
  });

  const versionOf = (id: string) => db(t.app).seatMapVersion.findUniqueOrThrow({ where: { id } });
  const cellsOf = (versionId: string) =>
    db(t.app).seatMapCell.findMany({
      where: { seatMapVersionId: versionId },
      orderBy: [{ deck: 'asc' }, { row: 'asc' }, { column: 'asc' }],
      select: { deck: true, row: true, column: true, kind: true, seatLabel: true },
    });

  describe('authorization', () => {
    it('lets seatmap.read holders read and refuses others with 403', async () => {
      const { map } = await publishedSeatMap(admin);
      const api = adminApi(reader);
      expect((await api.get('/seat-maps')).status).toBe(200);
      expect((await api.get(`/seat-maps/${map.id}`)).status).toBe(200);
      const finance = adminApi(await staffActor(t.app, ['FINANCE']));
      for (const path of ['/seat-maps', `/seat-maps/${map.id}`]) {
        const response = await finance.get(path);
        expect(response.status, path).toBe(403);
        expect(response.body.code).toBe('FORBIDDEN');
      }
    });

    it('lets seatmap.manage holders mutate and refuses read-only roles with 403', async () => {
      const map = await createSeatMap(adminApi(manager));
      const draft = await createDraft(adminApi(manager), map.id);
      const api = adminApi(reader);
      const attempts = [
        await api.post('/seat-maps', { code: syntheticSeatMapCode(), name: 'x', active: true }),
        await api.post(`/seat-maps/${map.id}`, { name: 'Interdit' }),
        await api.post(`/seat-maps/${map.id}/versions`, {}),
        await api.post(`/seat-maps/${map.id}/versions/${draft.id}/cells`, { cells: basicLayout() }),
        await api.post(`/seat-maps/${map.id}/versions/${draft.id}/publish`, {}),
      ];
      for (const attempt of attempts) {
        expect(attempt.status).toBe(403);
        expect(attempt.body.code).toBe('FORBIDDEN');
      }
      expect(await cellsOf(draft.id)).toHaveLength(0);
    });

    it('requires a valid CSRF token on every mutation', async () => {
      const api = adminApi(admin);
      const map = await createSeatMap(api);
      const draft = await createDraft(api, map.id);
      const calls: Array<[string, unknown]> = [
        ['/seat-maps', { code: syntheticSeatMapCode(), name: 'x', active: true }],
        [`/seat-maps/${map.id}`, { name: 'Sans CSRF' }],
        [`/seat-maps/${map.id}/versions`, {}],
        [`/seat-maps/${map.id}/versions/${draft.id}/cells`, { cells: basicLayout() }],
        [`/seat-maps/${map.id}/versions/${draft.id}/publish`, {}],
      ];
      for (const [path, body] of calls) {
        expect((await api.post(path, body, { csrf: null })).status, path).toBe(403);
        expect((await api.post(path, body, { csrf: 'v1.9999999999.x.y' })).status, path).toBe(403);
      }
      expect((await versionOf(draft.id)).status).toBe('DRAFT');
    });

    it('exposes no delete endpoint', async () => {
      const { map } = await publishedSeatMap(admin);
      const csrf = await admin.csrf();
      for (const path of [`/v1/admin/seat-maps/${map.id}`]) {
        const response = await request(t.app.getHttpServer())
          .delete(path)
          .set('Origin', admin.http.origin)
          .set('Cookie', admin.cookie)
          .set('X-CSRF-Token', csrf);
        expect(response.status).toBe(404);
      }
      expect(await db(t.app).seatMap.count({ where: { id: map.id } })).toBe(1);
    });
  });

  describe('catalogue', () => {
    it('creates and updates seat maps with normalized, unique codes', async () => {
      const api = adminApi(admin);
      const created = await api.post('/seat-maps', {
        code: ' coach_test_a ',
        name: ' Autocar test ',
        active: true,
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        code: 'COACH_TEST_A',
        name: 'Autocar test',
        active: true,
        versions: [],
      });
      const duplicate = await api.post('/seat-maps', {
        code: 'COACH_TEST_A',
        name: 'Doublon',
        active: true,
      });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.code).toBe('SEAT_MAP_CODE_CONFLICT');
      const updated = await api.post(`/seat-maps/${created.body.id}`, {
        name: 'Autocar renommé',
        active: false,
      });
      expect(updated.body).toMatchObject({ name: 'Autocar renommé', active: false });
      expect((await api.post(`/seat-maps/${UNKNOWN_ID}`, { name: 'x' })).status).toBe(404);
      expect((await api.post(`/seat-maps/${created.body.id}`, {})).status).toBe(400);
    });

    it('creates numbered DRAFT versions, one at a time', async () => {
      const api = adminApi(admin);
      const map = await createSeatMap(api);
      const draft = await createDraft(api, map.id);
      expect(draft).toMatchObject({ version: 1, status: 'DRAFT' });
      const second = await api.post(`/seat-maps/${map.id}/versions`, {});
      expect(second.status).toBe(409);
      expect(second.body.code).toBe('SEAT_MAP_DRAFT_ALREADY_EXISTS');
      expect((await api.post(`/seat-maps/${UNKNOWN_ID}/versions`, {})).status).toBe(404);
    });

    it('paginates with a bounded keyset cursor', async () => {
      const api = adminApi(admin);
      for (let index = 0; index < 3; index += 1) await createSeatMap(api);
      const first = await api.get('/seat-maps?limit=2');
      expect(first.body.items).toHaveLength(2);
      expect(first.body.nextCursor).toBe(first.body.items[1].id);
      const second = await api.get(`/seat-maps?limit=2&cursor=${first.body.nextCursor}`);
      for (const item of second.body.items as Array<{ id: string }>) {
        expect(item.id < first.body.nextCursor).toBe(true);
      }
      const inactive = await api.get('/seat-maps?active=false&limit=100');
      expect(
        (inactive.body.items as Array<{ active: boolean }>).every((item) => !item.active),
      ).toBe(true);
      expect((await api.get('/seat-maps?limit=101')).status).toBe(400);
      expect((await api.get(`/seat-maps/${UNKNOWN_ID}`)).status).toBe(404);
    });
  });

  describe('cells', () => {
    it('replaces the complete DRAFT layout atomically and computes the capacity', async () => {
      const api = adminApi(admin);
      const map = await createSeatMap(api);
      const draft = await createDraft(api, map.id);
      const path = `/seat-maps/${map.id}/versions/${draft.id}/cells`;
      const first = await api.post(path, { cells: basicLayout() });
      expect(first.status).toBe(200);
      const version = (
        first.body.versions as Array<{ id: string; seatCount: number; cells: unknown[] }>
      ).find((candidate) => candidate.id === draft.id);
      expect(version).toMatchObject({ seatCount: 2 });
      expect(version?.cells).toHaveLength(4);

      const second = await api.post(path, {
        cells: [
          { deck: 1, row: 1, column: 1, kind: 'DRIVER' },
          { deck: 1, row: 1, column: 2, kind: 'DOOR' },
          { deck: 1, row: 2, column: 1, kind: 'SEAT', seatLabel: '01' },
          { deck: 1, row: 2, column: 2, kind: 'SEAT', seatLabel: '02' },
          { deck: 1, row: 3, column: 1, kind: 'SEAT', seatLabel: '03' },
          { deck: 2, row: 1, column: 1, kind: 'STAIRS' },
          { deck: 2, row: 2, column: 1, kind: 'TOILET' },
        ],
      });
      expect(second.status).toBe(200);
      expect(await cellsOf(draft.id)).toHaveLength(7);
      expect(
        await db(t.app).seatMapCell.count({ where: { seatMapVersionId: draft.id, kind: 'SEAT' } }),
      ).toBe(3);
    });

    it('refuses invalid layouts and leaves the stored one untouched', async () => {
      const api = adminApi(admin);
      const map = await createSeatMap(api);
      const draft = await createDraft(api, map.id);
      const path = `/seat-maps/${map.id}/versions/${draft.id}/cells`;
      await api.post(path, { cells: basicLayout() });
      const before = await cellsOf(draft.id);
      const semantic: Array<[string, unknown[]]> = [
        ['duplicated position', [...basicLayout(), { deck: 1, row: 2, column: 1, kind: 'DOOR' }]],
        [
          'duplicated label',
          [...basicLayout(), { deck: 1, row: 3, column: 1, kind: 'SEAT', seatLabel: '1A' }],
        ],
        ['seat without label', [...basicLayout(), { deck: 1, row: 3, column: 1, kind: 'SEAT' }]],
        [
          'labelled aisle',
          [...basicLayout(), { deck: 1, row: 3, column: 1, kind: 'AISLE', seatLabel: 'X1' }],
        ],
      ];
      for (const [label, cells] of semantic) {
        const response = await api.post(path, { cells });
        expect(response.status, label).toBe(422);
        expect(response.body.code, label).toBe('SEAT_MAP_CELLS_INVALID');
      }
      for (const cell of [
        { deck: 5, row: 1, column: 1, kind: 'AISLE' },
        { deck: 1, row: 0, column: 1, kind: 'AISLE' },
        { deck: 1, row: 1, column: 21, kind: 'AISLE' },
        { deck: 1, row: 1, column: 1, kind: 'EMPTY' },
        { deck: 1, row: 1, column: 1, kind: 'SEAT', seatLabel: '1A', fareClass: 'VIP' },
      ]) {
        expect((await api.post(path, { cells: [cell] })).status, JSON.stringify(cell)).toBe(400);
      }
      expect(await cellsOf(draft.id)).toEqual(before);
      expect(
        (await api.post(`/seat-maps/${UNKNOWN_ID}/versions/${draft.id}/cells`, { cells: [] }))
          .status,
      ).toBe(404);
    });
  });

  describe('publication', () => {
    it('refuses a version without seats or on an inactive seat map', async () => {
      const api = adminApi(admin);
      const map = await createSeatMap(api);
      const draft = await createDraft(api, map.id);
      await api.post(`/seat-maps/${map.id}/versions/${draft.id}/cells`, {
        cells: [{ deck: 1, row: 1, column: 1, kind: 'DRIVER' }],
      });
      const empty = await api.post(`/seat-maps/${map.id}/versions/${draft.id}/publish`, {});
      expect(empty.status).toBe(422);
      expect(empty.body.code).toBe('SEAT_MAP_VERSION_NOT_PUBLISHABLE');
      await api.post(`/seat-maps/${map.id}/versions/${draft.id}/cells`, { cells: basicLayout() });
      await api.post(`/seat-maps/${map.id}`, { active: false });
      const inactive = await api.post(`/seat-maps/${map.id}/versions/${draft.id}/publish`, {});
      expect(inactive.status).toBe(422);
      expect((await versionOf(draft.id)).status).toBe('DRAFT');
    });

    it('publishes, supersedes the previous version and freezes published layouts', async () => {
      const { api, map, versionId } = await publishedSeatMap(admin);
      const again = await api.post(`/seat-maps/${map.id}/versions/${versionId}/publish`, {});
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('SEAT_MAP_VERSION_NOT_DRAFT');
      const frozen = await api.post(`/seat-maps/${map.id}/versions/${versionId}/cells`, {
        cells: basicLayout('9'),
      });
      expect(frozen.status).toBe(409);
      expect(frozen.body.code).toBe('SEAT_MAP_VERSION_NOT_DRAFT');

      const next = await createDraft(api, map.id);
      expect(next.version).toBe(2);
      await api.post(`/seat-maps/${map.id}/versions/${next.id}/cells`, { cells: basicLayout('2') });
      expect((await api.post(`/seat-maps/${map.id}/versions/${next.id}/publish`, {})).status).toBe(
        200,
      );
      const detail = await adminApi(reader).get(`/seat-maps/${map.id}`);
      const versions = detail.body.versions as Array<{
        version: number;
        status: string;
        seatCount: number;
        retiredAt: string | null;
      }>;
      expect(
        versions.map((version) => [version.version, version.status, version.seatCount]),
      ).toEqual([
        [2, 'PUBLISHED', 2],
        [1, 'RETIRED', 2],
      ]);
      expect(versions[1]?.retiredAt).toEqual(expect.any(String));
      // The retired layout is preserved exactly.
      expect((await cellsOf(versionId)).map((cell) => cell.seatLabel)).toEqual([
        null,
        '1A',
        null,
        '1B',
      ]);
    });
  });

  describe('audit', () => {
    it('audits every catalogue mutation with the request id', async () => {
      const api = adminApi(admin);
      const map = await createSeatMap(api);
      await api.post(`/seat-maps/${map.id}`, { name: 'Plan audité' });
      const first = await createDraft(api, map.id);
      await api.post(`/seat-maps/${map.id}/versions/${first.id}/cells`, { cells: basicLayout() });
      await api.post(`/seat-maps/${map.id}/versions/${first.id}/publish`, {});
      const second = await createDraft(api, map.id);
      await api.post(`/seat-maps/${map.id}/versions/${second.id}/cells`, {
        cells: basicLayout('2'),
      });
      const response = await admin.http
        .post(
          `/v1/admin/seat-maps/${map.id}/versions/${second.id}/publish`,
          {},
          admin.cookie,
          await admin.csrf(),
        )
        .set('X-Request-Id', 'seat-map-publish-0001');
      expect(response.status).toBe(200);

      const events = await db(t.app).auditEvent.findMany({
        where: { resourceId: { in: [map.id, first.id, second.id] } },
        orderBy: { occurredAt: 'asc' },
        select: {
          action: true,
          resourceId: true,
          requestId: true,
          actorIdentityId: true,
          before: true,
          after: true,
        },
      });
      expect(events.map((event) => event.action)).toEqual([
        'SEAT_MAP_CREATED',
        'SEAT_MAP_UPDATED',
        'SEAT_MAP_VERSION_CREATED',
        'SEAT_MAP_CELLS_REPLACED',
        'SEAT_MAP_VERSION_PUBLISHED',
        'SEAT_MAP_VERSION_CREATED',
        'SEAT_MAP_CELLS_REPLACED',
        'SEAT_MAP_VERSION_RETIRED',
        'SEAT_MAP_VERSION_PUBLISHED',
      ]);
      expect(events.at(-1)).toMatchObject({
        resourceId: second.id,
        requestId: 'seat-map-publish-0001',
        actorIdentityId: admin.id,
        after: { status: 'PUBLISHED', seatCount: 2 },
      });
      expect(events[3]).toMatchObject({ before: { seatCount: 0 }, after: { seatCount: 2 } });
    });

    it('rolls cell replacement and publication back when the audit insert fails', async () => {
      const api = adminApi(admin);
      const { map, versionId: published } = await publishedSeatMap(admin);
      const draft = await createDraft(api, map.id);
      await api.post(`/seat-maps/${map.id}/versions/${draft.id}/cells`, {
        cells: basicLayout('2'),
      });
      const before = await cellsOf(draft.id);
      await db(t.app).$executeRawUnsafe(`
        CREATE FUNCTION test_fail_seat_map_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.action IN ('SEAT_MAP_CELLS_REPLACED', 'SEAT_MAP_VERSION_PUBLISHED') THEN
            RAISE EXCEPTION 'simulated audit failure';
          END IF;
          RETURN NEW;
        END; $$`);
      await db(t.app).$executeRawUnsafe(
        'CREATE TRIGGER test_fail_seat_map_audit BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION test_fail_seat_map_audit()',
      );
      try {
        expect(
          (
            await api.post(`/seat-maps/${map.id}/versions/${draft.id}/cells`, {
              cells: basicLayout('7'),
            })
          ).status,
        ).toBe(500);
        expect(await cellsOf(draft.id)).toEqual(before);
        expect(
          (await api.post(`/seat-maps/${map.id}/versions/${draft.id}/publish`, {})).status,
        ).toBe(500);
        // Neither the retirement of v1 nor the publication of v2 survived.
        expect((await versionOf(published)).status).toBe('PUBLISHED');
        expect((await versionOf(draft.id)).status).toBe('DRAFT');
        expect(
          await db(t.app).auditEvent.count({
            where: { resourceId: published, action: 'SEAT_MAP_VERSION_RETIRED' },
          }),
        ).toBe(0);
      } finally {
        await db(t.app).$executeRawUnsafe('DROP TRIGGER test_fail_seat_map_audit ON audit_event');
        await db(t.app).$executeRawUnsafe('DROP FUNCTION test_fail_seat_map_audit()');
      }
      expect((await api.post(`/seat-maps/${map.id}/versions/${draft.id}/publish`, {})).status).toBe(
        200,
      );
    });
  });

  describe('concurrency', () => {
    it('two concurrent draft creations: exactly one draft', async () => {
      const map = await createSeatMap(adminApi(admin));
      const results = await Promise.all([
        adminApi(admin).post(`/seat-maps/${map.id}/versions`, {}),
        adminApi(manager).post(`/seat-maps/${map.id}/versions`, {}),
      ]);
      expect(results.map((response) => response.status).sort()).toEqual([201, 409]);
      // Refused by the service under the seat map lock, not by the index.
      expect(results.find((response) => response.status === 409)?.body.code).toBe(
        'SEAT_MAP_DRAFT_ALREADY_EXISTS',
      );
      expect(
        await db(t.app).seatMapVersion.count({ where: { seatMapId: map.id, status: 'DRAFT' } }),
      ).toBe(1);
    });

    it('two concurrent publications: exactly one PUBLISHED, one consistent retirement', async () => {
      const { api, map, versionId } = await publishedSeatMap(admin);
      const draft = await createDraft(api, map.id);
      await api.post(`/seat-maps/${map.id}/versions/${draft.id}/cells`, {
        cells: basicLayout('2'),
      });
      const path = `/seat-maps/${map.id}/versions/${draft.id}/publish`;
      const results = await Promise.all([
        adminApi(admin).post(path, {}),
        adminApi(manager).post(path, {}),
      ]);
      expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
      const versions = await db(t.app).seatMapVersion.findMany({
        where: { seatMapId: map.id },
        orderBy: { version: 'asc' },
      });
      expect(versions.map((version) => version.status)).toEqual(['RETIRED', 'PUBLISHED']);
      expect(versions[0]?.id).toBe(versionId);
      expect(
        await db(t.app).auditEvent.count({
          where: { resourceId: versionId, action: 'SEAT_MAP_VERSION_RETIRED' },
        }),
      ).toBe(1);
    });

    it('two concurrent cell replacements never produce a mix', async () => {
      const api = adminApi(admin);
      const map = await createSeatMap(api);
      const draft = await createDraft(api, map.id);
      const path = `/seat-maps/${map.id}/versions/${draft.id}/cells`;
      const results = await Promise.all([
        adminApi(admin).post(path, { cells: basicLayout('A') }),
        adminApi(manager).post(path, { cells: basicLayout('B') }),
      ]);
      expect(results.map((response) => response.status)).toEqual([200, 200]);
      const labels = (await cellsOf(draft.id)).map((cell) => cell.seatLabel).filter(Boolean);
      expect([
        ['AA', 'AB'],
        ['BA', 'BB'],
      ]).toContainEqual(labels);
    });

    it('publication racing a cell replacement publishes exactly one complete layout', async () => {
      for (let round = 0; round < 3; round += 1) {
        const api = adminApi(admin);
        const map = await createSeatMap(api);
        const draft = await createDraft(api, map.id);
        await api.post(`/seat-maps/${map.id}/versions/${draft.id}/cells`, {
          cells: basicLayout('A'),
        });
        const [publish, replace] = await Promise.all([
          adminApi(admin).post(`/seat-maps/${map.id}/versions/${draft.id}/publish`, {}),
          adminApi(manager).post(`/seat-maps/${map.id}/versions/${draft.id}/cells`, {
            cells: basicLayout('B'),
          }),
        ]);
        expect(publish.status).toBe(200);
        expect([200, 409]).toContain(replace.status);
        const labels = (await cellsOf(draft.id)).map((cell) => cell.seatLabel).filter(Boolean);
        expect(labels).toEqual(replace.status === 200 ? ['BA', 'BB'] : ['AA', 'AB']);
        expect((await versionOf(draft.id)).status).toBe('PUBLISHED');
      }
    });
  });
});
