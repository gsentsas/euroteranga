import { randomBytes } from 'node:crypto';
import type { ApiEnv } from '@euroteranga/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TrackingService } from '../../../src/tracking/tracking.service.js';
import {
  adminApi,
  isolatedDatabase,
  staffActor,
  type StaffActor,
} from '../../support/admin-helpers.js';
import { client, createIdentity, csrfToken, db, loginCookie } from '../../support/auth-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

interface CrewActor {
  id: string;
  cookie: string;
  csrf: string;
  http: ReturnType<typeof client>;
}

interface TrackingNetwork {
  routeVersionId: string;
  originWaypointId: string;
  checkpointWaypointId: string;
  destinationWaypointId: string;
  foreignWaypointId: string;
}

interface TripFixture {
  id: string;
  reference: string;
  vehicleId: string;
}

describe('PR-19 tracking domain', () => {
  const run = randomBytes(4).toString('hex').toUpperCase();
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let t: TestApp;
  let env: ApiEnv;
  let manager: StaffActor;
  let auditor: StaffActor;
  let denied: StaffActor;
  let network: TrackingNetwork;
  let tripSequence = 0;

  beforeAll(async () => {
    database = await isolatedDatabase();
    env = integrationEnv({ DATABASE_URL: database.url });
    t = await startTestApp(env);
    [manager, auditor, denied] = await Promise.all([
      staffActor(t.app, ['OPS_MANAGER']),
      staffActor(t.app, ['AUDITOR']),
      staffActor(t.app, ['BOOKING_AGENT']),
    ]);
    network = await seedNetwork();
  }, 120_000);

  afterAll(async () => {
    await t?.app.close();
    await database?.drop();
  });

  async function seedNetwork(): Promise<TrackingNetwork> {
    return db(t.app).$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");

      const france = await tx.country.create({
        data: { iso2: 'FR', iso3: 'FRA', name: 'France' },
      });
      const senegal = await tx.country.create({
        data: { iso2: 'SN', iso3: 'SEN', name: 'Sénégal' },
      });
      const origin = await tx.stop.create({
        data: {
          code: 'PAR-' + run,
          name: 'Paris test',
          countryId: france.id,
          locality: 'Paris',
          latitude: 48.856613,
          longitude: 2.352222,
          timezone: 'Europe/Paris',
        },
      });
      const destination = await tx.stop.create({
        data: {
          code: 'DKR-' + run,
          name: 'Dakar test',
          countryId: senegal.id,
          locality: 'Dakar',
          latitude: 14.716677,
          longitude: -17.467686,
          timezone: 'Africa/Dakar',
        },
      });
      const checkpoint = await tx.checkpoint.create({
        data: {
          code: 'BRD-' + run,
          name: 'Checkpoint test',
          countryId: senegal.id,
          type: 'BORDER',
          terangaKind: 'BORDER',
          travellerVisible: true,
          locality: 'Frontière test',
          latitude: 14.9,
          longitude: -16.2,
          timezone: 'Africa/Dakar',
        },
      });
      const route = await tx.route.create({
        data: { code: 'RTR-' + run, name: 'Paris Dakar Tracking test' },
      });
      const routeVersion = await tx.routeVersion.create({
        data: {
          routeId: route.id,
          version: 1,
          status: 'PUBLISHED',
          publishedAt: new Date(),
        },
      });
      const originWaypoint = await tx.routeWaypoint.create({
        data: {
          routeVersionId: routeVersion.id,
          sequence: 1,
          stopId: origin.id,
          boardingAllowed: true,
        },
      });
      const checkpointWaypoint = await tx.routeWaypoint.create({
        data: {
          routeVersionId: routeVersion.id,
          sequence: 2,
          checkpointId: checkpoint.id,
        },
      });
      const destinationWaypoint = await tx.routeWaypoint.create({
        data: {
          routeVersionId: routeVersion.id,
          sequence: 3,
          stopId: destination.id,
          alightingAllowed: true,
        },
      });

      const foreignRoute = await tx.route.create({
        data: { code: 'FOR-' + run, name: 'Foreign tracking route' },
      });
      const foreignVersion = await tx.routeVersion.create({
        data: {
          routeId: foreignRoute.id,
          version: 1,
          status: 'PUBLISHED',
          publishedAt: new Date(),
        },
      });
      const foreignWaypoint = await tx.routeWaypoint.create({
        data: {
          routeVersionId: foreignVersion.id,
          sequence: 1,
          stopId: origin.id,
        },
      });

      return {
        routeVersionId: routeVersion.id,
        originWaypointId: originWaypoint.id,
        checkpointWaypointId: checkpointWaypoint.id,
        destinationWaypointId: destinationWaypoint.id,
        foreignWaypointId: foreignWaypoint.id,
      };
    });
  }

  async function tripFixture(): Promise<TripFixture> {
    tripSequence += 1;
    const suffix = String(tripSequence).padStart(2, '0');
    return db(t.app).$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
      const vehicle = await tx.vehicle.create({
        data: {
          code: 'TRK-' + run + '-' + suffix,
          manufacturer: 'Test',
          model: 'Tracking',
          status: 'ACTIVE',
          statusChangedAt: new Date(),
        },
      });
      const now = Date.now();
      const trip = await tx.trip.create({
        data: {
          reference: 'ET-TRK-' + run + '-' + suffix,
          routeVersionId: network.routeVersionId,
          vehicleId: vehicle.id,
          status: 'SCHEDULED',
          plannedDepartureAt: new Date(now + 60_000),
          plannedArrivalAt: new Date(now + 12 * 60 * 60_000),
          scheduledAt: new Date(),
        },
      });
      return { id: trip.id, reference: trip.reference, vehicleId: vehicle.id };
    });
  }

  async function crewActor(): Promise<CrewActor> {
    const identity = await createIdentity(t.app, { realm: 'crew' });
    await db(t.app).authorizationRoleAssignment.create({
      data: {
        identityId: identity.id,
        roleKey: 'CREW',
        grantReason: 'pr19 tracking test',
      },
    });
    const cookie = await loginCookie(t.app, 'crew', identity.email);
    return {
      id: identity.id,
      cookie,
      csrf: await csrfToken(t.app, 'crew', cookie),
      http: client(t.app, 'crew'),
    };
  }

  async function createDevice(trip: TripFixture, externalId: string) {
    const response = await adminApi(manager).post('/tracking/devices', {
      vehicleId: trip.vehicleId,
      providerKey: 'TESTGPS',
      externalId,
    });
    expect(response.status, response.text).toBe(201);
    return response.body as { id: string; providerKey: string; externalId: string };
  }

  async function configure(
    trip: TripFixture,
    visibility: 'HIDDEN' | 'CHECKPOINT_ONLY' | 'APPROXIMATE' | 'PRECISE',
    trackingDeviceId: string | null,
  ) {
    const response = await adminApi(manager).post('/tracking/trips/' + trip.id + '/config', {
      enabled: true,
      visibility,
      trackingDeviceId,
    });
    expect(response.status, response.text).toBe(201);
    return response;
  }

  it('enforces tracking RBAC, CSRF and trip/device compatibility with atomic audit', async () => {
    const first = await tripFixture();
    const second = await tripFixture();

    expect((await adminApi(manager).get('/tracking/trips')).status).toBe(200);
    expect((await adminApi(auditor).get('/tracking/trips')).status).toBe(200);
    expect((await adminApi(denied).get('/tracking/trips')).status).toBe(403);
    expect((await client(t.app, 'staff').get('/v1/admin/tracking/trips')).status).toBe(401);

    const noCsrf = await adminApi(manager).post(
      '/tracking/devices',
      { vehicleId: first.vehicleId, providerKey: 'TESTGPS', externalId: 'csrf-' + run },
      { csrf: null },
    );
    expect(noCsrf.status).toBe(403);

    const device = await createDevice(first, 'device-mismatch-' + run);
    expect(
      (
        await adminApi(auditor).post('/tracking/trips/' + first.id + '/config', {
          enabled: true,
          visibility: 'HIDDEN',
          trackingDeviceId: device.id,
        })
      ).status,
    ).toBe(403);

    await configure(first, 'HIDDEN', device.id);

    await expect(
      db(t.app).trip.update({
        where: { id: first.id },
        data: { vehicleId: second.vehicleId },
      }),
    ).rejects.toThrow();
    expect(
      await db(t.app).trip.findUniqueOrThrow({
        where: { id: first.id },
        select: { vehicleId: true },
      }),
    ).toEqual({ vehicleId: first.vehicleId });

    const mismatch = await adminApi(manager).post('/tracking/trips/' + second.id + '/config', {
      enabled: true,
      visibility: 'HIDDEN',
      trackingDeviceId: device.id,
    });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.code).toBe('TRACKING_DEVICE_TRIP_MISMATCH');

    await expect(
      db(t.app).tripTrackingConfig.create({
        data: {
          tripId: second.id,
          enabled: true,
          visibility: 'HIDDEN',
          trackingDeviceId: device.id,
          createdByIdentityId: manager.id,
          updatedByIdentityId: manager.id,
        },
      }),
    ).rejects.toThrow();

    expect(
      await db(t.app).auditEvent.count({
        where: {
          action: 'TRACKING_CONFIG_CREATED',
          resourceType: 'trip_tracking_config',
          resourceId: second.id,
        },
      }),
    ).toBe(0);
    expect(
      await db(t.app).auditEvent.count({
        where: {
          action: 'TRACKING_CONFIG_CREATED',
          resourceType: 'trip_tracking_config',
          resourceId: first.id,
        },
      }),
    ).toBe(1);
  }, 120_000);

  it('keeps observations append-only and idempotent with route and timestamp validation', async () => {
    const trip = await tripFixture();
    const eventId = 'tracking-' + run + '-idem';
    const observedAt = new Date().toISOString();
    const body = {
      source: 'CHECKPOINT',
      clientEventId: eventId,
      observedAt,
      routeWaypointId: network.checkpointWaypointId,
      label: 'Passage frontière',
    };

    const first = await adminApi(manager).post(
      '/tracking/trips/' + trip.id + '/observations',
      body,
    );
    expect(first.status, first.text).toBe(201);
    expect(first.body).toMatchObject({
      created: true,
      observation: { source: 'CHECKPOINT', clientEventId: eventId },
    });

    const replay = await adminApi(manager).post(
      '/tracking/trips/' + trip.id + '/observations',
      body,
    );
    expect(replay.status, replay.text).toBe(201);
    expect(replay.body.created).toBe(false);
    expect(replay.body.observation.id).toBe(first.body.observation.id);

    const conflict = await adminApi(manager).post('/tracking/trips/' + trip.id + '/observations', {
      ...body,
      label: 'Contenu différent',
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('TRACKING_CLIENT_EVENT_ID_REUSED');

    const wrongWaypoint = await adminApi(manager).post(
      '/tracking/trips/' + trip.id + '/observations',
      {
        source: 'CHECKPOINT',
        clientEventId: 'tracking-' + run + '-wrong',
        observedAt,
        routeWaypointId: network.foreignWaypointId,
      },
    );
    expect(wrongWaypoint.status).toBe(422);
    expect(wrongWaypoint.body.code).toBe('TRACKING_WAYPOINT_INVALID');

    const future = await adminApi(manager).post('/tracking/trips/' + trip.id + '/observations', {
      source: 'OPS',
      clientEventId: 'tracking-' + run + '-future',
      observedAt: new Date(Date.now() + 6 * 60_000).toISOString(),
      label: 'Future',
    });
    expect(future.status).toBe(422);
    expect(future.body.code).toBe('TRACKING_TIMESTAMP_INVALID');

    expect(
      await db(t.app).trackingObservation.count({
        where: { tripId: trip.id, clientEventId: eventId },
      }),
    ).toBe(1);

    await expect(
      db(t.app).trackingObservation.update({
        where: { id: first.body.observation.id as string },
        data: { label: 'mutation interdite' },
      }),
    ).rejects.toThrow();
    await expect(
      db(t.app).trackingObservation.delete({
        where: { id: first.body.observation.id as string },
      }),
    ).rejects.toThrow();
    await expect(
      db(t.app).$executeRawUnsafe('TRUNCATE TABLE "tracking_observation"'),
    ).rejects.toThrow();
  }, 120_000);

  it('publishes only the configured precision and revokes opaque public capabilities', async () => {
    const trip = await tripFixture();
    const device = await createDevice(trip, 'privacy-' + run);
    await configure(trip, 'HIDDEN', device.id);

    const checkpoint = await adminApi(manager).post(
      '/tracking/trips/' + trip.id + '/observations',
      {
        source: 'CHECKPOINT',
        clientEventId: 'tracking-' + run + '-public-checkpoint',
        observedAt: new Date().toISOString(),
        routeWaypointId: network.checkpointWaypointId,
        label: 'Frontière',
      },
    );
    expect(checkpoint.status, checkpoint.text).toBe(201);

    const tracking = t.app.get(TrackingService);
    const gpsObservedAt = new Date();
    const gpsInput = {
      providerObservationId: 'provider-' + run,
      observedAt: gpsObservedAt,
      latitude: 48.856613,
      longitude: 2.352222,
      accuracyMeters: 8,
      speedKph: 82,
      headingDegrees: 190,
    };
    const gps = await tracking.ingestGps(trip.id, 'TESTGPS', device.externalId, gpsInput);
    expect(gps.created).toBe(true);

    const gpsReplay = await tracking.ingestGps(trip.id, 'TESTGPS', device.externalId, gpsInput);
    expect(gpsReplay).toMatchObject({
      created: false,
      observation: { id: gps.observation.id },
    });

    await expect(
      tracking.ingestGps(trip.id, 'TESTGPS', device.externalId, {
        ...gpsInput,
        latitude: 48.9,
      }),
    ).rejects.toMatchObject({ code: 'TRACKING_PROVIDER_EVENT_ID_REUSED' });

    expect(
      await db(t.app).trackingObservation.count({
        where: {
          providerKey: 'TESTGPS',
          providerDeviceId: device.externalId,
          providerObservationId: gpsInput.providerObservationId,
        },
      }),
    ).toBe(1);

    await configure(trip, 'HIDDEN', null);
    expect((await tracking.tripDetail(trip.id)).providerStatus).toBe('UNAVAILABLE');
    await configure(trip, 'HIDDEN', device.id);
    expect((await tracking.tripDetail(trip.id)).providerStatus).toBe('UP');

    const issued = await adminApi(manager).post('/tracking/trips/' + trip.id + '/public-tokens');
    expect(issued.status, issued.text).toBe(201);
    const token = issued.body.token as string;
    expect(token.length).toBeGreaterThan(30);

    const storedToken = await db(t.app).trackingPublicToken.findUniqueOrThrow({
      where: { id: issued.body.id as string },
      select: { tokenHash: true },
    });
    expect(storedToken.tokenHash).toHaveLength(32);
    expect(Buffer.from(storedToken.tokenHash).toString('base64url')).not.toBe(token);

    const publicHttp = client(t.app, 'staff');
    const publicPath = '/v1/tracking/' + encodeURIComponent(token);
    const hidden = await publicHttp.get(publicPath);
    expect(hidden.status).toBe(404);
    expect((await publicHttp.get('/v1/tracking/not-a-token')).status).toBe(404);

    await configure(trip, 'CHECKPOINT_ONLY', device.id);
    const checkpointOnly = await publicHttp.get(publicPath);
    expect(checkpointOnly.status, checkpointOnly.text).toBe(200);
    expect(checkpointOnly.body).toMatchObject({
      tripReference: trip.reference,
      visibility: 'CHECKPOINT_ONLY',
      providerStatus: 'UP',
      checkpoint: {
        code: 'BRD-' + run,
        name: 'Frontière',
      },
      position: null,
    });
    expect(JSON.stringify(checkpointOnly.body)).not.toContain(manager.email);
    expect(JSON.stringify(checkpointOnly.body)).not.toContain(device.externalId);
    expect(JSON.stringify(checkpointOnly.body)).not.toContain('48.856613');

    await configure(trip, 'APPROXIMATE', device.id);
    const approximate = await publicHttp.get(publicPath);
    expect(approximate.status).toBe(200);
    expect(approximate.body.position).toEqual({
      observedAt: expect.any(String),
      latitude: 48.9,
      longitude: 2.4,
      precision: 'APPROXIMATE',
    });

    await configure(trip, 'PRECISE', device.id);
    const precise = await publicHttp.get(publicPath);
    expect(precise.status).toBe(200);
    expect(precise.body.position).toMatchObject({
      latitude: 48.856613,
      longitude: 2.352222,
      precision: 'PRECISE',
      accuracyMeters: 8,
    });

    const revoked = await adminApi(manager).post(
      '/tracking/trips/' + trip.id + '/public-tokens/' + issued.body.id + '/revoke',
      { reason: 'Fin du partage de test' },
    );
    expect(revoked.status, revoked.text).toBe(201);
    expect((await publicHttp.get(publicPath)).status).toBe(404);
    expect(
      await db(t.app).auditEvent.count({
        where: {
          action: 'TRACKING_PUBLIC_TOKEN_REVOKED',
          resourceId: issued.body.id as string,
        },
      }),
    ).toBe(1);
  }, 120_000);

  it('syncs an offline Crew checkpoint on an in-progress trip exactly once with provenance', async () => {
    const trip = await tripFixture();
    const crew = await crewActor();

    const assignment = await db(t.app).crewTripAssignment.create({
      data: {
        tripId: trip.id,
        crewIdentityId: crew.id,
        assignedByIdentityId: manager.id,
      },
    });
    const deviceId = 'crew-track-' + run;
    const enrolled = await crew.http.post(
      '/v1/crew/devices/enroll',
      { deviceId, label: 'Tracking test' },
      crew.cookie,
      crew.csrf,
    );
    expect(enrolled.status, enrolled.text).toBe(201);

    await db(t.app).$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
      const authorization = await tx.departureAuthorization.create({
        data: {
          reference: `ETDA-${randomBytes(6).toString('hex').toUpperCase()}`,
          tripId: trip.id,
          version: 1,
          engineVersion: 'departure-readiness/1',
          readinessFingerprint: 'a'.repeat(64),
          readinessSnapshot: { engineVersion: 'departure-readiness/1', status: 'READY' },
          authorizedByIdentityId: manager.id,
        },
      });
      await tx.trip.update({
        where: { id: trip.id },
        data: {
          status: 'IN_PROGRESS',
          actualDepartureAt: new Date(),
          departureAuthorizationId: authorization.id,
        },
      });
    });

    const trips = await crew.http.get('/v1/crew/trips', crew.cookie);
    expect(trips.status, trips.text).toBe(200);
    const snapshot = trips.body.items.find(
      (item: { trip: { reference: string } }) => item.trip.reference === trip.reference,
    );
    expect(snapshot).toMatchObject({
      trip: {
        reference: trip.reference,
        status: 'IN_PROGRESS',
        waypoints: expect.arrayContaining([
          expect.objectContaining({
            id: network.checkpointWaypointId,
            kind: 'CHECKPOINT',
            code: 'BRD-' + run,
          }),
        ]),
      },
    });

    const clientEventId = 'tracking-' + run + '-crew';
    const body = {
      deviceId,
      events: [
        {
          clientEventId,
          type: 'TRACKING_CHECKPOINT',
          occurredAt: new Date().toISOString(),
          payload: { routeWaypointId: network.checkpointWaypointId },
        },
      ],
    };
    const first = await crew.http.post(
      '/v1/crew/trips/' + encodeURIComponent(trip.reference) + '/events/sync',
      body,
      crew.cookie,
      crew.csrf,
    );
    expect(first.status, first.text).toBe(201);
    expect(first.body.results[0]).toMatchObject({
      clientEventId,
      status: 'ACKNOWLEDGED',
      created: true,
      trackingObservationId: expect.any(String),
    });

    const replay = await crew.http.post(
      '/v1/crew/trips/' + encodeURIComponent(trip.reference) + '/events/sync',
      body,
      crew.cookie,
      crew.csrf,
    );
    expect(replay.status, replay.text).toBe(201);
    expect(replay.body.results[0]).toMatchObject({
      clientEventId,
      status: 'ACKNOWLEDGED',
      created: false,
      trackingObservationId: first.body.results[0].trackingObservationId,
    });

    const conflict = await crew.http.post(
      '/v1/crew/trips/' + encodeURIComponent(trip.reference) + '/events/sync',
      {
        ...body,
        events: [
          {
            ...body.events[0],
            payload: { routeWaypointId: network.destinationWaypointId },
          },
        ],
      },
      crew.cookie,
      crew.csrf,
    );
    expect(conflict.status, conflict.text).toBe(201);
    expect(conflict.body.results[0]).toEqual({
      clientEventId,
      status: 'CONFLICT',
      errorCode: 'TRACKING_CLIENT_EVENT_ID_REUSED',
    });

    const stored = await db(t.app).trackingObservation.findUniqueOrThrow({
      where: { tripId_clientEventId: { tripId: trip.id, clientEventId } },
      include: { crewAssignment: true, crewDevice: true },
    });
    expect(stored.source).toBe('CREW');
    expect(stored.crewAssignmentId).toBe(assignment.id);
    expect(stored.crewAssignment?.crewIdentityId).toBe(crew.id);
    expect(stored.crewDevice?.identityId).toBe(crew.id);
    expect(stored.createdByIdentityId).toBe(crew.id);

    const unassigned = await crewActor();
    const otherDevice = 'crew-unassigned-' + run;
    expect(
      (
        await unassigned.http.post(
          '/v1/crew/devices/enroll',
          { deviceId: otherDevice },
          unassigned.cookie,
          unassigned.csrf,
        )
      ).status,
    ).toBe(201);
    const refused = await unassigned.http.post(
      '/v1/crew/trips/' + encodeURIComponent(trip.reference) + '/events/sync',
      {
        deviceId: otherDevice,
        events: [
          {
            clientEventId: 'tracking-' + run + '-unassigned',
            type: 'TRACKING_CHECKPOINT',
            occurredAt: new Date().toISOString(),
            payload: { routeWaypointId: network.checkpointWaypointId },
          },
        ],
      },
      unassigned.cookie,
      unassigned.csrf,
    );
    expect(refused.status, refused.text).toBe(201);
    expect(refused.body.results[0]).toMatchObject({
      status: 'REJECTED',
      errorCode: 'TRACKING_CREW_NOT_ASSIGNED',
    });
  }, 120_000);
});
