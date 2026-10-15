import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateDepartureAuthorizationReference } from '../../../src/departure-readiness/departure-readiness-rules.js';
import { isolatedDatabase } from '../../support/admin-helpers.js';
import { createIdentity, db } from '../../support/auth-helpers.js';
import { bookableFixture } from '../../support/booking-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

describe('departure readiness PostgreSQL invariants (isolated database)', () => {
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let t: TestApp;
  let staffId: string;

  beforeAll(async () => {
    database = await isolatedDatabase();
    t = await startTestApp(integrationEnv({ DATABASE_URL: database.url }));
    staffId = (await createIdentity(t.app, { realm: 'staff' })).id;
  }, 90_000);

  afterAll(async () => {
    await t?.app.close();
    await database?.drop();
  });

  async function scheduledTrip() {
    const fixture = await bookableFixture(t.app);
    const vehicle = await db(t.app).vehicle.create({
      data: {
        code: `VH_DB_${randomUUID().slice(0, 8).toUpperCase()}`,
        manufacturer: 'Synthétique',
        model: 'DB',
        seatMapVersionId: fixture.seatMapVersionId,
      },
    });
    await db(t.app).vehicle.update({ where: { id: vehicle.id }, data: { status: 'ACTIVE' } });
    await db(t.app).trip.update({ where: { id: fixture.tripId }, data: { vehicleId: vehicle.id } });
    return { ...fixture, vehicleId: vehicle.id };
  }

  async function authorization(tripId: string, version = 1) {
    const stale = new Date('2000-01-01T00:00:00.000Z');
    return db(t.app).departureAuthorization.create({
      data: {
        reference: generateDepartureAuthorizationReference(),
        tripId,
        version,
        engineVersion: 'departure-readiness/1',
        readinessFingerprint: 'ab'.repeat(32),
        readinessSnapshot: { engineVersion: 'departure-readiness/1', status: 'READY' },
        authorizedByIdentityId: staffId,
        authorizedAt: stale,
      },
    });
  }

  it('owns authorization clocks/versioning and keeps authorizations append-only', async () => {
    const trip = await scheduledTrip();
    await expect(authorization(trip.tripId, 2)).rejects.toThrow(/version must be 1/i);
    const before = Date.now();
    const first = await authorization(trip.tripId);
    expect(first.authorizedAt.getTime()).toBeGreaterThanOrEqual(before - 2_000);
    expect(first.authorizedAt.getUTCFullYear()).not.toBe(2000);
    await expect(
      db(t.app).departureAuthorization.update({
        where: { id: first.id },
        data: { readinessFingerprint: 'cd'.repeat(32) },
      }),
    ).rejects.toThrow(/append-only/i);
    await expect(
      db(t.app).departureAuthorization.delete({ where: { id: first.id } }),
    ).rejects.toThrow(/append-only/i);
    const second = await authorization(trip.tripId, 2);
    expect(second.version).toBe(2);
  });

  it('requires active STAFF and a scheduled trip for authorization', async () => {
    const trip = await scheduledTrip();
    const customer = await createIdentity(t.app, { realm: 'customer' });
    await expect(
      db(t.app).departureAuthorization.create({
        data: {
          reference: generateDepartureAuthorizationReference(),
          tripId: trip.tripId,
          version: 1,
          engineVersion: 'departure-readiness/1',
          readinessFingerprint: 'ab'.repeat(32),
          readinessSnapshot: { engineVersion: 'departure-readiness/1', status: 'READY' },
          authorizedByIdentityId: customer.id,
        },
      }),
    ).rejects.toThrow(/active STAFF/i);
    await db(t.app)
      .trip.update({
        where: { id: trip.tripId },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      })
      .catch(() => undefined);
    const state = await db(t.app).trip.findUniqueOrThrow({ where: { id: trip.tripId } });
    if (state.status === 'CANCELLED') {
      await expect(authorization(trip.tripId)).rejects.toThrow(/scheduled trip/i);
    }
  });

  it('owns actual clocks, requires the latest authorization and enforces SCHEDULED -> IN_PROGRESS -> COMPLETED', async () => {
    const trip = await scheduledTrip();
    const first = await authorization(trip.tripId, 1);
    const latest = await authorization(trip.tripId, 2);
    await expect(
      db(t.app).trip.update({
        where: { id: trip.tripId },
        data: { status: 'IN_PROGRESS', departureAuthorizationId: first.id },
      }),
    ).rejects.toThrow(/latest authorization/i);

    const staleClock = new Date('2000-01-01T00:00:00.000Z');
    const departed = await db(t.app).trip.update({
      where: { id: trip.tripId },
      data: {
        status: 'IN_PROGRESS',
        departureAuthorizationId: latest.id,
        actualDepartureAt: staleClock,
      },
    });
    expect(departed.status).toBe('IN_PROGRESS');
    expect(departed.actualDepartureAt!.getUTCFullYear()).not.toBe(2000);
    expect(departed.actualArrivalAt).toBeNull();

    await expect(
      db(t.app).trip.update({ where: { id: trip.tripId }, data: { vehicleId: null } }),
    ).rejects.toThrow(/vehicle.*frozen|in progress/i);

    const completed = await db(t.app).trip.update({
      where: { id: trip.tripId },
      data: { status: 'COMPLETED', actualArrivalAt: staleClock },
    });
    expect(completed.status).toBe('COMPLETED');
    expect(completed.actualArrivalAt!.getUTCFullYear()).not.toBe(2000);
    expect(completed.actualArrivalAt!.getTime()).toBeGreaterThanOrEqual(
      completed.actualDepartureAt!.getTime(),
    );
    await expect(
      db(t.app).trip.update({ where: { id: trip.tripId }, data: { status: 'CANCELLED' } }),
    ).rejects.toThrow(/completed.*immutable/i);
  });

  it('keeps permit policies versioned, explicit and immutable after publication', async () => {
    const trip = await scheduledTrip();
    const draft = await db(t.app).departurePermitPolicy.create({
      data: { tripId: trip.tripId, version: 1, schemaVersion: 'departure-permit-policy/1' },
    });
    const published = await db(t.app).departurePermitPolicy.update({
      where: { id: draft.id },
      data: {
        status: 'PUBLISHED',
        contentHash: 'cd'.repeat(32),
        requirementCount: 0,
        publishedByIdentityId: staffId,
        publishedAt: new Date('2000-01-01T00:00:00.000Z'),
      },
    });
    expect(published.requirementCount).toBe(0);
    expect(published.publishedAt!.getUTCFullYear()).not.toBe(2000);
    await expect(
      db(t.app).departurePermitPolicy.update({
        where: { id: draft.id },
        data: { contentHash: 'ef'.repeat(32) },
      }),
    ).rejects.toThrow(/immutable/i);
    await expect(
      db(t.app).departurePermitRequirement.create({
        data: { policyId: draft.id, sequence: 1, permitType: 'SYNTHETIC', scopeType: 'TRIP' },
      }),
    ).rejects.toThrow(/before policy publication/i);
    await expect(
      db(t.app).departurePermitPolicy.delete({ where: { id: draft.id } }),
    ).rejects.toThrow(/cannot be deleted/i);
  });

  it('refuses destructive TRUNCATE of departure history', async () => {
    // FK dependencies may reject the parent histories before their own trigger,
    // which is an equally strong earlier database barrier.
    await expect(
      db(t.app).$executeRawUnsafe('TRUNCATE TABLE "departure_authorization"'),
    ).rejects.toThrow();
    await expect(
      db(t.app).$executeRawUnsafe('TRUNCATE TABLE "departure_permit_policy"'),
    ).rejects.toThrow();
    // The leaf requirement table reaches the PR-17 no-truncate trigger itself.
    await expect(
      db(t.app).$executeRawUnsafe('TRUNCATE TABLE "departure_permit_requirement"'),
    ).rejects.toThrow(/cannot be truncated/i);
  });
});
