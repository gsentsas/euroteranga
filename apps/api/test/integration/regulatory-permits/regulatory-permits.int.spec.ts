import type { ApiEnv } from '@euroteranga/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isolatedDatabase, staffActor, type StaffActor } from '../../support/admin-helpers.js';
import { client, createIdentity, db, loginCookie } from '../../support/auth-helpers.js';
import { regulatoryPermitApi, syntheticPermit } from '../../support/regulatory-permit-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

describe('regulatory permit administration API (isolated database)', () => {
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let env: ApiEnv;
  let t: TestApp;
  let manager: StaffActor;
  let secondManager: StaffActor;
  let reader: StaffActor;
  let denied: StaffActor;
  let baselineReference: string;
  let country: { id: string; iso2: string };
  let vehicle: { id: string; code: string };
  let route: { id: string; code: string };
  let routeVersion: { id: string; version: number };
  let trip: { id: string; reference: string };

  beforeAll(async () => {
    database = await isolatedDatabase();
    env = integrationEnv({ DATABASE_URL: database.url });
    t = await startTestApp(env);
    [manager, secondManager, reader, denied] = await Promise.all([
      staffActor(t.app, ['OPS_MANAGER']),
      staffActor(t.app, ['DIRECTOR']),
      staffActor(t.app, ['DISPATCHER']),
      staffActor(t.app, ['FINANCE']),
    ]);

    country = await db(t.app).country.create({
      data: { iso2: 'QP', iso3: 'QPP', name: 'Pays synthétique permis' },
      select: { id: true, iso2: true },
    });
    vehicle = await db(t.app).vehicle.create({
      data: {
        code: 'VH_PERMIT_TEST',
        manufacturer: 'Constructeur synthétique',
        model: 'Modèle synthétique',
      },
      select: { id: true, code: true },
    });
    route = await db(t.app).route.create({
      data: { code: 'RT_PERMIT_TEST', name: 'Route synthétique permis' },
      select: { id: true, code: true },
    });
    routeVersion = await db(t.app).routeVersion.create({
      data: { routeId: route.id, version: 1 },
      select: { id: true, version: true },
    });
    const [origin, destination] = await Promise.all([
      db(t.app).stop.create({
        data: {
          code: 'STOP_PERMIT_ORIGIN',
          name: 'Origine synthétique permis',
          countryId: country.id,
          locality: 'Localité synthétique',
          latitude: 1,
          longitude: 1,
          timezone: 'Etc/UTC',
        },
      }),
      db(t.app).stop.create({
        data: {
          code: 'STOP_PERMIT_DESTINATION',
          name: 'Destination synthétique permis',
          countryId: country.id,
          locality: 'Localité synthétique',
          latitude: 2,
          longitude: 2,
          timezone: 'Etc/UTC',
        },
      }),
    ]);
    await db(t.app).routeWaypoint.createMany({
      data: [
        {
          routeVersionId: routeVersion.id,
          sequence: 1,
          stopId: origin.id,
          boardingAllowed: true,
        },
        {
          routeVersionId: routeVersion.id,
          sequence: 2,
          stopId: destination.id,
          alightingAllowed: true,
        },
      ],
    });
    await db(t.app).routeVersion.update({
      where: { id: routeVersion.id },
      data: { status: 'PUBLISHED', publishedAt: new Date() },
    });
    trip = await db(t.app).trip.create({
      data: { reference: 'ET-TEST-PERMIT-01', routeVersionId: routeVersion.id },
      select: { id: true, reference: true },
    });

    const baseline = await regulatoryPermitApi(manager).create(
      syntheticPermit({
        permitType: 'SYNTHETIC_BASELINE',
        authorityReference: 'BASELINE-001',
      }),
    );
    if (baseline.status !== 201) {
      throw new Error(`permit fixture failed: ${baseline.status} ${baseline.text}`);
    }
    baselineReference = baseline.body.reference as string;
  }, 90_000);

  afterAll(async () => {
    await t?.app.close();
    await database?.drop();
  });

  it('creates, edits, activates, reads and terminally revokes one permit', async () => {
    const api = regulatoryPermitApi(manager);
    const created = await api.create(
      syntheticPermit({
        permitType: 'SYNTHETIC_LIFECYCLE',
        title: ' Autorisation   de cycle ',
        issuingAuthority: ' Autorité   synthétique ',
        authorityReference: 'LIFECYCLE-001',
        jurisdictionCountryIso2: country.iso2.toLowerCase(),
        scope: { type: 'TRIP', tripReference: trip.reference.toLowerCase() },
      }),
    );
    expect(created.status, created.text).toBe(201);
    expect(created.headers['cache-control']).toBe('private, no-store');
    expect(created.body).toMatchObject({
      reference: expect.stringMatching(/^ETRP-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/u),
      permitType: 'SYNTHETIC_LIFECYCLE',
      title: 'Autorisation de cycle',
      issuingAuthority: 'Autorité synthétique',
      jurisdictionCountry: { iso2: country.iso2 },
      scope: { type: 'TRIP', trip: { reference: trip.reference } },
      status: 'DRAFT',
      validityState: 'DRAFT',
      revision: 1,
      history: [{ action: 'REGULATORY_PERMIT_CREATED', status: 'DRAFT', revision: 1 }],
    });
    const reference = created.body.reference as string;

    const updated = await api.update(reference, {
      expectedRevision: 1,
      title: 'Autorisation synthétique révisée',
      validFrom: '2026-01-01',
      validUntil: '2036-12-31',
      scope: { type: 'ROUTE_VERSION', routeCode: route.code, routeVersion: 1 },
    });
    expect(updated.status, updated.text).toBe(200);
    expect(updated.body).toMatchObject({
      title: 'Autorisation synthétique révisée',
      scope: {
        type: 'ROUTE_VERSION',
        route: { code: route.code },
        routeVersion: routeVersion.version,
      },
      status: 'DRAFT',
      revision: 2,
    });

    const activated = await api.activate(reference, 2);
    expect(activated.status, activated.text).toBe(200);
    expect(activated.body).toMatchObject({
      status: 'ACTIVE',
      validityState: 'VALID',
      revision: 3,
      activatedAt: expect.any(String),
    });
    expect(
      (await api.update(reference, { expectedRevision: 3, title: 'Interdit' })).body.code,
    ).toBe('REGULATORY_PERMIT_NOT_DRAFT');

    const detail = await regulatoryPermitApi(reader).detail(reference);
    expect(detail.status).toBe(200);
    expect(detail.body.history.map((entry: { action: string }) => entry.action)).toEqual([
      'REGULATORY_PERMIT_ACTIVATED',
      'REGULATORY_PERMIT_UPDATED',
      'REGULATORY_PERMIT_CREATED',
    ]);
    expect(JSON.stringify(detail.body.history)).not.toContain(manager.email);

    const tooShort = await api.revoke(reference, 3, 'court');
    expect(tooShort.status).toBe(400);
    const revoked = await api.revoke(reference, 3, 'Révocation synthétique suffisamment motivée');
    expect(revoked.status, revoked.text).toBe(200);
    expect(revoked.body).toMatchObject({
      status: 'REVOKED',
      validityState: 'REVOKED',
      revision: 4,
      revocationReason: 'Révocation synthétique suffisamment motivée',
      revokedAt: expect.any(String),
    });
    expect((await api.activate(reference, 4)).body.code).toBe('REGULATORY_PERMIT_NOT_DRAFT');
    expect((await api.revoke(reference, 4)).body.code).toBe('REGULATORY_PERMIT_NOT_ACTIVE');
  });

  it('separates read from manage, requires CSRF, and rejects non-STAFF sessions', async () => {
    const readApi = regulatoryPermitApi(reader);
    expect((await readApi.list('?limit=1')).status).toBe(200);
    expect((await readApi.detail(baselineReference)).status).toBe(200);
    expect((await readApi.create(syntheticPermit())).status).toBe(403);
    expect(
      (await readApi.update(baselineReference, { expectedRevision: 1, title: 'Interdit' })).status,
    ).toBe(403);
    expect((await readApi.activate(baselineReference, 1)).status).toBe(403);
    expect((await readApi.revoke(baselineReference, 1)).status).toBe(403);

    const deniedApi = regulatoryPermitApi(denied);
    expect((await deniedApi.list()).status).toBe(403);
    expect((await deniedApi.detail(baselineReference)).status).toBe(403);

    const managerApi = regulatoryPermitApi(manager);
    const before = await db(t.app).regulatoryPermit.count();
    expect((await managerApi.create(syntheticPermit(), { csrf: null })).status).toBe(403);
    expect(
      (
        await managerApi.update(
          baselineReference,
          { expectedRevision: 1, title: 'Sans CSRF' },
          { csrf: null },
        )
      ).status,
    ).toBe(403);
    expect((await managerApi.activate(baselineReference, 1, { csrf: null })).status).toBe(403);
    expect((await managerApi.revoke(baselineReference, 1, undefined, { csrf: null })).status).toBe(
      403,
    );
    expect(await db(t.app).regulatoryPermit.count()).toBe(before);

    const customer = await createIdentity(t.app, { realm: 'customer' });
    const customerCookie = await loginCookie(t.app, 'customer', customer.email);
    const customerResponse = await client(t.app, 'staff').get(
      '/v1/admin/regulatory-permits',
      customerCookie,
    );
    expect(customerResponse.status).toBe(401);

    const crew = await createIdentity(t.app, { realm: 'crew' });
    await db(t.app).authorizationRoleAssignment.create({
      data: { identityId: crew.id, roleKey: 'CREW' },
    });
    const crewCookie = await loginCookie(t.app, 'crew', crew.email);
    const crewResponse = await client(t.app, 'staff').get(
      '/v1/admin/regulatory-permits',
      crewCookie,
    );
    expect(crewResponse.status).toBe(401);
  }, 60_000);

  it('rejects unknown or incoherent scopes, dates and source checks without partial rows', async () => {
    const api = regulatoryPermitApi(manager);
    const marker = 'SYNTHETIC_INVALID';
    const invalidScopes = [
      { type: 'COUNTRY', countryIso2: 'ZZ' },
      { type: 'VEHICLE', vehicleCode: 'VH_UNKNOWN' },
      { type: 'ROUTE_VERSION', routeCode: route.code, routeVersion: 999 },
      { type: 'TRIP', tripReference: 'ET-UNKNOWN' },
    ];
    for (const scope of invalidScopes) {
      const response = await api.create(
        syntheticPermit({
          permitType: marker,
          authorityReference: `UNKNOWN-${scope.type}`,
          scope,
        }),
      );
      expect(response.status, JSON.stringify(scope)).toBe(422);
      expect(response.body.code).toBe('REGULATORY_PERMIT_SCOPE_NOT_FOUND');
    }

    const malformed = await api.create(
      syntheticPermit({ scope: { type: 'OPERATOR', tripReference: trip.reference } }),
    );
    expect(malformed.status).toBe(400);
    const reversed = await api.create(
      syntheticPermit({ validFrom: '2035-01-01', validUntil: '2034-12-31' }),
    );
    expect(reversed.status).toBe(400);
    const futureSource = await api.create(syntheticPermit({ sourceCheckedOn: '2999-01-01' }));
    expect(futureSource.status).toBe(422);
    expect(futureSource.body.code).toBe('REGULATORY_PERMIT_SOURCE_DATE_INVALID');

    const draft = await api.create(
      syntheticPermit({
        permitType: 'SYNTHETIC_CROSS_DATE',
        authorityReference: 'CROSS-DATE-001',
      }),
    );
    const invalidUpdate = await api.update(draft.body.reference as string, {
      expectedRevision: 1,
      validFrom: '2040-01-01',
    });
    expect(invalidUpdate.status).toBe(422);
    expect(invalidUpdate.body.code).toBe('REGULATORY_PERMIT_DATES_INVALID');
    expect(
      await db(t.app).regulatoryPermit.findUniqueOrThrow({
        where: { reference: draft.body.reference as string },
        select: { revision: true, validFrom: true },
      }),
    ).toMatchObject({ revision: 1, validFrom: new Date('2025-01-01T00:00:00.000Z') });
    expect(await db(t.app).regulatoryPermit.count({ where: { permitType: marker } })).toBe(0);
  });

  it('supports every referential scope, server-side filters and deterministic pagination', async () => {
    const api = regulatoryPermitApi(manager);
    const commonType = 'SYNTHETIC_PAGE';
    const inputs = [
      syntheticPermit({
        permitType: commonType,
        authorityReference: 'PAGE-OPERATOR',
        jurisdictionCountryIso2: country.iso2,
        scope: { type: 'OPERATOR' },
      }),
      syntheticPermit({
        permitType: commonType,
        authorityReference: 'PAGE-COUNTRY',
        scope: { type: 'COUNTRY', countryIso2: country.iso2 },
      }),
      syntheticPermit({
        permitType: commonType,
        authorityReference: 'PAGE-VEHICLE',
        scope: { type: 'VEHICLE', vehicleCode: vehicle.code },
      }),
      syntheticPermit({
        permitType: 'SYNTHETIC_ROUTE_FILTER',
        authorityReference: 'PAGE-ROUTE',
        scope: { type: 'ROUTE_VERSION', routeCode: route.code, routeVersion: 1 },
      }),
      syntheticPermit({
        permitType: 'SYNTHETIC_TRIP_FILTER',
        authorityReference: 'PAGE-TRIP',
        scope: { type: 'TRIP', tripReference: trip.reference },
      }),
    ];
    const created = [];
    for (const input of inputs) {
      const response = await api.create(input);
      expect(response.status, response.text).toBe(201);
      created.push(response.body as { reference: string; revision: number });
    }
    const active = await api.activate(created[0]!.reference, 1);
    expect(active.status).toBe(200);

    const first = await api.list(`?permitType=${commonType}&limit=2`);
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).toBe(first.body.items[1].reference);
    const second = await api.list(
      `?permitType=${commonType}&limit=2&cursor=${first.body.nextCursor as string}`,
    );
    expect(second.body.items).toHaveLength(1);
    expect(second.body.nextCursor).toBeNull();
    expect(
      new Set(
        [...first.body.items, ...second.body.items].map(
          (item: { reference: string }) => item.reference,
        ),
      ).size,
    ).toBe(3);

    const cases: Array<[string, string]> = [
      [`status=ACTIVE&permitType=${commonType}`, created[0]!.reference],
      [`validityState=VALID&permitType=${commonType}`, created[0]!.reference],
      [`scopeType=VEHICLE&vehicleCode=${vehicle.code}`, created[2]!.reference],
      [`country=${country.iso2}&reference=${created[1]!.reference}`, created[1]!.reference],
      [`routeCode=${route.code}&routeVersion=1`, created[3]!.reference],
      [`tripReference=${trip.reference}`, created[4]!.reference],
      [`reference=${created[4]!.reference}`, created[4]!.reference],
    ];
    for (const [query, expectedReference] of cases) {
      const response = await api.list(`?${query}`);
      expect(response.status, query).toBe(200);
      expect(response.body.items.map((item: { reference: string }) => item.reference)).toContain(
        expectedReference,
      );
    }
    expect((await api.list('?routeVersion=1')).status).toBe(400);
    expect((await api.list('?limit=101')).status).toBe(400);
    expect((await api.list('?cursor=ETRP-000000000000')).status).toBe(404);
  });

  it('audits mutations and reads with minimized snapshots and no submitted secret-like metadata', async () => {
    const secretNote = 'SYNTHETIC_PRIVATE_NOTE_8CE88A';
    const secretUrl = 'https://regulations.example.test/proof?token=SYNTHETIC_URL_SECRET_71A9';
    const api = regulatoryPermitApi(secondManager);
    const created = await api.create(
      syntheticPermit({
        permitType: 'SYNTHETIC_AUDIT',
        authorityReference: 'AUDIT-001',
        sourceUrl: secretUrl,
        notes: secretNote,
      }),
    );
    const reference = created.body.reference as string;
    expect(
      (await api.update(reference, { expectedRevision: 1, title: 'Titre audité' })).status,
    ).toBe(200);
    expect((await api.activate(reference, 2)).status).toBe(200);
    expect((await regulatoryPermitApi(reader).detail(reference)).status).toBe(200);
    expect((await regulatoryPermitApi(reader).list(`?reference=${reference}`)).status).toBe(200);
    expect((await api.revoke(reference, 3, 'Révocation synthétique auditée')).status).toBe(200);

    const permit = await db(t.app).regulatoryPermit.findUniqueOrThrow({ where: { reference } });
    const events = await db(t.app).auditEvent.findMany({
      where: {
        OR: [
          { resourceId: permit.id },
          {
            action: 'REGULATORY_PERMIT_ACCESSED',
            actorIdentityId: reader.id,
            metadata: { path: ['references'], array_contains: [reference] },
          },
        ],
      },
      orderBy: { occurredAt: 'asc' },
      select: { action: true, before: true, after: true, metadata: true },
    });
    expect(events.map((event) => event.action)).toEqual(
      expect.arrayContaining([
        'REGULATORY_PERMIT_CREATED',
        'REGULATORY_PERMIT_UPDATED',
        'REGULATORY_PERMIT_ACTIVATED',
        'REGULATORY_PERMIT_REVOKED',
        'REGULATORY_PERMIT_ACCESSED',
      ]),
    );
    const serialized = JSON.stringify(events);
    for (const forbidden of [secretNote, secretUrl, secondManager.email, manager.email]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(serialized).not.toContain('sourceUrl');
    expect(serialized).not.toContain('notes');
    expect(serialized).not.toContain('createdByIdentityId');
    expect(serialized).not.toContain('updatedByIdentityId');
  });

  it('rolls a permit mutation back when the transactional audit insert fails', async () => {
    await db(t.app).$executeRawUnsafe(`
      CREATE FUNCTION test_fail_regulatory_permit_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action LIKE 'REGULATORY_PERMIT_%' THEN
          RAISE EXCEPTION 'simulated regulatory permit audit failure';
        END IF;
        RETURN NEW;
      END; $$`);
    await db(t.app).$executeRawUnsafe(
      'CREATE TRIGGER test_fail_regulatory_permit_audit BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION test_fail_regulatory_permit_audit()',
    );
    try {
      const response = await regulatoryPermitApi(manager).create(
        syntheticPermit({
          permitType: 'SYNTHETIC_ROLLBACK',
          authorityReference: 'ROLLBACK-001',
        }),
      );
      expect(response.status).toBe(500);
      expect(
        await db(t.app).regulatoryPermit.count({
          where: { permitType: 'SYNTHETIC_ROLLBACK' },
        }),
      ).toBe(0);
    } finally {
      await db(t.app).$executeRawUnsafe(
        'DROP TRIGGER test_fail_regulatory_permit_audit ON audit_event',
      );
      await db(t.app).$executeRawUnsafe('DROP FUNCTION test_fail_regulatory_permit_audit()');
    }
    expect(
      (
        await regulatoryPermitApi(manager).create(
          syntheticPermit({
            permitType: 'SYNTHETIC_ROLLBACK',
            authorityReference: 'ROLLBACK-APPLIED',
          }),
        )
      ).status,
    ).toBe(201);
  });
});
