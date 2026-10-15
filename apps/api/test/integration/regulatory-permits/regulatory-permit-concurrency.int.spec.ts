import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isolatedDatabase, staffActor, type StaffActor } from '../../support/admin-helpers.js';
import { db } from '../../support/auth-helpers.js';
import { regulatoryPermitApi, syntheticPermit } from '../../support/regulatory-permit-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

/** Real PostgreSQL races against the permit row lock and logical unique index. */
describe('regulatory permit concurrency (isolated database)', () => {
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let t: TestApp;
  let manager: StaffActor;
  let director: StaffActor;
  let sequence = 0;

  beforeAll(async () => {
    database = await isolatedDatabase();
    t = await startTestApp(integrationEnv({ DATABASE_URL: database.url }));
    [manager, director] = await Promise.all([
      staffActor(t.app, ['OPS_MANAGER']),
      staffActor(t.app, ['DIRECTOR']),
    ]);
  }, 90_000);

  afterAll(async () => {
    await t?.app.close();
    await database?.drop();
  });

  async function draft(overrides: Record<string, unknown> = {}) {
    sequence += 1;
    const response = await regulatoryPermitApi(manager).create(
      syntheticPermit({
        permitType: `SYNTHETIC_RACE_${sequence}`,
        authorityReference: `RACE-${sequence}`,
        ...overrides,
      }),
    );
    if (response.status !== 201) {
      throw new Error(`race fixture failed: ${response.status} ${response.text}`);
    }
    return response.body as { reference: string; revision: number };
  }

  const statuses = (responses: Array<{ status: number }>) =>
    responses.map((response) => response.status).sort((left, right) => left - right);

  it('serializes double activation so exactly one transition and audit event apply', async () => {
    const permit = await draft();
    const [managerCsrf, directorCsrf] = await Promise.all([manager.csrf(), director.csrf()]);
    const responses = await Promise.all([
      regulatoryPermitApi(manager).activate(permit.reference, 1, { csrf: managerCsrf }),
      regulatoryPermitApi(director).activate(permit.reference, 1, { csrf: directorCsrf }),
    ]);
    expect(statuses(responses)).toEqual([200, 409]);
    expect(responses.find((response) => response.status === 409)!.body.code).toBe(
      'REGULATORY_PERMIT_REVISION_CONFLICT',
    );
    const row = await db(t.app).regulatoryPermit.findUniqueOrThrow({
      where: { reference: permit.reference },
    });
    expect(row).toMatchObject({ status: 'ACTIVE', revision: 2 });
    expect(
      await db(t.app).auditEvent.count({
        where: {
          resourceId: row.id,
          action: 'REGULATORY_PERMIT_ACTIVATED',
        },
      }),
    ).toBe(1);
  });

  it('keeps activation racing revocation in one coherent terminal progression', async () => {
    const permit = await draft();
    expect((await regulatoryPermitApi(manager).activate(permit.reference, 1)).status).toBe(200);
    const [managerCsrf, directorCsrf] = await Promise.all([manager.csrf(), director.csrf()]);
    const responses = await Promise.all([
      regulatoryPermitApi(manager).activate(permit.reference, 2, { csrf: managerCsrf }),
      regulatoryPermitApi(director).revoke(
        permit.reference,
        2,
        'Révocation concurrente synthétique',
        { csrf: directorCsrf },
      ),
    ]);
    expect(statuses(responses)).toEqual([200, 409]);
    expect(['REGULATORY_PERMIT_NOT_DRAFT', 'REGULATORY_PERMIT_REVISION_CONFLICT']).toContain(
      responses.find((response) => response.status === 409)!.body.code,
    );
    const row = await db(t.app).regulatoryPermit.findUniqueOrThrow({
      where: { reference: permit.reference },
    });
    expect(row).toMatchObject({
      status: 'REVOKED',
      revision: 3,
      revocationReason: 'Révocation concurrente synthétique',
    });
    expect(
      await db(t.app).auditEvent.count({
        where: { resourceId: row.id, action: 'REGULATORY_PERMIT_REVOKED' },
      }),
    ).toBe(1);
  });

  it('serializes double revocation so exactly one terminal transition and audit event apply', async () => {
    const permit = await draft();
    expect((await regulatoryPermitApi(manager).activate(permit.reference, 1)).status).toBe(200);
    const [managerCsrf, directorCsrf] = await Promise.all([manager.csrf(), director.csrf()]);
    const reasons = [
      'Révocation concurrente A synthétique',
      'Révocation concurrente B synthétique',
    ];
    const responses = await Promise.all([
      regulatoryPermitApi(manager).revoke(permit.reference, 2, reasons[0]!, {
        csrf: managerCsrf,
      }),
      regulatoryPermitApi(director).revoke(permit.reference, 2, reasons[1]!, {
        csrf: directorCsrf,
      }),
    ]);
    expect(statuses(responses)).toEqual([200, 409]);
    expect(responses.find((response) => response.status === 409)!.body.code).toBe(
      'REGULATORY_PERMIT_REVISION_CONFLICT',
    );
    const row = await db(t.app).regulatoryPermit.findUniqueOrThrow({
      where: { reference: permit.reference },
    });
    expect(row.status).toBe('REVOKED');
    expect(row.revision).toBe(3);
    expect(reasons).toContain(row.revocationReason);
    expect(
      await db(t.app).auditEvent.count({
        where: { resourceId: row.id, action: 'REGULATORY_PERMIT_REVOKED' },
      }),
    ).toBe(1);
  });

  it('detects two concurrent draft modifications with the optimistic revision', async () => {
    const permit = await draft();
    const [managerCsrf, directorCsrf] = await Promise.all([manager.csrf(), director.csrf()]);
    const responses = await Promise.all([
      regulatoryPermitApi(manager).update(
        permit.reference,
        { expectedRevision: 1, title: 'Titre concurrent A' },
        { csrf: managerCsrf },
      ),
      regulatoryPermitApi(director).update(
        permit.reference,
        { expectedRevision: 1, title: 'Titre concurrent B' },
        { csrf: directorCsrf },
      ),
    ]);
    expect(statuses(responses)).toEqual([200, 409]);
    expect(responses.find((response) => response.status === 409)!.body.code).toBe(
      'REGULATORY_PERMIT_REVISION_CONFLICT',
    );
    const winner = responses.find((response) => response.status === 200)!;
    const row = await db(t.app).regulatoryPermit.findUniqueOrThrow({
      where: { reference: permit.reference },
    });
    expect(row).toMatchObject({ revision: 2, title: winner.body.title as string });
    expect(
      await db(t.app).auditEvent.count({
        where: { resourceId: row.id, action: 'REGULATORY_PERMIT_UPDATED' },
      }),
    ).toBe(1);
  });

  it('lets the logical unique index choose one winner for concurrent duplicate creation', async () => {
    const input = syntheticPermit({
      permitType: 'SYNTHETIC_CONCURRENT_DUPLICATE',
      issuingAuthority: 'Autorité synthétique concurrence',
      authorityReference: 'CONCURRENT-DUPLICATE-001',
      scope: { type: 'OPERATOR' },
    });
    const [managerCsrf, directorCsrf] = await Promise.all([manager.csrf(), director.csrf()]);
    const responses = await Promise.all([
      regulatoryPermitApi(manager).create(input, { csrf: managerCsrf }),
      regulatoryPermitApi(director).create(input, { csrf: directorCsrf }),
    ]);
    expect(statuses(responses)).toEqual([201, 409]);
    expect(responses.find((response) => response.status === 409)!.body.code).toBe(
      'REGULATORY_PERMIT_DUPLICATE',
    );
    const rows = await db(t.app).regulatoryPermit.findMany({
      where: { permitType: 'SYNTHETIC_CONCURRENT_DUPLICATE' },
      select: { id: true, reference: true },
    });
    expect(rows).toHaveLength(1);
    expect(
      await db(t.app).auditEvent.count({
        where: { resourceId: rows[0]!.id, action: 'REGULATORY_PERMIT_CREATED' },
      }),
    ).toBe(1);
  });

  it('serializes a validity edit racing activation without mixing both writes', async () => {
    const permit = await draft({ validUntil: '2035-12-31' });
    const [managerCsrf, directorCsrf] = await Promise.all([manager.csrf(), director.csrf()]);
    const responses = await Promise.all([
      regulatoryPermitApi(manager).update(
        permit.reference,
        { expectedRevision: 1, validUntil: '2040-12-31' },
        { csrf: managerCsrf },
      ),
      regulatoryPermitApi(director).activate(permit.reference, 1, { csrf: directorCsrf }),
    ]);
    expect(statuses(responses)).toEqual([200, 409]);
    expect(responses.find((response) => response.status === 409)!.body.code).toBe(
      'REGULATORY_PERMIT_REVISION_CONFLICT',
    );
    const row = await db(t.app).regulatoryPermit.findUniqueOrThrow({
      where: { reference: permit.reference },
    });
    expect(row.revision).toBe(2);
    if (row.status === 'ACTIVE') {
      expect(row.validUntil).toEqual(new Date('2035-12-31T00:00:00.000Z'));
    } else {
      expect(row.status).toBe('DRAFT');
      expect(row.validUntil).toEqual(new Date('2040-12-31T00:00:00.000Z'));
    }
    const mutationActions = await db(t.app).auditEvent.findMany({
      where: {
        resourceId: row.id,
        action: { in: ['REGULATORY_PERMIT_UPDATED', 'REGULATORY_PERMIT_ACTIVATED'] },
      },
      select: { action: true },
    });
    expect(mutationActions).toHaveLength(1);
  });
});
