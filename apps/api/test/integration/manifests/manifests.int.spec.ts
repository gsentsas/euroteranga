import type { ApiEnv } from '@euroteranga/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestRole, staffActor, type StaffActor } from '../../support/admin-helpers.js';
import { client, createIdentity, db, loginCookie } from '../../support/auth-helpers.js';
import {
  bookableFixture,
  customerActor,
  type CustomerActor,
} from '../../support/booking-helpers.js';
import {
  boardingApi,
  compliantPassenger,
  staffCheckInApi,
} from '../../support/check-in-helpers.js';
import { journeyPassenger } from '../../support/compliance-helpers.js';
import { manifestApi } from '../../support/manifest-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

describe('immutable passenger manifests', () => {
  let t: TestApp;
  let env: ApiEnv;
  let customer: CustomerActor;
  let director: StaffActor;
  let dispatcher: StaffActor;
  let bookingAgent: StaffActor;

  beforeAll(async () => {
    env = integrationEnv();
    t = await startTestApp(env);
    [customer, director, dispatcher, bookingAgent] = await Promise.all([
      customerActor(t.app),
      staffActor(t.app, ['DIRECTOR']),
      staffActor(t.app, ['DISPATCHER']),
      staffActor(t.app, ['BOOKING_AGENT']),
    ]);
  }, 60_000);

  afterAll(async () => {
    await t.app.close();
  });

  async function checkedInJourney() {
    const ready = await compliantPassenger(t.app, env, customer, director, {
      seats: ['1A', '1B'],
      seat: '1A',
    });
    const notCheckedIn = await journeyPassenger(customer, ready.journey, ready.journey.origin.id, {
      givenName: 'Non',
      familyName: 'Enregistré',
    });
    const checkedIn = await staffCheckInApi(bookingAgent).checkIn(
      ready.bookingReference,
      ready.passengerReference,
    );
    if (checkedIn.status !== 201) throw new Error(`check-in fixture failed: ${checkedIn.text}`);
    return { ...ready, notCheckedIn, checkIn: checkedIn.body.checkIn };
  }

  it('generates only checked-in passengers and keeps old snapshots immutable after boarding', async () => {
    const fixture = await checkedInJourney();
    const api = manifestApi(dispatcher);
    const first = await api.generate(fixture.journey.tripReference);
    expect(first.status, first.text).toBe(201);
    expect(first.body).toMatchObject({
      reference: expect.stringMatching(/^ETM-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/u),
      tripReference: fixture.journey.tripReference,
      version: 1,
      schemaVersion: 'passenger-manifest/1',
      passengerCount: 1,
      boardedCount: 0,
      snapshot: {
        schemaVersion: 'passenger-manifest/1',
        passengers: [
          {
            bookingReference: fixture.bookingReference,
            passengerReference: fixture.passengerReference,
            seat: { label: '1A' },
            boarding: null,
          },
        ],
      },
    });
    expect(first.body.contentHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(first.body)).not.toContain(fixture.notCheckedIn);
    for (const forbidden of [
      'credentialReference',
      'qrPayload',
      'checkedInByIdentityId',
      'boardedByIdentityId',
      'deviceId',
      'clientEventId',
      'readinessSnapshot',
      'readinessFingerprint',
      'complianceEvaluationId',
      'complianceReviewId',
      'documentNumber',
      'payment',
      'customerEmail',
      'baggage',
    ]) {
      expect(JSON.stringify(first.body)).not.toContain(forbidden);
    }

    const boarded = await boardingApi(dispatcher).scan({
      qrPayload: fixture.checkIn.qrPayload,
      deviceId: 'manifest-gate',
    });
    expect(boarded.status, boarded.text).toBe(201);
    const second = await api.generate(fixture.journey.tripReference);
    expect(second.status, second.text).toBe(201);
    expect(second.body).toMatchObject({ version: 2, passengerCount: 1, boardedCount: 1 });
    expect(second.body.snapshot.passengers[0].boarding).toMatchObject({
      reference: boarded.body.boarding.reference,
    });
    expect(second.body.contentHash).not.toBe(first.body.contentHash);

    const old = await api.detail(first.body.reference as string);
    expect(old.status).toBe(200);
    expect(old.body.snapshot.passengers[0].boarding).toBeNull();
    const history = await api.list(fixture.journey.tripReference, 'limit=1');
    expect(history.status).toBe(200);
    expect(history.body.items).toHaveLength(1);
    expect(history.body.items[0].version).toBe(2);
    expect(history.body.nextCursor).toBe(2);
    const previous = await api.list(fixture.journey.tripReference, 'limit=1&cursor=2');
    expect(previous.body.items.map((item: { version: number }) => item.version)).toEqual([1]);

    const csv = await api.exportCsv(first.body.reference as string);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['cache-control']).toBe('private, no-store');
    expect(csv.headers['content-disposition']).toBe(
      `attachment; filename="passenger-manifest-${fixture.journey.tripReference}-v1.csv"`,
    );
    expect(csv.text).toContain('manifest_reference,manifest_version,trip_reference');
    expect(csv.text).toContain(`${first.body.reference},1,${fixture.journey.tripReference}`);
    expect(csv.text).toContain(',false,\r\n');

    const actions = await db(t.app).auditEvent.findMany({
      where: {
        resourceType: 'passenger_manifest',
        action: {
          in: [
            'PASSENGER_MANIFEST_GENERATED',
            'PASSENGER_MANIFEST_ACCESSED',
            'PASSENGER_MANIFEST_EXPORTED',
          ],
        },
        metadata: { path: ['tripReference'], equals: fixture.journey.tripReference },
      },
    });
    expect(actions.filter((event) => event.action === 'PASSENGER_MANIFEST_GENERATED')).toHaveLength(
      2,
    );
    expect(actions.some((event) => event.action === 'PASSENGER_MANIFEST_ACCESSED')).toBe(true);
    expect(actions.some((event) => event.action === 'PASSENGER_MANIFEST_EXPORTED')).toBe(true);
    expect(JSON.stringify(actions)).not.toContain(customer.email);
    expect(JSON.stringify(actions)).not.toContain(
      first.body.snapshot.passengers[0].familyName as string,
    );
  }, 30_000);

  it('accepts an empty checked-in set and refuses DRAFT or CANCELLED trips', async () => {
    const scheduled = await bookableFixture(t.app);
    const empty = await manifestApi(dispatcher).generate(scheduled.tripReference);
    expect(empty.status, empty.text).toBe(201);
    expect(empty.body).toMatchObject({ version: 1, passengerCount: 0, boardedCount: 0 });
    expect(empty.body.snapshot.passengers).toEqual([]);

    const draft = await bookableFixture(t.app, { status: 'DRAFT' });
    const draftResponse = await manifestApi(dispatcher).generate(draft.tripReference);
    expect(draftResponse.status).toBe(409);
    expect(draftResponse.body.code).toBe('MANIFEST_TRIP_NOT_SCHEDULED');

    const cancelled = await bookableFixture(t.app);
    await db(t.app).trip.update({
      where: { id: cancelled.tripId },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
    const cancelledResponse = await manifestApi(dispatcher).generate(cancelled.tripReference);
    expect(cancelledResponse.status).toBe(409);
    expect(cancelledResponse.body.code).toBe('MANIFEST_TRIP_NOT_SCHEDULED');
    expect(
      await db(t.app).passengerManifest.count({
        where: { tripId: { in: [draft.tripId, cancelled.tripId] } },
      }),
    ).toBe(0);
  }, 30_000);

  it('requires read, generate and export independently, plus CSRF for generation', async () => {
    const trip = await bookableFixture(t.app);
    const existing = await manifestApi(dispatcher).generate(trip.tripReference);
    expect(existing.status).toBe(201);
    const [readRole, generateRole, exportRole] = await Promise.all([
      createTestRole(t.app, ['ops.access', 'manifest.read']),
      createTestRole(t.app, ['ops.access', 'manifest.generate']),
      createTestRole(t.app, ['ops.access', 'manifest.export']),
    ]);
    const [reader, generator, exporter] = await Promise.all([
      staffActor(t.app, [readRole]),
      staffActor(t.app, [generateRole]),
      staffActor(t.app, [exportRole]),
    ]);
    expect((await manifestApi(reader).list(trip.tripReference)).status).toBe(200);
    expect((await manifestApi(reader).detail(existing.body.reference as string)).status).toBe(200);
    expect((await manifestApi(reader).generate(trip.tripReference)).status).toBe(403);
    expect((await manifestApi(reader).exportCsv(existing.body.reference as string)).status).toBe(
      403,
    );

    expect((await manifestApi(generator).list(trip.tripReference)).status).toBe(403);
    expect(
      (await manifestApi(generator).generate(trip.tripReference, {}, { csrf: null })).status,
    ).toBe(403);
    expect((await manifestApi(generator).generate(trip.tripReference)).status).toBe(201);
    expect((await manifestApi(generator).exportCsv(existing.body.reference as string)).status).toBe(
      403,
    );

    expect((await manifestApi(exporter).list(trip.tripReference)).status).toBe(403);
    expect((await manifestApi(exporter).detail(existing.body.reference as string)).status).toBe(
      403,
    );
    expect((await manifestApi(exporter).generate(trip.tripReference)).status).toBe(403);
    expect((await manifestApi(exporter).exportCsv(existing.body.reference as string)).status).toBe(
      200,
    );
    expect((await manifestApi(bookingAgent).list(trip.tripReference)).status).toBe(403);
  }, 60_000);

  it('refuses CUSTOMER and CREW sessions at the STAFF boundary', async () => {
    const customerResponse = await client(t.app, 'staff').get(
      '/v1/admin/manifests?tripReference=ET-UNKNOWN',
      customer.cookie,
    );
    expect(customerResponse.status).toBe(401);
    const crew = await createIdentity(t.app, { realm: 'crew' });
    await db(t.app).authorizationRoleAssignment.create({
      data: { identityId: crew.id, roleKey: 'CREW' },
    });
    const crewCookie = await loginCookie(t.app, 'crew', crew.email);
    expect(
      (await client(t.app, 'staff').get('/v1/admin/manifests?tripReference=ET-UNKNOWN', crewCookie))
        .status,
    ).toBe(401);
  });

  it('serializes concurrent explicit generations into unique contiguous versions', async () => {
    const trip = await bookableFixture(t.app);
    const [left, right] = await Promise.all([
      manifestApi(dispatcher).generate(trip.tripReference),
      manifestApi(dispatcher).generate(trip.tripReference),
    ]);
    expect([left.status, right.status]).toEqual([201, 201]);
    expect([left.body.version, right.body.version].sort()).toEqual([1, 2]);
    const rows = await db(t.app).passengerManifest.findMany({
      where: { tripId: trip.tripId },
      orderBy: { version: 'asc' },
      select: { version: true, reference: true },
    });
    expect(rows.map((row) => row.version)).toEqual([1, 2]);
    expect(new Set(rows.map((row) => row.reference)).size).toBe(2);
  }, 30_000);
});
