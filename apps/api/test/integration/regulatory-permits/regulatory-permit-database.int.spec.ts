import { randomUUID } from 'node:crypto';
import { AuthIdentityStatus } from '@euroteranga/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generatePermitReference } from '../../../src/regulatory-permits/regulatory-permit-rules.js';
import { isolatedDatabase } from '../../support/admin-helpers.js';
import { createIdentity, db } from '../../support/auth-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

type RawPermit = {
  id: string;
  reference: string;
  permitType: string;
  title: string;
  issuingAuthority: string;
  authorityReference: string | null;
  jurisdictionCountryId: string | null;
  validFrom: Date;
  validUntil: Date;
  status: 'DRAFT' | 'ACTIVE' | 'REVOKED';
  scopeType: 'OPERATOR' | 'COUNTRY' | 'VEHICLE' | 'ROUTE_VERSION' | 'TRIP';
  scopeCountryId: string | null;
  vehicleId: string | null;
  routeVersionId: string | null;
  tripId: string | null;
  sourceUrl: string | null;
  sourceCheckedOn: Date | null;
  notes: string | null;
  revision: number;
  createdByIdentityId: string;
  updatedByIdentityId: string;
  activatedAt: Date | null;
  activatedByIdentityId: string | null;
  revokedAt: Date | null;
  revokedByIdentityId: string | null;
  revocationReason: string | null;
  createdAt: Date;
  updatedAt: Date;
};

describe('regulatory permit PostgreSQL invariants (isolated database)', () => {
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let t: TestApp;
  let activeStaffId: string;
  let countryId: string;
  let vehicleId: string;
  let routeVersionId: string;
  let tripId: string;
  let sequence = 0;

  beforeAll(async () => {
    database = await isolatedDatabase();
    t = await startTestApp(integrationEnv({ DATABASE_URL: database.url }));
    activeStaffId = (await createIdentity(t.app, { realm: 'staff' })).id;
    countryId = (
      await db(t.app).country.create({
        data: { iso2: 'QD', iso3: 'QDD', name: 'Pays invariants permis' },
      })
    ).id;
    vehicleId = (
      await db(t.app).vehicle.create({
        data: { code: 'VH_PERMIT_DB', manufacturer: 'Synthétique', model: 'Synthétique' },
      })
    ).id;
    const route = await db(t.app).route.create({
      data: { code: 'RT_PERMIT_DB', name: 'Route invariants permis' },
    });
    const routeVersion = await db(t.app).routeVersion.create({
      data: { routeId: route.id, version: 1 },
    });
    routeVersionId = routeVersion.id;
    const [origin, destination] = await Promise.all([
      db(t.app).stop.create({
        data: {
          code: 'STOP_PERMIT_DB_ORIGIN',
          name: 'Origine invariants permis',
          countryId,
          locality: 'Localité synthétique',
          latitude: 1,
          longitude: 1,
          timezone: 'Etc/UTC',
        },
      }),
      db(t.app).stop.create({
        data: {
          code: 'STOP_PERMIT_DB_DESTINATION',
          name: 'Destination invariants permis',
          countryId,
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
          routeVersionId,
          sequence: 1,
          stopId: origin.id,
          boardingAllowed: true,
        },
        {
          routeVersionId,
          sequence: 2,
          stopId: destination.id,
          alightingAllowed: true,
        },
      ],
    });
    await db(t.app).routeVersion.update({
      where: { id: routeVersionId },
      data: { status: 'PUBLISHED', publishedAt: new Date() },
    });
    tripId = (
      await db(t.app).trip.create({
        data: { reference: 'ET-TEST-PERMIT-DB', routeVersionId },
      })
    ).id;
  }, 90_000);

  afterAll(async () => {
    await t?.app.close();
    await database?.drop();
  });

  const data = (overrides: Partial<RawPermit> = {}): RawPermit => {
    sequence += 1;
    const reference = generatePermitReference();
    const staleClock = new Date('2000-01-01T00:00:00.000Z');
    return {
      id: randomUUID(),
      reference,
      permitType: `SYNTHETIC_DB_${sequence}`,
      title: `Autorisation synthétique ${sequence}`,
      issuingAuthority: 'Autorité synthétique de base',
      authorityReference: `DB-${reference}`,
      jurisdictionCountryId: null,
      validFrom: new Date('2025-01-01T00:00:00.000Z'),
      validUntil: new Date('2035-12-31T00:00:00.000Z'),
      status: 'DRAFT',
      scopeType: 'OPERATOR',
      scopeCountryId: null,
      vehicleId: null,
      routeVersionId: null,
      tripId: null,
      sourceUrl: null,
      sourceCheckedOn: null,
      notes: null,
      revision: 1,
      createdByIdentityId: activeStaffId,
      updatedByIdentityId: activeStaffId,
      activatedAt: null,
      activatedByIdentityId: null,
      revokedAt: null,
      revokedByIdentityId: null,
      revocationReason: null,
      createdAt: staleClock,
      updatedAt: staleClock,
      ...overrides,
    };
  };

  async function insert(row: RawPermit): Promise<RawPermit> {
    await db(t.app).$executeRaw`
      INSERT INTO "regulatory_permit" (
        "id", "reference", "permit_type", "title", "issuing_authority",
        "authority_reference", "jurisdiction_country_id", "valid_from", "valid_until",
        "status", "scope_type", "scope_country_id", "vehicle_id", "route_version_id",
        "trip_id", "source_url", "source_checked_on", "notes", "revision",
        "created_by_identity_id", "updated_by_identity_id", "activated_at",
        "activated_by_identity_id", "revoked_at", "revoked_by_identity_id",
        "revocation_reason", "created_at", "updated_at"
      ) VALUES (
        ${row.id}::uuid, ${row.reference}, ${row.permitType}, ${row.title},
        ${row.issuingAuthority}, ${row.authorityReference}, ${row.jurisdictionCountryId}::uuid,
        ${row.validFrom}::date, ${row.validUntil}::date,
        ${row.status}::regulatory_permit_status,
        ${row.scopeType}::regulatory_permit_scope_type,
        ${row.scopeCountryId}::uuid, ${row.vehicleId}::uuid, ${row.routeVersionId}::uuid,
        ${row.tripId}::uuid, ${row.sourceUrl}, ${row.sourceCheckedOn}::date, ${row.notes},
        ${row.revision}, ${row.createdByIdentityId}::uuid, ${row.updatedByIdentityId}::uuid,
        ${row.activatedAt}, ${row.activatedByIdentityId}::uuid, ${row.revokedAt},
        ${row.revokedByIdentityId}::uuid, ${row.revocationReason}, ${row.createdAt},
        ${row.updatedAt}
      )
    `;
    return row;
  }

  async function activate(id: string, actorId = activeStaffId) {
    return db(t.app).$executeRaw`
      UPDATE "regulatory_permit"
      SET "status" = 'ACTIVE',
          "revision" = "revision" + 1,
          "updated_by_identity_id" = ${actorId}::uuid,
          "activated_by_identity_id" = ${actorId}::uuid,
          "activated_at" = ${new Date('2000-01-01T00:00:00.000Z')}
      WHERE "id" = ${id}::uuid
    `;
  }

  async function revoke(id: string, actorId = activeStaffId) {
    return db(t.app).$executeRaw`
      UPDATE "regulatory_permit"
      SET "status" = 'REVOKED',
          "revision" = "revision" + 1,
          "updated_by_identity_id" = ${actorId}::uuid,
          "revoked_by_identity_id" = ${actorId}::uuid,
          "revoked_at" = ${new Date('2000-01-01T00:00:00.000Z')},
          "revocation_reason" = 'Révocation synthétique directe'
      WHERE "id" = ${id}::uuid
    `;
  }

  it('accepts exactly one explicit subject and rejects incoherent or orphan scopes', async () => {
    const valid = [
      data({ scopeType: 'OPERATOR' }),
      data({ scopeType: 'COUNTRY', scopeCountryId: countryId }),
      data({ scopeType: 'VEHICLE', vehicleId }),
      data({ scopeType: 'ROUTE_VERSION', routeVersionId }),
      data({ scopeType: 'TRIP', tripId }),
    ];
    for (const row of valid) await insert(row);

    const incoherent = [
      data({ scopeType: 'OPERATOR', scopeCountryId: countryId }),
      data({ scopeType: 'COUNTRY' }),
      data({ scopeType: 'VEHICLE', vehicleId, tripId }),
      data({ scopeType: 'ROUTE_VERSION', routeVersionId: null }),
      data({ scopeType: 'TRIP', tripId: null }),
    ];
    for (const row of incoherent) await expect(insert(row)).rejects.toThrow();

    await expect(
      insert(data({ scopeType: 'COUNTRY', scopeCountryId: randomUUID() })),
    ).rejects.toThrow();
    await expect(insert(data({ scopeType: 'VEHICLE', vehicleId: randomUUID() }))).rejects.toThrow();
    await expect(
      insert(data({ scopeType: 'ROUTE_VERSION', routeVersionId: randomUUID() })),
    ).rejects.toThrow();
    await expect(insert(data({ scopeType: 'TRIP', tripId: randomUUID() }))).rejects.toThrow();

    await expect(db(t.app).country.delete({ where: { id: countryId } })).rejects.toThrow();
    await expect(db(t.app).vehicle.delete({ where: { id: vehicleId } })).rejects.toThrow();
  });

  it('requires ACTIVE STAFF actors for create, update, activation and revocation', async () => {
    const suspended = await createIdentity(t.app, {
      realm: 'staff',
      status: AuthIdentityStatus.SUSPENDED,
    });
    const customer = await createIdentity(t.app, { realm: 'customer' });
    await expect(
      insert(
        data({
          createdByIdentityId: suspended.id,
          updatedByIdentityId: suspended.id,
        }),
      ),
    ).rejects.toThrow(/active STAFF/u);
    await expect(
      insert(
        data({
          createdByIdentityId: customer.id,
          updatedByIdentityId: customer.id,
        }),
      ),
    ).rejects.toThrow(/active STAFF/u);
    await expect(
      insert(
        data({
          createdByIdentityId: randomUUID(),
          updatedByIdentityId: randomUUID(),
        }),
      ),
    ).rejects.toThrow();

    const draft = await insert(data());
    await expect(
      db(t.app).$executeRaw`
        UPDATE "regulatory_permit"
        SET "title" = 'Modification interdite', "revision" = 2,
            "updated_by_identity_id" = ${customer.id}::uuid
        WHERE "id" = ${draft.id}::uuid
      `,
    ).rejects.toThrow(/active STAFF/u);
    await expect(activate(draft.id, customer.id)).rejects.toThrow(/active STAFF/u);
    expect(
      await db(t.app).regulatoryPermit.findUniqueOrThrow({ where: { id: draft.id } }),
    ).toMatchObject({ status: 'DRAFT', revision: 1, title: draft.title });

    await activate(draft.id);
    await expect(revoke(draft.id, suspended.id)).rejects.toThrow(/active STAFF/u);
    expect(
      await db(t.app).regulatoryPermit.findUniqueOrThrow({ where: { id: draft.id } }),
    ).toMatchObject({ status: 'ACTIVE', revision: 2, revocationReason: null });
  });

  it('requires updated_by to match the active STAFF actor of lifecycle transitions', async () => {
    const otherActiveStaffId = (await createIdentity(t.app, { realm: 'staff' })).id;
    const draft = await insert(data());

    await expect(
      db(t.app).$executeRaw`
        UPDATE "regulatory_permit"
        SET "status" = 'ACTIVE', "revision" = 2,
            "updated_by_identity_id" = ${activeStaffId}::uuid,
            "activated_by_identity_id" = ${otherActiveStaffId}::uuid
        WHERE "id" = ${draft.id}::uuid
      `,
    ).rejects.toThrow(/activation cannot change regulatory permit content/u);

    expect(
      await db(t.app).regulatoryPermit.findUniqueOrThrow({ where: { id: draft.id } }),
    ).toMatchObject({ status: 'DRAFT', revision: 1, activatedByIdentityId: null });

    await activate(draft.id);

    await expect(
      db(t.app).$executeRaw`
        UPDATE "regulatory_permit"
        SET "status" = 'REVOKED', "revision" = 3,
            "updated_by_identity_id" = ${activeStaffId}::uuid,
            "revoked_by_identity_id" = ${otherActiveStaffId}::uuid,
            "revocation_reason" = 'Révocation avec acteurs incohérents'
        WHERE "id" = ${draft.id}::uuid
      `,
    ).rejects.toThrow(/revocation requires an unchanged active permit and a reason/u);

    expect(
      await db(t.app).regulatoryPermit.findUniqueOrThrow({ where: { id: draft.id } }),
    ).toMatchObject({
      status: 'ACTIVE',
      revision: 2,
      revokedByIdentityId: null,
      revocationReason: null,
    });
  });

  it('enforces references, dates, sources, text bounds and revision-one draft creation', async () => {
    const invalid = [
      data({ reference: 'ETRP-BAD' }),
      data({ permitType: 'lowercase' }),
      data({ title: ' title with outer spaces ' }),
      data({ issuingAuthority: '' }),
      data({ authorityReference: ' ' }),
      data({ validFrom: new Date('2030-01-02'), validUntil: new Date('2030-01-01') }),
      data({ sourceUrl: 'http://regulations.example.test/proof' }),
      data({ sourceCheckedOn: new Date('2999-01-01') }),
      data({ revision: 0 }),
      data({ revision: 2 }),
      data({ status: 'ACTIVE', activatedAt: new Date(), activatedByIdentityId: activeStaffId }),
      data({ updatedByIdentityId: randomUUID() }),
    ];
    for (const row of invalid) await expect(insert(row)).rejects.toThrow();
  });

  it('enforces lifecycle, immutable identity, exact revisions and database-owned clocks', async () => {
    const row = await insert(data());
    const inserted = await db(t.app).regulatoryPermit.findUniqueOrThrow({ where: { id: row.id } });
    expect(inserted.createdAt.getTime()).toBeGreaterThan(Date.now() - 10_000);
    expect(inserted.updatedAt.getTime()).toBeGreaterThan(Date.now() - 10_000);

    await expect(
      db(t.app).$executeRaw`
        UPDATE "regulatory_permit" SET "title" = 'Révision invalide', "revision" = 1
        WHERE "id" = ${row.id}::uuid
      `,
    ).rejects.toThrow(/revision must increase by exactly one/u);
    await expect(
      db(t.app).$executeRaw`
        UPDATE "regulatory_permit"
        SET "status" = 'REVOKED', "revision" = 2,
            "revoked_by_identity_id" = ${activeStaffId}::uuid,
            "revocation_reason" = 'Transition directe interdite'
        WHERE "id" = ${row.id}::uuid
      `,
    ).rejects.toThrow(/invalid regulatory permit lifecycle transition/u);
    await expect(
      db(t.app).$executeRaw`
        UPDATE "regulatory_permit"
        SET "status" = 'ACTIVE', "title" = 'Activation altérée', "revision" = 2,
            "activated_by_identity_id" = ${activeStaffId}::uuid
        WHERE "id" = ${row.id}::uuid
      `,
    ).rejects.toThrow(/activation cannot change/u);
    await expect(
      db(t.app).$executeRaw`
        UPDATE "regulatory_permit"
        SET "reference" = ${generatePermitReference()}, "revision" = 2
        WHERE "id" = ${row.id}::uuid
      `,
    ).rejects.toThrow(/identity is immutable/u);

    await activate(row.id);
    const active = await db(t.app).regulatoryPermit.findUniqueOrThrow({ where: { id: row.id } });
    expect(active).toMatchObject({ status: 'ACTIVE', revision: 2 });
    expect(active.activatedAt!.getTime()).toBeGreaterThan(Date.now() - 10_000);
    await expect(
      db(t.app).$executeRaw`
        UPDATE "regulatory_permit"
        SET "title" = 'Actif modifié', "revision" = 3
        WHERE "id" = ${row.id}::uuid
      `,
    ).rejects.toThrow(/invalid regulatory permit lifecycle transition/u);
    await expect(
      db(t.app).$executeRaw`
        UPDATE "regulatory_permit"
        SET "status" = 'DRAFT', "revision" = 3
        WHERE "id" = ${row.id}::uuid
      `,
    ).rejects.toThrow(/invalid regulatory permit lifecycle transition/u);

    await revoke(row.id);
    const revoked = await db(t.app).regulatoryPermit.findUniqueOrThrow({ where: { id: row.id } });
    expect(revoked).toMatchObject({
      status: 'REVOKED',
      revision: 3,
      revocationReason: 'Révocation synthétique directe',
    });
    expect(revoked.revokedAt!.getTime()).toBeGreaterThan(Date.now() - 10_000);
    await expect(
      db(t.app).$executeRaw`
        UPDATE "regulatory_permit" SET "notes" = 'Interdit', "revision" = 4
        WHERE "id" = ${row.id}::uuid
      `,
    ).rejects.toThrow(/revoked regulatory permits are immutable/u);
    await expect(db(t.app).regulatoryPermit.delete({ where: { id: row.id } })).rejects.toThrow(
      /cannot be deleted/u,
    );
    await expect(db(t.app).$executeRawUnsafe('TRUNCATE TABLE "regulatory_permit"')).rejects.toThrow(
      /cannot be truncated/u,
    );
    expect(await db(t.app).regulatoryPermit.findUnique({ where: { id: row.id } })).not.toBeNull();
  });

  it('rejects only strict logical duplicates with an official authority reference', async () => {
    const first = await insert(
      data({
        permitType: 'SYNTHETIC_DUPLICATE',
        issuingAuthority: 'Autorité Synthétique Unique',
        authorityReference: 'OFFICIAL-ABC',
      }),
    );
    await expect(
      insert(
        data({
          permitType: first.permitType,
          issuingAuthority: first.issuingAuthority.toLowerCase(),
          authorityReference: first.authorityReference!.toLowerCase(),
        }),
      ),
    ).rejects.toThrow();

    await insert(
      data({
        permitType: first.permitType,
        issuingAuthority: first.issuingAuthority,
        authorityReference: first.authorityReference,
        jurisdictionCountryId: countryId,
      }),
    );
    await insert(
      data({
        permitType: first.permitType,
        issuingAuthority: first.issuingAuthority,
        authorityReference: first.authorityReference,
        scopeType: 'COUNTRY',
        scopeCountryId: countryId,
      }),
    );
    await insert(
      data({
        permitType: 'SYNTHETIC_NO_OFFICIAL_REFERENCE',
        issuingAuthority: 'Autorité sans référence',
        authorityReference: null,
      }),
    );
    await insert(
      data({
        permitType: 'SYNTHETIC_NO_OFFICIAL_REFERENCE',
        issuingAuthority: 'Autorité sans référence',
        authorityReference: null,
      }),
    );
    expect(
      await db(t.app).regulatoryPermit.count({
        where: { permitType: 'SYNTHETIC_NO_OFFICIAL_REFERENCE' },
      }),
    ).toBe(2);
  });
});
