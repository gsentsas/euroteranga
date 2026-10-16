import { createHash, randomBytes } from 'node:crypto';
import type { ApiEnv } from '@euroteranga/config';
import { keyedDigest, toBytes } from '../../../src/auth/crypto/tokens.js';
import { RATE_LIMITS } from '../../../src/auth/rate-limit/rate-limit.rules.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { staffActor, type StaffActor } from '../../support/admin-helpers.js';
import { client, createIdentity, csrfToken, db, loginCookie } from '../../support/auth-helpers.js';
import { customerActor, type CustomerActor } from '../../support/booking-helpers.js';
import { compliantPassenger, staffCheckInApi } from '../../support/check-in-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

interface CrewActor {
  id: string;
  cookie: string;
  csrf: string;
  http: ReturnType<typeof client>;
}

function crewApi(actor: CrewActor) {
  return {
    trips: () => actor.http.get('/v1/crew/trips', actor.cookie),
    device: (deviceId: string) =>
      actor.http.get(`/v1/crew/devices/${encodeURIComponent(deviceId)}`, actor.cookie),
    enroll: (deviceId: string, label = 'Terminal test') =>
      actor.http.post('/v1/crew/devices/enroll', { deviceId, label }, actor.cookie, actor.csrf),
    revokeDevice: (deviceId: string, reason = 'Fin du test') =>
      actor.http.post(
        `/v1/crew/devices/${encodeURIComponent(deviceId)}/revoke`,
        { reason },
        actor.cookie,
        actor.csrf,
      ),
    sync: (tripReference: string, body: unknown) =>
      actor.http.post(
        `/v1/crew/trips/${encodeURIComponent(tripReference)}/events/sync`,
        body,
        actor.cookie,
        actor.csrf,
      ),
  };
}

describe('PR-18 Crew offline sync', () => {
  const run = randomBytes(4).toString('hex');
  let t: TestApp;
  let env: ApiEnv;
  let customer: CustomerActor;
  let ruleManager: StaffActor;
  let checkInAgent: StaffActor;
  let ops: StaffActor;

  beforeAll(async () => {
    env = integrationEnv();
    t = await startTestApp(env);
    [customer, ruleManager, checkInAgent, ops] = await Promise.all([
      customerActor(t.app),
      staffActor(t.app, ['DIRECTOR']),
      staffActor(t.app, ['BOOKING_AGENT']),
      staffActor(t.app, ['OPS_MANAGER']),
    ]);
  }, 60_000);

  afterAll(async () => {
    await t.app.close();
  });

  async function crewActor(): Promise<CrewActor> {
    const identity = await createIdentity(t.app, { realm: 'crew' });
    await db(t.app).authorizationRoleAssignment.create({
      data: {
        identityId: identity.id,
        roleKey: 'CREW',
        grantReason: `pr18-${run}`,
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

  async function crewActorWithoutPassword(): Promise<CrewActor> {
    const email = `crew.direct.${randomBytes(6).toString('hex')}@example.test`;
    const identity = await db(t.app).authIdentity.create({
      data: {
        realm: 'CREW',
        email,
        normalizedEmail: email,
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
        roleAssignments: {
          create: { roleKey: 'CREW', grantReason: `pr18-direct-${run}` },
        },
      },
    });
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 60 * 60_000);
    await db(t.app).authSession.create({
      data: {
        identityId: identity.id,
        tokenHash: new Uint8Array(createHash('sha256').update(token).digest()),
        authVersion: identity.authVersion,
        idleExpiresAt: expiresAt,
        absoluteExpiresAt: expiresAt,
      },
    });
    const cookie = `et_crew_session=${token}`;
    return {
      id: identity.id,
      cookie,
      csrf: await csrfToken(t.app, 'crew', cookie),
      http: client(t.app, 'crew'),
    };
  }

  async function readyBoarding() {
    const ready = await compliantPassenger(t.app, env, customer, ruleManager);
    const checked = await staffCheckInApi(checkInAgent).checkIn(
      ready.bookingReference,
      ready.passengerReference,
    );
    expect(checked.status, checked.text).toBe(201);
    const trip = await db(t.app).trip.findUniqueOrThrow({
      where: { reference: ready.journey.tripReference },
      select: { id: true, reference: true },
    });
    return { ...ready, trip, qrPayload: checked.body.checkIn.qrPayload as string };
  }

  async function assign(crew: CrewActor, tripId: string) {
    const response = await ops.http.post(
      `/v1/admin/trips/${tripId}/crew-assignments`,
      { crewIdentityId: crew.id },
      ops.cookie,
      await ops.csrf(),
    );
    expect(response.status, response.text).toBe(201);
    return response.body.assignment as { id: string };
  }

  async function setHistoricalTripStatus(
    tripId: string,
    status: 'IN_PROGRESS' | 'COMPLETED',
  ): Promise<void> {
    await db(t.app).$transaction(async (tx) => {
      // This fixture models a trip already dispatched by PR-17. The PR-17
      // transition itself is covered in its own suite; Crew must only reject
      // both terminal/non-boardable states here.
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
      const authorization = await tx.departureAuthorization.create({
        data: {
          reference: `ETDA-${randomBytes(6).toString('hex').toUpperCase()}`,
          tripId,
          version: 1,
          engineVersion: 'departure-readiness/1',
          readinessFingerprint: 'a'.repeat(64),
          readinessSnapshot: { engineVersion: 'departure-readiness/1', status: 'READY' },
          authorizedByIdentityId: ops.id,
        },
      });
      const departedAt = new Date(Date.now() - 60_000);
      await tx.trip.update({
        where: { id: tripId },
        data: {
          status: 'IN_PROGRESS',
          actualDepartureAt: departedAt,
          departureAuthorizationId: authorization.id,
        },
      });
      if (status === 'COMPLETED') {
        await tx.trip.update({
          where: { id: tripId },
          data: { status: 'COMPLETED', actualArrivalAt: new Date() },
        });
      }
    });
  }

  it('exposes only assigned live trips and requires an enrolled owned device', async () => {
    const crew = await crewActor();
    const ready = await readyBoarding();
    expect((await crewApi(crew).trips()).body.items).toEqual([]);

    await assign(crew, ready.trip.id);
    const trips = await crewApi(crew).trips();
    expect(trips.status, trips.text).toBe(200);
    expect(trips.body.items).toHaveLength(1);
    expect(trips.body.items[0]).toMatchObject({
      trip: { reference: ready.trip.reference, status: 'SCHEDULED' },
    });

    const event = {
      deviceId: `crew-${run}-a`,
      events: [
        {
          clientEventId: `event-${run}-a`,
          type: 'PASSENGER_BOARDING',
          occurredAt: new Date().toISOString(),
          payload: { qrPayload: ready.qrPayload },
        },
      ],
    };
    const beforeEnroll = await crewApi(crew).sync(ready.trip.reference, event);
    expect(beforeEnroll.status).toBe(409);
    expect(beforeEnroll.body.code).toBe('CREW_DEVICE_UNAVAILABLE');

    const enrolled = await crewApi(crew).enroll(event.deviceId);
    expect(enrolled.status, enrolled.text).toBe(201);
    expect(enrolled.body).toMatchObject({ deviceId: event.deviceId, revokedAt: null });
  });

  it('syncs one offline boarding exactly once and persists Crew provenance', async () => {
    const crew = await crewActor();
    const ready = await readyBoarding();
    const assignment = await assign(crew, ready.trip.id);
    const deviceId = `crew-${run}-b`;
    expect((await crewApi(crew).enroll(deviceId)).status).toBe(201);

    const event = {
      deviceId,
      events: [
        {
          clientEventId: `event-${run}-b`,
          type: 'PASSENGER_BOARDING',
          occurredAt: new Date().toISOString(),
          payload: { qrPayload: ready.qrPayload },
        },
      ],
    };
    const first = await crewApi(crew).sync(ready.trip.reference, event);
    expect(first.status, first.text).toBe(201);
    expect(first.body.results).toEqual([
      {
        clientEventId: `event-${run}-b`,
        status: 'ACKNOWLEDGED',
        created: true,
        boardingReference: expect.stringMatching(/^ETE-/u),
      },
    ]);

    const replay = await crewApi(crew).sync(ready.trip.reference, event);
    expect(replay.status, replay.text).toBe(201);
    expect(replay.body.results[0]).toMatchObject({
      clientEventId: `event-${run}-b`,
      status: 'ACKNOWLEDGED',
      created: false,
      boardingReference: first.body.results[0].boardingReference,
    });

    const stored = await db(t.app).passengerBoarding.findFirstOrThrow({
      where: { deviceId, clientEventId: `event-${run}-b` },
      include: { crewDevice: true, crewAssignment: true },
    });
    expect(stored.boardedByIdentityId).toBe(crew.id);
    expect(stored.crewDevice?.identityId).toBe(crew.id);
    expect(stored.crewAssignmentId).toBe(assignment.id);
    expect(stored.crewAssignment?.tripId).toBe(ready.trip.id);
    expect(
      await db(t.app).auditEvent.count({
        where: { action: 'PASSENGER_BOARDED', resourceId: stored.checkInId },
      }),
    ).toBe(1);
  });

  it('returns an explicit conflict when a client event id is reused with different content', async () => {
    const crew = await crewActor();
    const ready = await readyBoarding();
    await assign(crew, ready.trip.id);
    const deviceId = `crew-${run}-c`;
    await crewApi(crew).enroll(deviceId);
    const clientEventId = `event-${run}-c`;
    const occurredAt = new Date().toISOString();

    const first = await crewApi(crew).sync(ready.trip.reference, {
      deviceId,
      events: [
        {
          clientEventId,
          type: 'PASSENGER_BOARDING',
          occurredAt,
          payload: { qrPayload: ready.qrPayload },
        },
      ],
    });
    expect(first.body.results[0].status).toBe('ACKNOWLEDGED');

    const conflict = await crewApi(crew).sync(ready.trip.reference, {
      deviceId,
      events: [
        {
          clientEventId,
          type: 'PASSENGER_BOARDING',
          occurredAt: new Date(Date.now() - 1_000).toISOString(),
          payload: { qrPayload: ready.qrPayload },
        },
      ],
    });
    expect(conflict.status, conflict.text).toBe(201);
    expect(conflict.body.results[0]).toEqual({
      clientEventId,
      status: 'CONFLICT',
      errorCode: 'BOARDING_CLIENT_EVENT_ID_REUSED',
    });
  });

  it('returns one creation and one identical ACK for concurrent retries of the same event', async () => {
    const crew = await crewActor();
    const ready = await readyBoarding();
    await assign(crew, ready.trip.id);
    const deviceId = `crew-${run}-same-race`;
    await crewApi(crew).enroll(deviceId);
    const body = {
      deviceId,
      events: [
        {
          clientEventId: `event-${run}-same-race`,
          type: 'PASSENGER_BOARDING',
          occurredAt: new Date().toISOString(),
          payload: { qrPayload: ready.qrPayload },
        },
      ],
    };

    const [first, second] = await Promise.all([
      crewApi(crew).sync(ready.trip.reference, body),
      crewApi(crew).sync(ready.trip.reference, body),
    ]);
    expect(first.status, first.text).toBe(201);
    expect(second.status, second.text).toBe(201);
    expect([first.body.results[0].status, second.body.results[0].status]).toEqual([
      'ACKNOWLEDGED',
      'ACKNOWLEDGED',
    ]);
    expect([first.body.results[0].created, second.body.results[0].created].sort()).toEqual([
      false,
      true,
    ]);
    expect(first.body.results[0].boardingReference).toBe(second.body.results[0].boardingReference);
    expect(
      await db(t.app).passengerBoarding.count({
        where: { deviceId, clientEventId: body.events[0]!.clientEventId },
      }),
    ).toBe(1);
  });

  it('allows two enrolled devices but creates only one business boarding', async () => {
    const crew = await crewActor();
    const ready = await readyBoarding();
    await assign(crew, ready.trip.id);
    const deviceIds = [`crew-${run}-two-a`, `crew-${run}-two-b`];
    await Promise.all(deviceIds.map((deviceId) => crewApi(crew).enroll(deviceId)));
    const occurredAt = new Date().toISOString();
    const responses = await Promise.all(
      deviceIds.map((deviceId, index) =>
        crewApi(crew).sync(ready.trip.reference, {
          deviceId,
          events: [
            {
              clientEventId: `event-${run}-two-${index}`,
              type: 'PASSENGER_BOARDING',
              occurredAt,
              payload: { qrPayload: ready.qrPayload },
            },
          ],
        }),
      ),
    );
    expect(responses.every((response) => response.status === 201)).toBe(true);
    expect(responses.map((response) => response.body.results[0].status).sort()).toEqual([
      'ACKNOWLEDGED',
      'REJECTED',
    ]);
    expect(
      responses
        .map((response) => response.body.results[0].errorCode)
        .filter((value) => value !== undefined),
    ).toEqual(['PASSENGER_ALREADY_BOARDED']);
    expect(
      await db(t.app).passengerBoarding.count({
        where: {
          checkIn: { bookingPassenger: { booking: { reference: ready.bookingReference } } },
        },
      }),
    ).toBe(1);
  });

  it('rejects another Crew identity and a revoked device', async () => {
    const [crew, foreign] = await Promise.all([crewActor(), crewActor()]);
    const ready = await readyBoarding();
    await assign(crew, ready.trip.id);
    const deviceId = `crew-${run}-d`;
    await crewApi(crew).enroll(deviceId);

    const payload = {
      deviceId,
      events: [
        {
          clientEventId: `event-${run}-d`,
          type: 'PASSENGER_BOARDING',
          occurredAt: new Date().toISOString(),
          payload: { qrPayload: ready.qrPayload },
        },
      ],
    };

    const foreignResponse = await crewApi(foreign).sync(ready.trip.reference, payload);
    expect(foreignResponse.status).toBe(409);

    expect((await crewApi(crew).revokeDevice(deviceId)).status).toBe(201);
    const revoked = await crewApi(crew).sync(ready.trip.reference, payload);
    expect(revoked.status).toBe(409);
    expect(revoked.body.code).toBe('CREW_DEVICE_UNAVAILABLE');
  });

  it('reads only an owned device and rejects an expired device', async () => {
    const [crew, foreign] = await Promise.all([crewActor(), crewActor()]);
    const ready = await readyBoarding();
    await assign(crew, ready.trip.id);
    const deviceId = `crew-${run}-device-read`;
    expect((await crewApi(crew).enroll(deviceId)).status).toBe(201);
    expect((await crewApi(crew).device(deviceId)).status).toBe(200);
    expect((await crewApi(foreign).device(deviceId)).status).toBe(404);

    const expiredDeviceId = `crew-${run}-expired`;
    await db(t.app).crewDevice.create({
      data: {
        deviceId: expiredDeviceId,
        identityId: crew.id,
        enrolledAt: new Date(Date.now() - 2 * 86_400_000),
        lastSeenAt: new Date(Date.now() - 2 * 86_400_000),
        expiresAt: new Date(Date.now() - 86_400_000),
      },
    });
    const response = await crewApi(crew).sync(ready.trip.reference, {
      deviceId: expiredDeviceId,
      events: [
        {
          clientEventId: `event-${run}-expired-device`,
          type: 'PASSENGER_BOARDING',
          occurredAt: new Date().toISOString(),
          payload: { qrPayload: ready.qrPayload },
        },
      ],
    });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('CREW_DEVICE_UNAVAILABLE');
  });

  it('rejects expired and revoked trip assignments before boarding', async () => {
    const crew = await crewActor();
    const expiredReady = await readyBoarding();
    const expiredDevice = `crew-${run}-expired-assignment`;
    await crewApi(crew).enroll(expiredDevice);
    await db(t.app).crewTripAssignment.create({
      data: {
        tripId: expiredReady.trip.id,
        crewIdentityId: crew.id,
        assignedByIdentityId: ops.id,
        assignedAt: new Date(Date.now() - 2 * 86_400_000),
        expiresAt: new Date(Date.now() - 86_400_000),
      },
    });
    const expired = await crewApi(crew).sync(expiredReady.trip.reference, {
      deviceId: expiredDevice,
      events: [
        {
          clientEventId: `event-${run}-expired-assignment`,
          type: 'PASSENGER_BOARDING',
          occurredAt: new Date().toISOString(),
          payload: { qrPayload: expiredReady.qrPayload },
        },
      ],
    });
    expect(expired.status).toBe(403);
    expect(expired.body.code).toBe('CREW_TRIP_NOT_ASSIGNED');

    const revokedReady = await readyBoarding();
    const assignment = await assign(crew, revokedReady.trip.id);
    const revokedDevice = `crew-${run}-revoked-assignment`;
    await crewApi(crew).enroll(revokedDevice);
    await ops.http.post(
      `/v1/admin/trips/${revokedReady.trip.id}/crew-assignments/${assignment.id}/revoke`,
      { reason: 'Affectation retirée pour le test' },
      ops.cookie,
      await ops.csrf(),
    );
    const revoked = await crewApi(crew).sync(revokedReady.trip.reference, {
      deviceId: revokedDevice,
      events: [
        {
          clientEventId: `event-${run}-revoked-assignment`,
          type: 'PASSENGER_BOARDING',
          occurredAt: new Date().toISOString(),
          payload: { qrPayload: revokedReady.qrPayload },
        },
      ],
    });
    expect(revoked.status).toBe(403);
    expect(revoked.body.code).toBe('CREW_TRIP_NOT_ASSIGNED');
  });

  it('rejects a QR belonging to a different trip inside the typed batch', async () => {
    const crew = await crewActor();
    const [assigned, other] = await Promise.all([readyBoarding(), readyBoarding()]);
    await assign(crew, assigned.trip.id);
    const deviceId = `crew-${run}-wrong-trip`;
    await crewApi(crew).enroll(deviceId);
    const response = await crewApi(crew).sync(assigned.trip.reference, {
      deviceId,
      events: [
        {
          clientEventId: `event-${run}-wrong-trip`,
          type: 'PASSENGER_BOARDING',
          occurredAt: new Date().toISOString(),
          payload: { qrPayload: other.qrPayload },
        },
      ],
    });
    expect(response.status, response.text).toBe(201);
    expect(response.body.results).toEqual([
      {
        clientEventId: `event-${run}-wrong-trip`,
        status: 'REJECTED',
        errorCode: 'CREW_CONTEXT_STALE',
      },
    ]);
    expect(await db(t.app).passengerBoarding.count({ where: { deviceId } })).toBe(0);
  });

  it('refuses synchronization after trip cancellation and after session expiry', async () => {
    const cancelledCrew = await crewActor();
    const cancelledReady = await readyBoarding();
    await assign(cancelledCrew, cancelledReady.trip.id);
    const cancelledDevice = `crew-${run}-cancelled`;
    await crewApi(cancelledCrew).enroll(cancelledDevice);
    await db(t.app).$transaction(async (tx) => {
      // Model a historical cancelled trip without exercising the separate
      // refund/cancellation workflow owned by booking and trip domains.
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
      await tx.trip.update({
        where: { id: cancelledReady.trip.id },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });
    });
    const cancelled = await crewApi(cancelledCrew).sync(cancelledReady.trip.reference, {
      deviceId: cancelledDevice,
      events: [
        {
          clientEventId: `event-${run}-cancelled`,
          type: 'PASSENGER_BOARDING',
          occurredAt: new Date().toISOString(),
          payload: { qrPayload: cancelledReady.qrPayload },
        },
      ],
    });
    expect(cancelled.status).toBe(409);
    expect(cancelled.body.code).toBe('CREW_TRIP_UNAVAILABLE');

    const expiredCrew = await crewActor();
    const expiredReady = await readyBoarding();
    await assign(expiredCrew, expiredReady.trip.id);
    const expiredDevice = `crew-${run}-expired-session`;
    await crewApi(expiredCrew).enroll(expiredDevice);
    await db(t.app).authSession.updateMany({
      where: { identityId: expiredCrew.id, revokedAt: null },
      data: { idleExpiresAt: new Date(Date.now() - 1_000) },
    });
    const expired = await crewApi(expiredCrew).sync(expiredReady.trip.reference, {
      deviceId: expiredDevice,
      events: [
        {
          clientEventId: `event-${run}-expired-session`,
          type: 'PASSENGER_BOARDING',
          occurredAt: new Date().toISOString(),
          payload: { qrPayload: expiredReady.qrPayload },
        },
      ],
    });
    expect(expired.status).toBe(401);
    expect(await db(t.app).passengerBoarding.count({ where: { deviceId: expiredDevice } })).toBe(0);

    const suspended = await crewActor();
    await db(t.app).authIdentity.update({
      where: { id: suspended.id },
      data: { status: 'SUSPENDED' },
    });
    expect((await crewApi(suspended).trips()).status).toBe(401);
  });

  it.each(['IN_PROGRESS', 'COMPLETED'] as const)(
    'refuses boarding when the assigned trip is %s',
    async (status) => {
      const crew = await crewActor();
      const ready = await readyBoarding();
      await assign(crew, ready.trip.id);
      const deviceId = `crew-${run}-${status.toLowerCase()}`;
      await crewApi(crew).enroll(deviceId);
      await setHistoricalTripStatus(ready.trip.id, status);
      const response = await crewApi(crew).sync(ready.trip.reference, {
        deviceId,
        events: [
          {
            clientEventId: `event-${run}-${status.toLowerCase()}`,
            type: 'PASSENGER_BOARDING',
            occurredAt: new Date().toISOString(),
            payload: { qrPayload: ready.qrPayload },
          },
        ],
      });
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('CREW_TRIP_UNAVAILABLE');
    },
  );

  it('turns a concurrent cross-passenger clientEventId collision into one ACK and one conflict', async () => {
    const crew = await crewActor();
    const [firstReady, secondReady] = await Promise.all([readyBoarding(), readyBoarding()]);
    await assign(crew, firstReady.trip.id);
    await assign(crew, secondReady.trip.id);
    const deviceId = `crew-${run}-race`;
    expect((await crewApi(crew).enroll(deviceId)).status).toBe(201);
    const clientEventId = `event-${run}-race`;
    const occurredAt = new Date().toISOString();

    const [first, second] = await Promise.all([
      crewApi(crew).sync(firstReady.trip.reference, {
        deviceId,
        events: [
          {
            clientEventId,
            type: 'PASSENGER_BOARDING',
            occurredAt,
            payload: { qrPayload: firstReady.qrPayload },
          },
        ],
      }),
      crewApi(crew).sync(secondReady.trip.reference, {
        deviceId,
        events: [
          {
            clientEventId,
            type: 'PASSENGER_BOARDING',
            occurredAt,
            payload: { qrPayload: secondReady.qrPayload },
          },
        ],
      }),
    ]);

    expect(first.status, first.text).toBe(201);
    expect(second.status, second.text).toBe(201);
    expect([first.body.results[0].status, second.body.results[0].status].sort()).toEqual([
      'ACKNOWLEDGED',
      'CONFLICT',
    ]);
    expect(await db(t.app).passengerBoarding.count({ where: { deviceId, clientEventId } })).toBe(1);
  });

  it('keeps rate-limited boarding events retryable instead of rejecting them', async () => {
    const crew = await crewActorWithoutPassword();
    const ready = await readyBoarding();
    await assign(crew, ready.trip.id);
    const deviceId = `crew-${run}-rate-limit`;
    await crewApi(crew).enroll(deviceId);

    const rule = RATE_LIMITS.boardingScanIdentity;
    const now = Date.now();
    const windowStart = new Date(Math.floor(now / rule.windowMs) * rule.windowMs);
    const key = toBytes(
      keyedDigest(Buffer.from(env.AUTH_HMAC_KEY, 'base64'), ['rate-limit', rule.action, crew.id]),
    );
    await db(t.app).authRateLimitBucket.upsert({
      where: { key_windowStart: { key, windowStart } },
      create: {
        key,
        windowStart,
        action: rule.action,
        count: rule.limit,
        expiresAt: new Date(windowStart.getTime() + rule.windowMs),
      },
      update: { count: rule.limit },
    });

    const response = await crewApi(crew).sync(ready.trip.reference, {
      deviceId,
      events: [
        {
          clientEventId: `event-${run}-rate-limit`,
          type: 'PASSENGER_BOARDING',
          occurredAt: new Date().toISOString(),
          payload: { qrPayload: ready.qrPayload },
        },
      ],
    });
    expect(response.status, response.text).toBe(201);
    expect(response.body.results[0]).toMatchObject({
      status: 'RETRY',
      errorCode: 'TOO_MANY_REQUESTS',
    });
    expect(response.body.results[0].retryAfterSeconds).toBeGreaterThan(0);
    expect(await db(t.app).passengerBoarding.count({ where: { deviceId } })).toBe(0);
  });

  it('enforces Crew ownership and STAFF grantor rules inside PostgreSQL', async () => {
    const crew = await crewActor();
    const ready = await readyBoarding();

    await expect(
      db(t.app).crewDevice.create({
        data: {
          deviceId: `crew-${run}-staff-owned`,
          identityId: ops.id,
          expiresAt: new Date(Date.now() + 60_000),
        },
      }),
    ).rejects.toThrow(/owner must be active CREW/u);

    await expect(
      db(t.app).crewTripAssignment.create({
        data: {
          tripId: ready.trip.id,
          crewIdentityId: crew.id,
          assignedByIdentityId: customer.id,
        },
      }),
    ).rejects.toThrow(/grantor must be active STAFF/u);
  });

  it('keeps device and assignment history immutable and enforces Crew boarding provenance', async () => {
    const crew = await crewActor();
    const ready = await readyBoarding();
    const assignment = await assign(crew, ready.trip.id);
    const deviceId = `crew-${run}-db-guards`;
    await crewApi(crew).enroll(deviceId);
    const device = await db(t.app).crewDevice.findUniqueOrThrow({ where: { deviceId } });

    await expect(
      db(t.app).crewTripAssignment.create({
        data: {
          tripId: ready.trip.id,
          crewIdentityId: crew.id,
          assignedByIdentityId: ops.id,
        },
      }),
    ).rejects.toThrow(/Unique constraint failed/u);
    await expect(db(t.app).crewDevice.delete({ where: { id: device.id } })).rejects.toThrow(
      /history is never deleted/u,
    );
    await expect(
      db(t.app).crewTripAssignment.delete({ where: { id: assignment.id } }),
    ).rejects.toThrow(/history is never deleted/u);
    await expect(
      db(t.app).$executeRawUnsafe('TRUNCATE TABLE "crew_device" CASCADE'),
    ).rejects.toThrow(/cannot be truncated/u);

    const credentialReference = ready.qrPayload.slice('ETPAX1:'.length);
    const checkIn = await db(t.app).passengerCheckIn.findUniqueOrThrow({
      where: { credentialReference },
    });
    await expect(
      db(t.app).passengerBoarding.create({
        data: {
          reference: 'ETE-ZZZZZZZZZZZZ',
          checkInId: checkIn.id,
          deviceId,
          clientEventId: `event-${run}-missing-provenance`,
          payloadFingerprint: 'a'.repeat(64),
          readinessFingerprint: checkIn.readinessFingerprint,
          occurredAt: new Date(),
          boardedByIdentityId: crew.id,
        },
      }),
    ).rejects.toThrow(/requires device, assignment and client event provenance/u);
  });

  it('records device, assignment and boarding audit facts exactly once without QR payloads', async () => {
    const crew = await crewActor();
    const ready = await readyBoarding();
    await assign(crew, ready.trip.id);
    const deviceId = `crew-${run}-audit`;
    await crewApi(crew).enroll(deviceId);
    const clientEventId = `event-${run}-audit`;
    const body = {
      deviceId,
      events: [
        {
          clientEventId,
          type: 'PASSENGER_BOARDING',
          occurredAt: new Date().toISOString(),
          payload: { qrPayload: ready.qrPayload },
        },
      ],
    };
    expect((await crewApi(crew).sync(ready.trip.reference, body)).status).toBe(201);
    expect((await crewApi(crew).sync(ready.trip.reference, body)).status).toBe(201);
    const events = await db(t.app).auditEvent.findMany({
      where: {
        actorIdentityId: crew.id,
        action: { in: ['CREW_DEVICE_ENROLLED', 'PASSENGER_BOARDED'] },
      },
    });
    expect(events.filter((event) => event.action === 'CREW_DEVICE_ENROLLED')).toHaveLength(1);
    expect(events.filter((event) => event.action === 'PASSENGER_BOARDED')).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(ready.qrPayload);
  });

  it('allows active STAFF to revoke after the Crew owner and original grantor are disabled', async () => {
    const crew = await crewActorWithoutPassword();
    const ready = await readyBoarding();
    const grantorEmail = `grantor.direct.${randomBytes(6).toString('hex')}@example.test`;
    const grantor = await db(t.app).authIdentity.create({
      data: {
        realm: 'STAFF',
        email: grantorEmail,
        normalizedEmail: grantorEmail,
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
      },
    });
    const assigned = await db(t.app).crewTripAssignment.create({
      data: {
        tripId: ready.trip.id,
        crewIdentityId: crew.id,
        assignedByIdentityId: grantor.id,
      },
    });
    const assignmentId = assigned.id;
    const deviceId = `crew-${run}-revocation-after-disable`;
    expect((await crewApi(crew).enroll(deviceId)).status).toBe(201);

    await db(t.app).authIdentity.update({
      where: { id: crew.id },
      data: { status: 'SUSPENDED' },
    });
    await db(t.app).authIdentity.update({
      where: { id: grantor.id },
      data: { status: 'DISABLED' },
    });

    const revoked = await ops.http.post(
      `/v1/admin/trips/${ready.trip.id}/crew-assignments/${assignmentId}/revoke`,
      { reason: 'Retrait après suspension du Crew' },
      ops.cookie,
      await ops.csrf(),
    );
    expect(revoked.status, revoked.text).toBe(201);
    expect(revoked.body.revokedAt).toBeTruthy();

    const device = await db(t.app).crewDevice.update({
      where: { deviceId },
      data: {
        revokedAt: new Date(),
        revokedByIdentityId: ops.id,
        revocationReason: 'Appareil retiré après suspension',
      },
    });
    expect(device.revokedAt).toBeTruthy();
  });

  it('makes assignment creation idempotent and revocation terminal', async () => {
    const crew = await crewActor();
    const ready = await readyBoarding();
    const first = await assign(crew, ready.trip.id);
    const second = await ops.http.post(
      `/v1/admin/trips/${ready.trip.id}/crew-assignments`,
      { crewIdentityId: crew.id },
      ops.cookie,
      await ops.csrf(),
    );
    expect(second.status, second.text).toBe(201);
    expect(second.body).toMatchObject({ created: false, assignment: { id: first.id } });

    const revoked = await ops.http.post(
      `/v1/admin/trips/${ready.trip.id}/crew-assignments/${first.id}/revoke`,
      { reason: 'Changement équipe test' },
      ops.cookie,
      await ops.csrf(),
    );
    expect(revoked.status, revoked.text).toBe(201);
    const again = await ops.http.post(
      `/v1/admin/trips/${ready.trip.id}/crew-assignments/${first.id}/revoke`,
      { reason: 'Autre raison ignorée' },
      ops.cookie,
      await ops.csrf(),
    );
    expect(again.status, again.text).toBe(201);
    expect(again.body.revocationReason).toBe('Changement équipe test');
    expect((await crewApi(crew).trips()).body.items).toEqual([]);
  });
});
