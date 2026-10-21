import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminApi,
  createTestRole,
  isolatedDatabase,
  staffActor,
  type StaffActor,
} from '../../support/admin-helpers.js';
import { db } from '../../support/auth-helpers.js';
import { bookableFixture } from '../../support/booking-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

const UNKNOWN_ID = '01900000-0000-7000-8000-000000000000';
const code = () => `PF_${randomBytes(4).toString('hex').toUpperCase()}`;

/**
 * UI-PUBLIC-2: on-board equipment maintained by the fleet team, the public
 * fleet read ("Nos bus") and the public itinerary of a bookable trip. Own
 * database: the public fleet lists every active vehicle.
 */
describe('public fleet and itinerary (isolated database)', () => {
  let t: TestApp;
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let manager: StaffActor;
  let reader: StaffActor;
  let editor: StaffActor;
  let managerWithoutMedia: StaffActor;

  beforeAll(async () => {
    database = await isolatedDatabase();
    t = await startTestApp(integrationEnv({ DATABASE_URL: database.url }));
    const fleetOnly = await createTestRole(t.app, ['ops.access', 'fleet.read', 'fleet.manage']);
    [manager, reader, editor, managerWithoutMedia] = await Promise.all([
      staffActor(t.app, ['OPS_MANAGER']),
      staffActor(t.app, ['DISPATCHER']),
      staffActor(t.app, ['CONTENT_EDITOR']),
      staffActor(t.app, [fleetOnly]),
    ]);
  });

  afterAll(async () => {
    await t.app.close();
    await database.drop();
  });

  const publicGet = (path: string) =>
    request(t.app.getHttpServer()).get(`/v1${path}`).set('Origin', 'http://localhost:3000');

  async function vehicle(overrides: Record<string, unknown> = {}) {
    const response = await adminApi(manager).post('/fleet/vehicles', {
      code: code(),
      manufacturer: 'Constructeur synthétique',
      model: 'Autocar synthétique',
      ...overrides,
    });
    if (response.status !== 201) throw new Error(`vehicle: ${response.status} ${response.text}`);
    return response.body as { id: string; code: string; amenities: string[] };
  }

  async function activate(id: string) {
    const response = await adminApi(manager).post(`/fleet/vehicles/${id}/status`, {
      status: 'ACTIVE',
      reason: 'Mise en service synthétique',
    });
    if (response.status !== 200) throw new Error(`status: ${response.status} ${response.text}`);
  }

  async function media(label: string) {
    const sourceSha256 = randomBytes(32).toString('hex');
    const renditionSha256 = randomBytes(32).toString('hex');
    return db(t.app).publicMediaAsset.create({
      data: {
        altText: label,
        sourceFormat: 'jpeg',
        sourceSha256,
        sourceBytes: 1_024,
        width: 1_200,
        height: 800,
        renditions: {
          create: {
            width: 960,
            height: 640,
            format: 'webp',
            bytes: 512,
            sha256: renditionSha256,
            storageKey: `public-media/${renditionSha256.slice(0, 2)}/${renditionSha256}`,
          },
        },
      },
    });
  }

  it('keeps on-board equipment as a distinct, ordered list maintained under fleet.manage', async () => {
    const created = await vehicle({ amenities: ['WIFI', 'AIR_CONDITIONING', 'WIFI'] });
    // Stored once each, in the canonical order.
    expect(created.amenities).toEqual(['AIR_CONDITIONING', 'WIFI']);
    expect((await vehicle()).amenities).toEqual([]);

    const updated = await adminApi(manager).post(`/fleet/vehicles/${created.id}`, {
      amenities: ['TOILET', 'USB_CHARGING', 'RECLINING_SEATS'],
    });
    expect(updated.status).toBe(200);
    expect(updated.body.amenities).toEqual(['RECLINING_SEATS', 'USB_CHARGING', 'TOILET']);
    const audit = await db(t.app).auditEvent.findFirst({
      where: { action: 'VEHICLE_UPDATED', resourceId: created.id },
      orderBy: { occurredAt: 'desc' },
    });
    expect((audit?.before as { amenities: string[] }).amenities).toEqual([
      'AIR_CONDITIONING',
      'WIFI',
    ]);
    expect((audit?.after as { amenities: string[] }).amenities).toEqual([
      'RECLINING_SEATS',
      'USB_CHARGING',
      'TOILET',
    ]);

    for (const amenities of [['JACUZZI'], 'WIFI', [1]]) {
      expect(
        (await adminApi(manager).post(`/fleet/vehicles/${created.id}`, { amenities })).status,
      ).toBe(400);
    }
    // fleet.read alone cannot change it.
    expect(
      (await adminApi(reader).post(`/fleet/vehicles/${created.id}`, { amenities: [] })).status,
    ).toBe(403);
    // The database refuses duplicates even outside the API.
    await expect(
      db(t.app).$executeRaw`
        UPDATE "vehicle" SET "amenities" = ARRAY['WIFI','WIFI']::"vehicle_amenity"[]
        WHERE "id" = ${created.id}::uuid`,
    ).rejects.toThrow();
  });

  it('lists active vehicles with public facts only', async () => {
    const fixture = await bookableFixture(t.app);
    const shown = await vehicle({
      name: 'Teranga Test 01',
      vin: 'ZZZ00000000000001',
      amenities: ['WIFI', 'TOILET'],
      modelYear: 2024,
    });
    await adminApi(manager).post(`/fleet/vehicles/${shown.id}/seat-map`, {
      seatMapVersionId: fixture.seatMapVersionId,
    });
    await activate(shown.id);
    const planned = await vehicle({ name: 'Pas encore en service' });

    const response = await publicGet('/booking/fleet');
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('public, max-age=300');
    const item = (response.body.items as Array<Record<string, unknown>>).find(
      (candidate) => candidate.code === shown.code,
    );
    expect(item).toEqual({
      code: shown.code,
      name: 'Teranga Test 01',
      manufacturer: 'Constructeur synthétique',
      model: 'Autocar synthétique',
      modelYear: 2024,
      amenities: ['WIFI', 'TOILET'],
      seatCount: 4,
      primaryMedia: null,
      gallery: [],
    });
    expect(response.text).not.toContain(planned.code);
    expect(response.text).not.toContain('ZZZ00000000000001');
    expect(response.text).not.toMatch(/registration|vin|status|seatMap/i);
  });

  it('attaches MEDIA-1 images atomically, audits them and protects every usage', async () => {
    const coach = await vehicle({ name: 'Teranga Médias' });
    const [primary, interior, archived] = await Promise.all([
      media('Autocar bleu vu de face'),
      media('Intérieur de l’autocar'),
      media('Ancienne photo'),
    ]);
    const assigned = await adminApi(manager).post(`/fleet/vehicles/${coach.id}/media`, {
      primaryMediaId: primary.id,
      gallery: [{ mediaId: interior.id, kind: 'INTERIOR' }],
    });
    expect(assigned.status).toBe(200);
    expect(assigned.body.primaryMedia).toMatchObject({
      id: primary.id,
      altText: 'Autocar bleu vu de face',
    });
    expect(assigned.body.mediaGallery).toMatchObject([
      { mediaId: interior.id, kind: 'INTERIOR', position: 0 },
    ]);
    const audit = await db(t.app).auditEvent.findFirstOrThrow({
      where: { action: 'VEHICLE_MEDIA_CHANGED', resourceId: coach.id },
    });
    expect(audit.actorIdentityId).toBe(manager.id);
    expect(audit.before).toEqual({ primaryMediaId: null, mediaGallery: [] });
    expect(audit.after).toEqual({
      primaryMediaId: primary.id,
      mediaGallery: [{ mediaId: interior.id, kind: 'INTERIOR', position: 0 }],
    });

    // UUID text case is not a semantic change: no rewrite and no duplicate audit.
    const auditCount = await db(t.app).auditEvent.count({
      where: { action: 'VEHICLE_MEDIA_CHANGED', resourceId: coach.id },
    });
    const sameMediaUppercase = await adminApi(manager).post(`/fleet/vehicles/${coach.id}/media`, {
      primaryMediaId: primary.id.toUpperCase(),
      gallery: [{ mediaId: interior.id.toUpperCase(), kind: 'INTERIOR' }],
    });
    expect(sameMediaUppercase.status).toBe(200);
    expect(sameMediaUppercase.body.primaryMedia.id).toBe(primary.id);
    expect(sameMediaUppercase.body.mediaGallery[0].mediaId).toBe(interior.id);
    expect(
      await db(t.app).auditEvent.count({
        where: { action: 'VEHICLE_MEDIA_CHANGED', resourceId: coach.id },
      }),
    ).toBe(auditCount);

    // fleet.manage alone is insufficient: selecting library images needs media.read.
    expect(
      (
        await adminApi(managerWithoutMedia).post(`/fleet/vehicles/${coach.id}/media`, {
          primaryMediaId: primary.id,
          gallery: [],
        })
      ).status,
    ).toBe(403);

    const archiveInUse = await adminApi(editor).post(`/media/${primary.id}/archive`, {
      reason: 'Remplacement synthétique',
    });
    expect(archiveInUse.status).toBe(409);
    expect(archiveInUse.body).toMatchObject({
      code: 'MEDIA_IN_USE',
      details: {
        usages: [{ kind: 'VEHICLE', key: coach.code, status: 'PLANNED', entryArchived: false }],
      },
    });

    expect(
      (
        await adminApi(editor).post(`/media/${archived.id}/archive`, {
          reason: 'Photo obsolète',
        })
      ).status,
    ).toBe(200);
    const refused = await adminApi(manager).post(`/fleet/vehicles/${coach.id}/media`, {
      primaryMediaId: archived.id,
      gallery: [],
    });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('VEHICLE_MEDIA_UNAVAILABLE');

    await adminApi(manager).post(`/fleet/vehicles/${coach.id}/status`, {
      status: 'RETIRED',
      reason: 'Fin de test synthétique',
    });
    expect(
      (
        await adminApi(manager).post(`/fleet/vehicles/${coach.id}/media`, {
          primaryMediaId: null,
          gallery: [],
        })
      ).status,
    ).toBe(409);
  });

  it('serves real vehicle media to fleet and departure cards without internal fields', async () => {
    const fixture = await bookableFixture(t.app);
    const coach = await vehicle({ name: 'Teranga Départ', amenities: ['WIFI'] });
    const [primary, interior] = await Promise.all([
      media('Autocar affecté au départ'),
      media('Galerie de l’autocar affecté'),
    ]);
    await adminApi(manager).post(`/fleet/vehicles/${coach.id}/seat-map`, {
      seatMapVersionId: fixture.seatMapVersionId,
    });
    await adminApi(manager).post(`/fleet/vehicles/${coach.id}/media`, {
      primaryMediaId: primary.id,
      gallery: [{ mediaId: interior.id, kind: 'SEATS' }],
    });
    await activate(coach.id);
    await db(t.app).trip.update({ where: { id: fixture.tripId }, data: { vehicleId: coach.id } });

    const fleet = await publicGet('/booking/fleet');
    const publicCoach = fleet.body.items.find(
      (candidate: { code: string }) => candidate.code === coach.code,
    );
    expect(publicCoach.primaryMedia).toMatchObject({ id: primary.id });
    expect(publicCoach.primaryMedia).not.toHaveProperty('status');
    expect(publicCoach.gallery).toMatchObject([{ id: interior.id, kind: 'SEATS', position: 0 }]);
    expect(JSON.stringify(publicCoach)).not.toMatch(/sourceSha256|storageKey|primaryMediaId/);

    const search = await publicGet(
      `/booking/trips?originStopId=${fixture.stopIds[0]}&destinationStopId=${fixture.stopIds[4]}`,
    );
    const journey = search.body.items.find(
      (candidate: { tripId: string }) => candidate.tripId === fixture.tripId,
    );
    expect(journey.vehiclePrimaryMedia).toMatchObject({ id: primary.id });

    await adminApi(manager).post(`/fleet/vehicles/${coach.id}/status`, {
      status: 'OUT_OF_SERVICE',
      reason: 'Indisponibilité synthétique',
    });
    const hidden = await publicGet(
      `/booking/trips?originStopId=${fixture.stopIds[0]}&destinationStopId=${fixture.stopIds[4]}`,
    );
    expect(
      hidden.body.items.find((candidate: { tripId: string }) => candidate.tripId === fixture.tripId)
        .vehiclePrimaryMedia,
    ).toBeNull();
  });

  it('describes the planned itinerary of a bookable trip and nothing else', async () => {
    const fixture = await bookableFixture(t.app, { withCheckpoint: true });
    const response = await publicGet(`/booking/trips/${fixture.tripId}/itinerary`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      tripId: fixture.tripId,
      tripReference: fixture.tripReference,
      route: { name: 'Route réservation' },
      vehicle: null,
    });
    const waypoints = response.body.waypoints as Array<Record<string, unknown>>;
    // The technical checkpoint stays internal.
    expect(waypoints.map((waypoint) => waypoint.kind)).toEqual([
      'STOP',
      'STOP',
      'STOP',
      'STOP',
      'STOP',
    ]);
    expect(waypoints.map((waypoint) => waypoint.sequence)).toEqual([1, 2, 4, 5, 6]);
    expect(waypoints[0]).toMatchObject({
      sequence: 1,
      name: 'Arrêt réservation 1',
      locality: 'Localité 1',
      timezone: 'Etc/UTC',
      boardingAllowed: true,
      alightingAllowed: false,
    });
    expect(waypoints[0]!.plannedDepartureAt).toEqual(expect.any(String));
    expect(waypoints.at(-1)!.plannedArrivalAt).toEqual(expect.any(String));
    expect(response.text).not.toContain('Point de contrôle');
    // A border crossing is public, with its country and planned times.
    const checkpoint = await db(t.app).routeWaypoint.findUniqueOrThrow({
      where: { id: fixture.checkpointWaypointId! },
      select: { checkpointId: true },
    });
    await db(t.app).checkpoint.update({
      where: { id: checkpoint.checkpointId! },
      data: { type: 'BORDER' },
    });
    const border = (await publicGet(`/booking/trips/${fixture.tripId}/itinerary`)).body
      .waypoints[2];
    expect(border).toMatchObject({
      sequence: 3,
      kind: 'CHECKPOINT',
      code: null,
      name: 'Point de contrôle',
      checkpointType: 'BORDER',
      country: { iso2: expect.any(String) },
    });
    expect(border.plannedArrivalAt).toEqual(expect.any(String));

    // The assigned vehicle is shown while it is active.
    const coach = await vehicle({ name: 'Teranga Test 02', amenities: ['AIR_CONDITIONING'] });
    await adminApi(manager).post(`/fleet/vehicles/${coach.id}/seat-map`, {
      seatMapVersionId: fixture.seatMapVersionId,
    });
    await activate(coach.id);
    await db(t.app).trip.update({ where: { id: fixture.tripId }, data: { vehicleId: coach.id } });
    const withVehicle = await publicGet(`/booking/trips/${fixture.tripId}/itinerary`);
    expect(withVehicle.body.vehicle).toEqual({
      code: coach.code,
      name: 'Teranga Test 02',
      manufacturer: 'Constructeur synthétique',
      model: 'Autocar synthétique',
      modelYear: null,
      amenities: ['AIR_CONDITIONING'],
    });
    await adminApi(manager).post(`/fleet/vehicles/${coach.id}/status`, {
      status: 'OUT_OF_SERVICE',
      reason: 'Panne synthétique',
    });
    expect((await publicGet(`/booking/trips/${fixture.tripId}/itinerary`)).body.vehicle).toBeNull();

    // Unknown, departed or cancelled trips have no public itinerary.
    expect((await publicGet(`/booking/trips/${UNKNOWN_ID}/itinerary`)).status).toBe(404);
    const departed = await bookableFixture(t.app, { departureInMs: -60 * 60 * 1000 });
    const refused = await publicGet(`/booking/trips/${departed.tripId}/itinerary`);
    expect(refused.status).toBe(404);
    expect(refused.body.code).toBe('BOOKING_TRIP_NOT_BOOKABLE');
  });
});
