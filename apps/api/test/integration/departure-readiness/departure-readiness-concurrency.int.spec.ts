import type { ApiEnv } from '@euroteranga/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isolatedDatabase, staffActor, type StaffActor } from '../../support/admin-helpers.js';
import { db } from '../../support/auth-helpers.js';
import { customerActor, type CustomerActor } from '../../support/booking-helpers.js';
import { departureApi, departureFixture } from '../../support/departure-readiness-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

describe('departure readiness concurrency (isolated database)', () => {
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let t: TestApp;
  let env: ApiEnv;
  let customer: CustomerActor;
  let director: StaffActor;
  let manager: StaffActor;

  beforeAll(async () => {
    database = await isolatedDatabase();
    env = integrationEnv({ DATABASE_URL: database.url });
    t = await startTestApp(env);
    [customer, director, manager] = await Promise.all([
      customerActor(t.app),
      staffActor(t.app, ['DIRECTOR']),
      staffActor(t.app, ['OPS_MANAGER']),
    ]);
  }, 90_000);

  afterAll(async () => {
    await t?.app.close();
    await database?.drop();
  });

  it('serializes double authorize, depart and complete without duplicate facts', async () => {
    const item = await departureFixture(t.app, env, customer, director, director);
    const api = departureApi(manager);
    expect((await api.publishPolicy(item.tripReference, [])).status).toBe(201);

    const authorizations = await Promise.all([
      api.authorize(item.tripReference),
      api.authorize(item.tripReference),
    ]);
    expect(authorizations.map((response) => response.status)).toEqual([200, 200]);
    expect(authorizations.map((response) => response.body.created).sort()).toEqual([false, true]);
    expect(authorizations[0]!.body.authorization.reference).toBe(
      authorizations[1]!.body.authorization.reference,
    );
    expect(await db(t.app).departureAuthorization.count({ where: { tripId: item.tripId } })).toBe(
      1,
    );

    const departures = await Promise.all([
      api.depart(item.tripReference),
      api.depart(item.tripReference),
    ]);
    expect(departures.map((response) => response.status).sort()).toEqual([200, 409]);
    const inProgress = await db(t.app).trip.findUniqueOrThrow({ where: { id: item.tripId } });
    expect(inProgress.status).toBe('IN_PROGRESS');
    expect(inProgress.actualDepartureAt).not.toBeNull();
    expect(
      await db(t.app).auditEvent.count({
        where: { action: 'TRIP_DEPARTED', resourceType: 'trip', resourceId: item.tripId },
      }),
    ).toBe(1);

    const completions = await Promise.all([
      api.complete(item.tripReference),
      api.complete(item.tripReference),
    ]);
    expect(completions.map((response) => response.status).sort()).toEqual([200, 409]);
    const completed = await db(t.app).trip.findUniqueOrThrow({ where: { id: item.tripId } });
    expect(completed.status).toBe('COMPLETED');
    expect(completed.actualArrivalAt).not.toBeNull();
    expect(
      await db(t.app).auditEvent.count({
        where: { action: 'TRIP_COMPLETED', resourceType: 'trip', resourceId: item.tripId },
      }),
    ).toBe(1);
  }, 120_000);
});
