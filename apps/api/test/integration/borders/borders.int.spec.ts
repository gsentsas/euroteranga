import { randomBytes } from 'node:crypto';
import type { ApiEnv } from '@euroteranga/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

describe('PR-20 operational border crossings', () => {
  const run = randomBytes(4).toString('hex').toUpperCase();
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let t: TestApp;
  let env: ApiEnv;
  let ops: StaffActor;
  let denied: StaffActor;
  let tripId: string;
  let tripReference: string;
  let borderWaypointId: string;
  let nonBorderWaypointId: string;

  beforeAll(async () => {
    database = await isolatedDatabase();
    env = integrationEnv({ DATABASE_URL: database.url });
    t = await startTestApp(env);
    [ops, denied] = await Promise.all([
      staffActor(t.app, ['OPS_MANAGER']),
      staffActor(t.app, ['BOOKING_AGENT']),
    ]);
    await seed();
  }, 120_000);

  afterAll(async () => {
    await t?.app.close();
    await database?.drop();
  });

  async function seed() {
    await db(t.app).$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
      const fr = await tx.country.create({ data: { iso2: 'FR', iso3: 'FRA', name: 'France' } });
      const sn = await tx.country.create({ data: { iso2: 'SN', iso3: 'SEN', name: 'Sénégal' } });
      const start = await tx.stop.create({
        data: {
          code: 'B20A-' + run,
          name: 'Paris',
          countryId: fr.id,
          locality: 'Paris',
          latitude: 48.85,
          longitude: 2.35,
          timezone: 'Europe/Paris',
        },
      });
      const border = await tx.checkpoint.create({
        data: {
          code: 'B20B-' + run,
          name: 'Frontière test',
          countryId: sn.id,
          type: 'BORDER',
          terangaKind: 'BORDER',
          travellerVisible: true,
          locality: 'Frontière',
          latitude: 14.9,
          longitude: -16.2,
          timezone: 'Africa/Dakar',
        },
      });
      const technical = await tx.checkpoint.create({
        data: {
          code: 'B20T-' + run,
          name: 'Technique test',
          countryId: sn.id,
          type: 'TECHNICAL',
          terangaKind: 'TECHNICAL',
          travellerVisible: false,
          locality: 'Technique',
          latitude: 14.8,
          longitude: -16.1,
          timezone: 'Africa/Dakar',
        },
      });
      const route = await tx.route.create({ data: { code: 'B20R-' + run, name: 'Border route' } });
      const routeVersion = await tx.routeVersion.create({
        data: { routeId: route.id, version: 1, status: 'PUBLISHED', publishedAt: new Date() },
      });
      await tx.routeWaypoint.create({
        data: {
          routeVersionId: routeVersion.id,
          sequence: 1,
          stopId: start.id,
          boardingAllowed: true,
        },
      });
      borderWaypointId = (
        await tx.routeWaypoint.create({
          data: { routeVersionId: routeVersion.id, sequence: 2, checkpointId: border.id },
        })
      ).id;
      nonBorderWaypointId = (
        await tx.routeWaypoint.create({
          data: { routeVersionId: routeVersion.id, sequence: 3, checkpointId: technical.id },
        })
      ).id;
      const trip = await tx.trip.create({
        data: {
          reference: 'ET-B20-' + run,
          routeVersionId: routeVersion.id,
          status: 'SCHEDULED',
          plannedDepartureAt: new Date(Date.now() - 60_000),
          plannedArrivalAt: new Date(Date.now() + 8 * 60 * 60_000),
          scheduledAt: new Date(Date.now() - 10 * 60_000),
        },
      });
      const authorization = await tx.departureAuthorization.create({
        data: {
          reference: 'ETDA-' + randomBytes(6).toString('hex').toUpperCase(),
          tripId: trip.id,
          version: 1,
          engineVersion: 'departure-readiness/1',
          readinessFingerprint: 'b'.repeat(64),
          readinessSnapshot: { engineVersion: 'departure-readiness/1', status: 'READY' },
          authorizedByIdentityId: ops.id,
        },
      });
      const departedAt = new Date(Date.now() - 30_000);
      await tx.trip.update({
        where: { id: trip.id },
        data: {
          status: 'IN_PROGRESS',
          actualDepartureAt: departedAt,
          departureAuthorizationId: authorization.id,
        },
      });
      tripId = trip.id;
      tripReference = trip.reference;
    });
  }

  function staffEvent(clientEventId: string, type: string, routeWaypointId = borderWaypointId) {
    return {
      clientEventId,
      type,
      routeWaypointId,
      occurredAt: new Date().toISOString(),
    };
  }

  async function crewActor(): Promise<CrewActor> {
    const identity = await createIdentity(t.app, { realm: 'crew' });
    await db(t.app).authorizationRoleAssignment.create({
      data: { identityId: identity.id, roleKey: 'CREW', grantReason: 'pr20 border test' },
    });
    const cookie = await loginCookie(t.app, 'crew', identity.email);
    return {
      id: identity.id,
      cookie,
      csrf: await csrfToken(t.app, 'crew', cookie),
      http: client(t.app, 'crew'),
    };
  }

  it('enforces RBAC and rejects a non-BORDER waypoint', async () => {
    expect((await adminApi(denied).get('/borders/trips/' + tripId)).status).toBe(403);
    const bad = await adminApi(ops).post(
      '/borders/trips/' + tripId + '/events',
      staffEvent('evt-' + run + '-bad', 'ARRIVED', nonBorderWaypointId),
    );
    expect(bad.status, bad.text).toBe(422);
    expect(bad.body.code).toBe('BORDER_WAYPOINT_INVALID');
  });

  it('records the strict four-step state machine and exact replay only once', async () => {
    const firstId = 'evt-' + run + '-01';
    const firstPayload = staffEvent(firstId, 'ARRIVED');
    const first = await adminApi(ops).post('/borders/trips/' + tripId + '/events', firstPayload);
    expect(first.status, first.text).toBe(201);
    expect(first.body.created).toBe(true);

    const replay = await adminApi(ops).post('/borders/trips/' + tripId + '/events', firstPayload);
    expect(replay.status, replay.text).toBe(201);
    expect(replay.body.created).toBe(false);
    expect(replay.body.event.id).toBe(first.body.event.id);

    const conflict = await adminApi(ops).post('/borders/trips/' + tripId + '/events', {
      ...firstPayload,
      type: 'CONTROL_STARTED',
    });
    expect(conflict.status, conflict.text).toBe(409);
    expect(conflict.body.code).toBe('BORDER_CLIENT_EVENT_ID_REUSED');

    for (const [index, type] of ['CONTROL_STARTED', 'CONTROL_COMPLETED', 'DEPARTED'].entries()) {
      const response = await adminApi(ops).post(
        '/borders/trips/' + tripId + '/events',
        staffEvent('evt-' + run + '-0' + (index + 2), type),
      );
      expect(response.status, response.text).toBe(201);
      expect(response.body.created).toBe(true);
    }

    const duplicateTransition = await adminApi(ops).post(
      '/borders/trips/' + tripId + '/events',
      staffEvent('evt-' + run + '-05', 'DEPARTED'),
    );
    expect(duplicateTransition.status, duplicateTransition.text).toBe(409);
    expect(duplicateTransition.body.code).toBe('BORDER_TRANSITION_INVALID');

    const view = await adminApi(ops).get('/borders/trips/' + tripId);
    expect(view.status, view.text).toBe(200);
    expect(view.body.borders).toEqual([
      expect.objectContaining({ routeWaypointId: borderWaypointId, currentState: 'DEPARTED' }),
    ]);
    expect(view.body.events).toHaveLength(4);

    expect(await db(t.app).borderEvent.count({ where: { tripId } })).toBe(4);
  });

  it('records Crew provenance through the shared offline sync contract', async () => {
    const crew = await crewActor();
    const deviceId = 'crew-' + run + '-border';
    const enroll = await crew.http.post(
      '/v1/crew/devices/enroll',
      { deviceId, label: 'PR20' },
      crew.cookie,
      crew.csrf,
    );
    expect(enroll.status, enroll.text).toBe(201);

    const assignment = await db(t.app).crewTripAssignment.create({
      data: {
        tripId,
        crewIdentityId: crew.id,
        assignedByIdentityId: ops.id,
      },
    });

    const otherBorder = await db(t.app).$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
      const checkpoint = await tx.checkpoint.create({
        data: {
          code: 'B20C-' + run,
          name: 'Deuxième frontière',
          countryId: (await tx.country.findUniqueOrThrow({ where: { iso2: 'SN' } })).id,
          type: 'BORDER',
          locality: 'Frontière 2',
          latitude: 14.7,
          longitude: -16.0,
          timezone: 'Africa/Dakar',
        },
      });
      const routeVersionId = (
        await tx.trip.findUniqueOrThrow({
          where: { id: tripId },
          select: { routeVersionId: true },
        })
      ).routeVersionId;
      return tx.routeWaypoint.create({
        data: { routeVersionId, sequence: 4, checkpointId: checkpoint.id },
      });
    });

    const crewEventId = 'evt-' + run + '-crew';
    const syncBody = {
      deviceId,
      events: [
        {
          clientEventId: crewEventId,
          type: 'BORDER_EVENT',
          occurredAt: new Date().toISOString(),
          payload: { routeWaypointId: otherBorder.id, eventType: 'ARRIVED' },
        },
      ],
    };
    const sync = await crew.http.post(
      '/v1/crew/trips/' + encodeURIComponent(tripReference) + '/events/sync',
      syncBody,
      crew.cookie,
      crew.csrf,
    );
    expect(sync.status, sync.text).toBe(201);
    expect(sync.body.results[0]).toMatchObject({
      status: 'ACKNOWLEDGED',
      created: true,
    });

    const persisted = await db(t.app).borderEvent.findFirstOrThrow({
      where: { tripId, clientEventId: crewEventId },
    });
    const device = await db(t.app).crewDevice.findUniqueOrThrow({ where: { deviceId } });
    expect(persisted).toMatchObject({
      source: 'CREW',
      recordedByIdentityId: crew.id,
      crewAssignmentId: assignment.id,
      crewDeviceId: device.id,
    });

    const replay = await crew.http.post(
      '/v1/crew/trips/' + encodeURIComponent(tripReference) + '/events/sync',
      syncBody,
      crew.cookie,
      crew.csrf,
    );
    expect(replay.status, replay.text).toBe(201);
    expect(replay.body.results[0]).toMatchObject({ status: 'ACKNOWLEDGED', created: false });
  });
});
