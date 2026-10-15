import type { ApiEnv } from '@euroteranga/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isolatedDatabase, staffActor, type StaffActor } from '../../support/admin-helpers.js';
import { db } from '../../support/auth-helpers.js';
import { customerBaggageApi, staffBaggageApi } from '../../support/baggage-helpers.js';
import { customerActor, type CustomerActor } from '../../support/booking-helpers.js';
import { complianceApi, acceptedDocument } from '../../support/compliance-helpers.js';
import {
  departureApi,
  departureFixture,
  type DepartureFixture,
} from '../../support/departure-readiness-helpers.js';
import { regulatoryPermitApi, syntheticPermit } from '../../support/regulatory-permit-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

describe('departure readiness and dispatch (PR-17)', () => {
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let t: TestApp;
  let env: ApiEnv;
  let customer: CustomerActor;
  let director: StaffActor;
  let manager: StaffActor;
  let auditor: StaffActor;
  let denied: StaffActor;

  beforeAll(async () => {
    database = await isolatedDatabase();
    env = integrationEnv({ DATABASE_URL: database.url });
    t = await startTestApp(env);
    [customer, director, manager, auditor, denied] = await Promise.all([
      customerActor(t.app),
      staffActor(t.app, ['DIRECTOR']),
      staffActor(t.app, ['OPS_MANAGER']),
      staffActor(t.app, ['AUDITOR']),
      staffActor(t.app, ['CUSTOMER_SUPPORT']),
    ]);
  }, 120_000);

  afterAll(async () => {
    await t?.app.close();
    await database?.drop();
  });

  const fixture = (
    options: { manifestBeforeBoarding?: boolean; generateManifest?: boolean } = {},
  ) => departureFixture(t.app, env, customer, director, director, options);

  async function readyWithEmptyPolicy(): Promise<DepartureFixture> {
    const item = await fixture();
    const policy = await departureApi(manager).publishPolicy(item.tripReference, []);
    if (policy.status !== 201) throw new Error(`policy fixture failed: ${policy.text}`);
    return item;
  }

  it('blocks missing policy, separates read/mutations and requires CSRF', async () => {
    const item = await fixture();
    const managerApi = departureApi(manager);
    const readiness = await managerApi.readiness(item.tripReference);
    expect(readiness.status, readiness.text).toBe(200);
    expect(readiness.body.readiness).toMatchObject({ status: 'BLOCKED' });
    expect(readiness.body.readiness.blockers).toContainEqual({
      gate: 'PERMITS',
      code: 'PERMIT_POLICY_MISSING',
    });

    expect((await departureApi(auditor).readiness(item.tripReference)).status).toBe(200);
    expect((await departureApi(denied).readiness(item.tripReference)).status).toBe(403);
    expect((await departureApi(auditor).publishPolicy(item.tripReference, [])).status).toBe(403);
    expect((await departureApi(auditor).authorize(item.tripReference)).status).toBe(403);
    expect((await departureApi(auditor).depart(item.tripReference)).status).toBe(403);
    expect((await departureApi(auditor).complete(item.tripReference)).status).toBe(403);

    expect((await managerApi.publishPolicy(item.tripReference, [], { csrf: null })).status).toBe(
      403,
    );
    expect((await managerApi.authorize(item.tripReference, {}, { csrf: null })).status).toBe(403);
    expect((await managerApi.depart(item.tripReference, {}, { csrf: null })).status).toBe(403);
    expect((await managerApi.complete(item.tripReference, {}, { csrf: null })).status).toBe(403);
    expect((await managerApi.authorize(item.tripReference, { force: true })).status).toBe(400);
  }, 120_000);

  it('treats an explicit empty policy as complete and runs the dispatch lifecycle once', async () => {
    const item = await readyWithEmptyPolicy();
    const api = departureApi(manager);
    const readiness = await api.readiness(item.tripReference);
    expect(readiness.status, readiness.text).toBe(200);
    expect(readiness.body.readiness).toMatchObject({
      engineVersion: 'departure-readiness/1',
      status: 'READY',
      permitPolicy: { requirementCount: 0, requirements: [] },
      passengers: { total: 1, checkedIn: 1, boarded: 1, currentReady: 1 },
    });
    expect(JSON.stringify(readiness.body)).not.toContain(customer.email);
    expect(JSON.stringify(readiness.body)).not.toContain('qrPayload');

    const first = await api.authorize(item.tripReference);
    expect(first.status, first.text).toBe(200);
    expect(first.body).toMatchObject({
      created: true,
      authorization: {
        reference: expect.stringMatching(/^ETDA-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/u),
        version: 1,
        engineVersion: 'departure-readiness/1',
      },
    });
    const replay = await api.authorize(item.tripReference);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ created: false, authorization: first.body.authorization });

    const departed = await api.depart(item.tripReference);
    expect(departed.status, departed.text).toBe(200);
    expect(departed.body).toMatchObject({
      trip: {
        reference: item.tripReference,
        status: 'IN_PROGRESS',
        actualDepartureAt: expect.any(String),
      },
      authorizationReference: first.body.authorization.reference,
    });
    expect((await api.depart(item.tripReference)).status).toBe(409);

    const completed = await api.complete(item.tripReference);
    expect(completed.status, completed.text).toBe(200);
    expect(completed.body).toMatchObject({
      trip: {
        reference: item.tripReference,
        status: 'COMPLETED',
        actualDepartureAt: expect.any(String),
        actualArrivalAt: expect.any(String),
      },
      authorizationReference: first.body.authorization.reference,
    });
    expect((await api.complete(item.tripReference)).status).toBe(409);

    const stored = await db(t.app).trip.findUniqueOrThrow({ where: { id: item.tripId } });
    expect(stored.status).toBe('COMPLETED');
    expect(stored.actualDepartureAt).not.toBeNull();
    expect(stored.actualArrivalAt).not.toBeNull();
    expect(stored.actualArrivalAt!.getTime()).toBeGreaterThanOrEqual(
      stored.actualDepartureAt!.getTime(),
    );
    expect(
      await db(t.app).auditEvent.count({
        where: {
          resourceType: 'trip',
          resourceId: item.tripId,
          action: { in: ['TRIP_DEPARTED', 'TRIP_COMPLETED'] },
        },
      }),
    ).toBe(2);
  }, 120_000);

  it('blocks an unsatisfied synthetic permit requirement and passes once a matching permit is active', async () => {
    const item = await fixture();
    const permitType = `SYNTHETIC_DEPARTURE_${item.tripId.slice(0, 8).toUpperCase()}`;
    const policy = await departureApi(manager).publishPolicy(item.tripReference, [
      { permitType, scopeType: 'TRIP' },
    ]);
    expect(policy.status, policy.text).toBe(201);
    const blocked = await departureApi(manager).readiness(item.tripReference);
    expect(blocked.body.readiness.blockers).toContainEqual({
      gate: 'PERMITS',
      code: 'PERMIT_REQUIREMENT_UNSATISFIED',
      sequence: 1,
    });

    const permits = regulatoryPermitApi(manager);
    const created = await permits.create(
      syntheticPermit({
        permitType,
        scope: { type: 'TRIP', tripReference: item.tripReference },
        validFrom: '2025-01-01',
        validUntil: '2035-12-31',
      }),
    );
    expect(created.status, created.text).toBe(201);
    const activated = await permits.activate(created.body.reference as string, 1);
    expect(activated.status, activated.text).toBe(200);

    const ready = await departureApi(manager).readiness(item.tripReference);
    expect(ready.body.readiness.status).toBe('READY');
    expect(ready.body.readiness.permitPolicy.requirements).toEqual([
      expect.objectContaining({
        sequence: 1,
        permitType,
        scopeType: 'TRIP',
        satisfied: true,
        permitReference: created.body.reference,
      }),
    ]);
  }, 120_000);

  it('detects a manifest generated before boarding as stale', async () => {
    const item = await fixture({ manifestBeforeBoarding: true });
    expect((await departureApi(manager).publishPolicy(item.tripReference, [])).status).toBe(201);
    const response = await departureApi(manager).readiness(item.tripReference);
    expect(response.status).toBe(200);
    expect(response.body.readiness.blockers).toContainEqual({
      gate: 'MANIFEST',
      code: 'MANIFEST_STALE',
      reference: item.manifestReference,
    });
  }, 120_000);

  it('blocks a currently unavailable vehicle and a passenger whose PR-14 facts became stale', async () => {
    const vehicleItem = await readyWithEmptyPolicy();
    await db(t.app).vehicle.update({
      where: { id: vehicleItem.vehicleId },
      data: { status: 'OUT_OF_SERVICE' },
    });
    const unavailable = await departureApi(manager).readiness(vehicleItem.tripReference);
    expect(unavailable.body.readiness.blockers).toContainEqual({
      gate: 'VEHICLE',
      code: 'VEHICLE_NOT_ACTIVE',
    });

    const passengerItem = await readyWithEmptyPolicy();
    const bag = await customerBaggageApi(customer).register(
      passengerItem.bookingReference,
      passengerItem.passengerReference,
    );
    expect(bag.status, bag.text).toBe(201);
    const held = await staffBaggageApi(manager).event(bag.body.reference, {
      type: 'HELD_BY_CUSTOMS',
    });
    expect(held.status, held.text).toBe(201);
    const stale = await departureApi(manager).readiness(passengerItem.tripReference);
    expect(stale.body.readiness.blockers).toContainEqual({
      gate: 'PASSENGERS',
      code: 'PASSENGER_READINESS_STALE',
      reference: passengerItem.passengerReference,
    });
  }, 120_000);

  it('refuses a stale authorization even when the recomputed readiness is READY again', async () => {
    const item = await readyWithEmptyPolicy();
    const api = departureApi(manager);
    const authorization = await api.authorize(item.tripReference);
    expect(authorization.status, authorization.text).toBe(200);

    await acceptedDocument(t.app, item.passengerReference, 'NATIONAL_ID', null);
    const reevaluated = await complianceApi(customer).evaluate(
      item.bookingReference,
      item.passengerReference,
    );
    expect(reevaluated.status, reevaluated.text).toBe(200);
    expect(reevaluated.body.status).toBe('COMPLIANT_BY_RULES');

    const current = await api.readiness(item.tripReference);
    expect(current.body.readiness.status).toBe('READY');
    expect(current.body.fingerprint).not.toBe(
      authorization.body.authorization.readinessFingerprint,
    );
    const refused = await api.depart(item.tripReference);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('DEPARTURE_AUTHORIZATION_STALE');
    expect((await db(t.app).trip.findUniqueOrThrow({ where: { id: item.tripId } })).status).toBe(
      'SCHEDULED',
    );
  }, 120_000);
});
