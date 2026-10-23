import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminApi,
  isolatedDatabase,
  staffActor,
  type StaffActor,
} from '../../support/admin-helpers.js';
import {
  bookableFixture,
  bookingApi,
  customerActor,
  holdBody,
  syntheticCountry,
  type BookableFixture,
  type CustomerActor,
} from '../../support/booking-helpers.js';
import { client, db } from '../../support/auth-helpers.js';
import { departureApi, departureFixture } from '../../support/departure-readiness-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

describe('TERANGA-COMFORT-1 traveller comfort projection', () => {
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let t: TestApp;
  let env: ReturnType<typeof integrationEnv>;
  let manager: StaffActor;
  let auditor: StaffActor;
  let denied: StaffActor;
  let director: StaffActor;
  let alice: CustomerActor;
  let bob: CustomerActor;
  let fixture: BookableFixture;
  let bookingReference: string;

  beforeAll(async () => {
    database = await isolatedDatabase();
    env = integrationEnv({
      DATABASE_URL: database.url,
      AUTH_CUSTOMER_ORIGINS: 'http://localhost:3002,http://localhost:3001',
    });
    t = await startTestApp(env);

    const countryId = await syntheticCountry(t.app);
    [manager, auditor, denied, director, alice, bob] = await Promise.all([
      staffActor(t.app, ['OPS_MANAGER']),
      staffActor(t.app, ['AUDITOR']),
      staffActor(t.app, ['BOOKING_AGENT']),
      staffActor(t.app, ['DIRECTOR']),
      customerActor(t.app),
      customerActor(t.app),
    ]);

    fixture = await bookableFixture(t.app, { countryId, withCheckpoint: true });
    expect(fixture.checkpointWaypointId).not.toBeNull();

    const checkpointWaypoint = await db(t.app).routeWaypoint.findUniqueOrThrow({
      where: { id: fixture.checkpointWaypointId! },
      select: { checkpointId: true },
    });
    await db(t.app).checkpoint.update({
      where: { id: checkpointWaypoint.checkpointId! },
      data: {
        terangaKind: 'MEAL',
        travellerVisible: true,
        suggestedDwellMinutes: 45,
        facilities: ['FOOD', 'RESTROOM'],
      },
    });

    const hold = await bookingApi(alice).post('/bookings', holdBody(fixture, 1, 5, ['1A']));
    expect(hold.status, hold.text).toBe(201);
    bookingReference = hold.body.reference as string;

    await db(t.app).$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
      await tx.booking.update({
        where: { reference: bookingReference },
        data: { confirmedAt: new Date() },
      });
    });
  }, 120_000);

  afterAll(async () => {
    await t?.app.close();
    await database?.drop();
  });

  it('enforces CUSTOMER ownership and exposes planned next pause without internal ids', async () => {
    const owner = await bookingApi(alice).get(
      '/bookings/' + encodeURIComponent(bookingReference) + '/comfort',
    );
    expect(owner.status, owner.text).toBe(200);
    expect(owner.headers['cache-control']).toBe('no-store');
    expect(owner.body).toMatchObject({
      bookingReference,
      tripReference: fixture.tripReference,
      nextPause: {
        kind: 'MEAL',
        status: 'PLANNED',
        suggestedDwellMinutes: 45,
        plannedFacilities: expect.arrayContaining(['FOOD', 'RESTROOM']),
      },
    });

    const foreign = await bookingApi(bob).get(
      '/bookings/' + encodeURIComponent(bookingReference) + '/comfort',
    );
    expect(foreign.status).toBe(404);
    expect(foreign.body.code).toBe('COMFORT_BOOKING_NOT_FOUND');

    const serialized = JSON.stringify(owner.body);
    expect(serialized).not.toContain('routeWaypointId');
    expect(serialized).not.toContain('recordedByIdentityId');
    expect(serialized).not.toContain(alice.email);
  });

  it('enforces tracking RBAC and CSRF, keeps events idempotent and audited', async () => {
    const tripId = fixture.tripId;
    const checkpointWaypointId = fixture.checkpointWaypointId!;

    expect((await adminApi(manager).get('/tracking/trips/' + tripId + '/comfort')).status).toBe(
      200,
    );
    expect((await adminApi(auditor).get('/tracking/trips/' + tripId + '/comfort')).status).toBe(
      200,
    );
    expect((await adminApi(denied).get('/tracking/trips/' + tripId + '/comfort')).status).toBe(403);

    const event = {
      clientEventId: 'comfort-integration-confirm-0001',
      routeWaypointId: checkpointWaypointId,
      type: 'CONFIRMED',
      occurredAt: new Date().toISOString(),
      actualFacilities: [],
    };

    const noCsrf = await adminApi(manager).post(
      '/tracking/trips/' + tripId + '/comfort/events',
      event,
      { csrf: null },
    );
    expect(noCsrf.status).toBe(403);

    const readOnly = await adminApi(auditor).post(
      '/tracking/trips/' + tripId + '/comfort/events',
      event,
    );
    expect(readOnly.status).toBe(403);

    const first = await adminApi(manager).post(
      '/tracking/trips/' + tripId + '/comfort/events',
      event,
    );
    expect(first.status, first.text).toBe(201);
    expect(first.body).toMatchObject({
      created: true,
      event: {
        type: 'CONFIRMED',
        routeWaypointId: checkpointWaypointId,
      },
    });

    const replay = await adminApi(manager).post(
      '/tracking/trips/' + tripId + '/comfort/events',
      event,
    );
    expect(replay.status, replay.text).toBe(201);
    expect(replay.body.created).toBe(false);
    expect(replay.body.event.id).toBe(first.body.event.id);

    const conflict = await adminApi(manager).post('/tracking/trips/' + tripId + '/comfort/events', {
      ...event,
      type: 'CANCELLED',
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('COMFORT_CLIENT_EVENT_ID_REUSED');

    expect(
      await db(t.app).auditEvent.count({
        where: {
          action: 'COMFORT_WAYPOINT_EVENT_RECORDED',
          resourceId: first.body.event.id as string,
        },
      }),
    ).toBe(1);

    await expect(
      db(t.app).comfortWaypointEvent.update({
        where: { id: first.body.event.id as string },
        data: { occurredAt: new Date(Date.now() - 60_000) },
      }),
    ).rejects.toThrow();
    await expect(
      db(t.app).comfortWaypointEvent.delete({
        where: { id: first.body.event.id as string },
      }),
    ).rejects.toThrow();
  }, 120_000);

  it('publishes traveller-safe comfort with a public tracking capability', async () => {
    const configured = await adminApi(manager).post(
      '/tracking/trips/' + fixture.tripId + '/config',
      {
        enabled: true,
        visibility: 'CHECKPOINT_ONLY',
        trackingDeviceId: null,
      },
    );
    expect(configured.status, configured.text).toBe(201);

    const issued = await adminApi(manager).post(
      '/tracking/trips/' + fixture.tripId + '/public-tokens',
    );
    expect(issued.status, issued.text).toBe(201);

    const token = issued.body.token as string;
    const publicResponse = await client(t.app, 'staff').get(
      '/v1/tracking/' + encodeURIComponent(token),
    );
    expect(publicResponse.status, publicResponse.text).toBe(200);
    expect(publicResponse.body).toMatchObject({
      tripReference: fixture.tripReference,
      visibility: 'CHECKPOINT_ONLY',
      position: null,
      comfort: {
        tripReference: fixture.tripReference,
        nextPause: {
          kind: 'MEAL',
          status: 'CONFIRMED',
          plannedFacilities: expect.arrayContaining(['FOOD', 'RESTROOM']),
        },
      },
    });

    const serialized = JSON.stringify(publicResponse.body);
    expect(serialized).not.toContain('routeWaypointId');
    expect(serialized).not.toContain('recordedByIdentityId');
    expect(serialized).not.toContain(manager.email);
    expect(serialized).not.toContain(alice.email);

  }, 120_000);

  it(
    'uses the real departure lifecycle for completed, cancelled and skipped waypoint progress',
    async () => {
      const item = await departureFixture(t.app, env, alice, director, manager);
      const departure = departureApi(manager);
  
      const policy = await departure.publishPolicy(item.tripReference, []);
      expect(policy.status, policy.text).toBe(201);
  
      const authorization = await departure.authorize(item.tripReference);
      expect(authorization.status, authorization.text).toBe(200);
  
      const departed = await departure.depart(item.tripReference);
      expect(departed.status, departed.text).toBe(200);
      expect(departed.body.trip.status).toBe('IN_PROGRESS');
  
      const trip = await db(t.app).trip.findUniqueOrThrow({
        where: { id: item.tripId },
        select: {
          routeVersion: {
            select: {
              waypoints: {
                orderBy: { sequence: 'asc' },
                select: { id: true, sequence: true },
              },
            },
          },
        },
      });
      const waypoints = trip.routeVersion.waypoints;
      expect(waypoints.length).toBeGreaterThanOrEqual(4);
  
      const completedWaypoint = waypoints[0]!;
      const cancelledWaypoint = waypoints[1]!;
      const skippedWaypoint = waypoints[2]!;
      const expectedNextWaypoint = waypoints[3]!;
  
      const completed = await adminApi(manager).post(
        '/tracking/trips/' + item.tripId + '/comfort/events',
        {
          clientEventId: 'comfort-integration-complete-0001',
          routeWaypointId: completedWaypoint.id,
          type: 'COMPLETED',
          occurredAt: new Date().toISOString(),
          actualFacilities: ['FOOD'],
        },
      );
      expect(completed.status, completed.text).toBe(201);
  
      const cancelled = await adminApi(manager).post(
        '/tracking/trips/' + item.tripId + '/comfort/events',
        {
          clientEventId: 'comfort-integration-cancel-0001',
          routeWaypointId: cancelledWaypoint.id,
          type: 'CANCELLED',
          occurredAt: new Date().toISOString(),
          actualFacilities: [],
        },
      );
      expect(cancelled.status, cancelled.text).toBe(201);
  
      const skipped = await adminApi(manager).post(
        '/tracking/trips/' + item.tripId + '/comfort/events',
        {
          clientEventId: 'comfort-integration-skip-0001',
          routeWaypointId: skippedWaypoint.id,
          type: 'SKIPPED',
          occurredAt: new Date().toISOString(),
          actualFacilities: [],
        },
      );
      expect(skipped.status, skipped.text).toBe(201);
  
      const projection = await adminApi(manager).get('/tracking/trips/' + item.tripId + '/comfort');
      expect(projection.status, projection.text).toBe(200);
      expect(projection.body).toMatchObject({
        currentStep: {
          sequence: completedWaypoint.sequence,
          status: 'COMPLETED',
          actualFacilities: ['FOOD'],
        },
        nextStep: {
          sequence: expectedNextWaypoint.sequence,
          status: 'PLANNED',
        },
        steps: expect.arrayContaining([
          expect.objectContaining({
            sequence: cancelledWaypoint.sequence,
            status: 'CANCELLED',
          }),
          expect.objectContaining({
            sequence: skippedWaypoint.sequence,
            status: 'SKIPPED',
          }),
        ]),
      });
      expect(projection.body.nextStep.sequence).toBeGreaterThan(
        projection.body.currentStep.sequence,
      );
    },
    120_000,
  );
});
