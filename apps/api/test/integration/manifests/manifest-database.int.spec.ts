import { AuthIdentityStatus } from '@euroteranga/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  generateManifestReference,
  MANIFEST_SCHEMA_VERSION,
} from '../../../src/manifests/manifest-rules.js';
import { createIdentity, db } from '../../support/auth-helpers.js';
import { bookableFixture } from '../../support/booking-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

describe('passenger manifest PostgreSQL invariants', () => {
  let t: TestApp;
  let activeStaffId: string;

  beforeAll(async () => {
    t = await startTestApp(integrationEnv());
    activeStaffId = (await createIdentity(t.app, { realm: 'staff' })).id;
  }, 30_000);

  afterAll(async () => {
    await t.app.close();
  });

  const data = (tripId: string, generatedByIdentityId: string, version: number) => ({
    reference: generateManifestReference(),
    tripId,
    version,
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    contentHash: 'a'.repeat(64),
    passengerCount: 0,
    boardedCount: 0,
    snapshot: {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      trip: { reference: 'DB-INVARIANT' },
      passengers: [],
    },
    generatedByIdentityId,
  });

  it('is append-only and takes generated_at from the database clock', async () => {
    const fixture = await bookableFixture(t.app);
    const row = await db(t.app).passengerManifest.create({
      data: {
        ...data(fixture.tripId, activeStaffId, 1),
        generatedAt: new Date('2000-01-01T00:00:00.000Z'),
      },
    });
    expect(row.generatedAt.getTime()).toBeGreaterThan(Date.now() - 10_000);
    await expect(
      db(t.app).passengerManifest.update({
        where: { id: row.id },
        data: { contentHash: 'b'.repeat(64) },
      }),
    ).rejects.toThrow(/append-only/u);
    await expect(db(t.app).passengerManifest.delete({ where: { id: row.id } })).rejects.toThrow(
      /append-only/u,
    );
    await expect(
      db(t.app).$executeRawUnsafe('TRUNCATE TABLE "passenger_manifest"'),
    ).rejects.toThrow(/cannot be truncated/u);
    expect(await db(t.app).passengerManifest.findUnique({ where: { id: row.id } })).not.toBeNull();
  });

  it('requires an ACTIVE STAFF generator and a SCHEDULED trip', async () => {
    const scheduled = await bookableFixture(t.app);
    const inactive = await createIdentity(t.app, {
      realm: 'staff',
      status: AuthIdentityStatus.SUSPENDED,
    });
    const customer = await createIdentity(t.app, { realm: 'customer' });
    await expect(
      db(t.app).passengerManifest.create({ data: data(scheduled.tripId, inactive.id, 1) }),
    ).rejects.toThrow(/active STAFF/u);
    await expect(
      db(t.app).passengerManifest.create({ data: data(scheduled.tripId, customer.id, 1) }),
    ).rejects.toThrow(/active STAFF/u);

    const draft = await bookableFixture(t.app, { status: 'DRAFT' });
    await expect(
      db(t.app).passengerManifest.create({ data: data(draft.tripId, activeStaffId, 1) }),
    ).rejects.toThrow(/scheduled trip/u);
    const cancelled = await bookableFixture(t.app);
    await db(t.app).trip.update({
      where: { id: cancelled.tripId },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
    await expect(
      db(t.app).passengerManifest.create({ data: data(cancelled.tripId, activeStaffId, 1) }),
    ).rejects.toThrow(/scheduled trip/u);
  });

  it('rejects version gaps and duplicate/stale versions', async () => {
    const fixture = await bookableFixture(t.app);
    await expect(
      db(t.app).passengerManifest.create({ data: data(fixture.tripId, activeStaffId, 2) }),
    ).rejects.toThrow(/version must be 1/u);
    await db(t.app).passengerManifest.create({ data: data(fixture.tripId, activeStaffId, 1) });
    await expect(
      db(t.app).passengerManifest.create({ data: data(fixture.tripId, activeStaffId, 1) }),
    ).rejects.toThrow(/version must be 2/u);
    await expect(
      db(t.app).passengerManifest.create({ data: data(fixture.tripId, activeStaffId, 3) }),
    ).rejects.toThrow(/version must be 2/u);
    await db(t.app).passengerManifest.create({ data: data(fixture.tripId, activeStaffId, 2) });
    expect(
      (
        await db(t.app).passengerManifest.findMany({
          where: { tripId: fixture.tripId },
          orderBy: { version: 'asc' },
        })
      ).map((row) => row.version),
    ).toEqual([1, 2]);
  });

  it('keeps concurrent generations contiguous under the trip row lock', async () => {
    const fixture = await bookableFixture(t.app);
    await Promise.all(
      Array.from({ length: 6 }, async () =>
        db(t.app).$transaction(async (tx) => {
          await tx.$queryRaw`
            SELECT "id" FROM "trip" WHERE "id" = ${fixture.tripId}::uuid FOR UPDATE
          `;
          const latest = await tx.passengerManifest.aggregate({
            where: { tripId: fixture.tripId },
            _max: { version: true },
          });
          return tx.passengerManifest.create({
            data: data(fixture.tripId, activeStaffId, (latest._max.version ?? 0) + 1),
          });
        }),
      ),
    );
    const rows = await db(t.app).passengerManifest.findMany({
      where: { tripId: fixture.tripId },
      orderBy: { version: 'asc' },
      select: { version: true, reference: true },
    });
    expect(rows.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(new Set(rows.map((row) => row.reference)).size).toBe(6);
  }, 30_000);

  it('enforces formats, counts and an object snapshot', async () => {
    const fixture = await bookableFixture(t.app);
    const invalidRows = [
      { ...data(fixture.tripId, activeStaffId, 1), reference: 'ETM-BAD' },
      { ...data(fixture.tripId, activeStaffId, 1), schemaVersion: 'manifest/0' },
      { ...data(fixture.tripId, activeStaffId, 1), contentHash: 'A'.repeat(64) },
      { ...data(fixture.tripId, activeStaffId, 1), passengerCount: -1 },
      { ...data(fixture.tripId, activeStaffId, 1), boardedCount: 1 },
      { ...data(fixture.tripId, activeStaffId, 1), snapshot: [] },
    ];
    for (const invalid of invalidRows) {
      await expect(db(t.app).passengerManifest.create({ data: invalid })).rejects.toThrow();
    }
    expect(await db(t.app).passengerManifest.count({ where: { tripId: fixture.tripId } })).toBe(0);
  });
});
