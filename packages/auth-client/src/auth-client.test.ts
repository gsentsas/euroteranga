import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  createAuthClient,
  type AdminFareTable,
  type AdminSeatMap,
  type AdminTrip,
  type AdminTripSummary,
  type AdminVehicle,
  type Page,
  type AdminVehicleDetail,
  type ApiResult,
  type ResolvedTripFare,
  type NetworkRouteVersion,
  type NetworkWaypointReplacement,
} from './index.js';

type Call = { url: string; init: RequestInit };

function mockFetch(responses: Array<{ status: number; body?: unknown }>) {
  const calls: Call[] = [];
  const queue = [...responses];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const next = queue.shift() ?? { status: 500 };
      return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
        status: next.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('auth client', () => {
  it('always sends credentials and JSON bodies, never caches', async () => {
    const calls = mockFetch([{ status: 200, body: { status: 'AUTHENTICATED' } }]);
    const result = await createAuthClient('http://api.test/').login(
      'customer',
      'a@example.test',
      'pw',
    );
    expect(result).toEqual({ ok: true, data: { status: 'AUTHENTICATED' } });
    expect(calls[0]?.url).toBe('http://api.test/v1/auth/customer/login');
    expect(calls[0]?.init).toMatchObject({
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
    });
  });

  it('normalizes repeated trailing slashes without a regular expression', async () => {
    const calls = mockFetch([{ status: 200, body: { id: 'x' } }]);
    await createAuthClient('http://api.test////').me('customer');
    expect(calls[0]?.url).toBe('http://api.test/v1/auth/customer/me');
  });

  it('fetches a CSRF token in memory and sends it in X-CSRF-Token', async () => {
    const calls = mockFetch([{ status: 200, body: { csrfToken: 'v1.1.n.m' } }, { status: 204 }]);
    const result = await createAuthClient('http://api.test').logout('staff');
    expect(result.ok).toBe(true);
    expect(calls[1]?.url).toBe('http://api.test/v1/auth/staff/logout');
    expect((calls[1]?.init.headers as Record<string, string>)['X-CSRF-Token']).toBe('v1.1.n.m');
  });

  it('treats logout without a session as success (idempotent)', async () => {
    mockFetch([{ status: 401, body: { code: 'UNAUTHENTICATED', message: 'x' } }, { status: 204 }]);
    expect((await createAuthClient('http://api.test').logout('crew')).ok).toBe(true);
  });

  it('returns the public error code and message', async () => {
    mockFetch([
      {
        status: 401,
        body: { code: 'INVALID_CREDENTIALS', message: 'Email ou mot de passe incorrect.' },
      },
    ]);
    expect(await createAuthClient('http://api.test').login('crew', 'a@example.test', 'pw')).toEqual(
      {
        ok: false,
        error: {
          status: 401,
          code: 'INVALID_CREDENTIALS',
          message: 'Email ou mot de passe incorrect.',
        },
      },
    );
  });

  it('reports network failures without throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('offline'))),
    );
    const result = await createAuthClient('http://api.test').me('customer');
    expect(result).toMatchObject({ ok: false, error: { code: 'NETWORK_ERROR', status: 0 } });
  });

  it('never touches browser storage', async () => {
    const storage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() };
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('sessionStorage', storage);
    mockFetch([
      { status: 200, body: { csrfToken: 't' } },
      { status: 204 },
      { status: 200, body: { status: 'AUTHENTICATED' } },
    ]);
    const auth = createAuthClient('http://api.test');
    await auth.logout('customer');
    await auth.login('customer', 'a@example.test', 'pw');
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.getItem).not.toHaveBeenCalled();
  });
});

describe('admin client', () => {
  it('sends admin mutations with an in-memory CSRF token and encodes path parameters', async () => {
    const calls = mockFetch([{ status: 200, body: { csrfToken: 'v1.1.n.m' } }, { status: 204 }]);
    const result = await createAuthClient('http://api.test').admin.revokeSessions('id/../x');
    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toBe('http://api.test/v1/auth/staff/csrf');
    expect(calls[1]?.url).toBe(
      'http://api.test/v1/admin/identities/id%2F..%2Fx/sessions/revoke-all',
    );
    expect((calls[1]?.init.headers as Record<string, string>)['X-CSRF-Token']).toBe('v1.1.n.m');
  });

  it('builds paginated queries without undefined values', async () => {
    const calls = mockFetch([{ status: 200, body: { items: [], nextCursor: null } }]);
    await createAuthClient('http://api.test').admin.identities({ realm: 'crew', limit: 20 });
    expect(calls[0]?.url).toBe('http://api.test/v1/admin/identities?realm=crew&limit=20');
  });

  it('lists network resources with bounded pagination options', async () => {
    const calls = mockFetch([{ status: 200, body: { items: [], nextCursor: null } }]);
    await createAuthClient('http://api.test').admin.network.checkpoints({
      cursor: '0199b0fd-b600-7000-8000-000000000001',
      limit: 25,
    });
    expect(calls[0]?.url).toBe(
      'http://api.test/v1/admin/network/checkpoints?cursor=0199b0fd-b600-7000-8000-000000000001&limit=25',
    );
    expect(calls[0]?.init.method).toBe('GET');
  });

  it('creates network data through the shared in-memory CSRF flow', async () => {
    const calls = mockFetch([
      { status: 200, body: { csrfToken: 'v1.1.n.m' } },
      { status: 201, body: { id: 'country-id', iso2: 'XA' } },
    ]);
    const result = await createAuthClient('http://api.test').admin.network.createCountry({
      iso2: 'XA',
      iso3: 'XAA',
      name: 'Pays synthétique',
      active: true,
    });
    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toBe('http://api.test/v1/auth/staff/csrf');
    expect(calls[1]?.url).toBe('http://api.test/v1/admin/network/countries');
    expect(calls[1]?.init).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'v1.1.n.m' },
      body: JSON.stringify({ iso2: 'XA', iso3: 'XAA', name: 'Pays synthétique', active: true }),
    });
  });

  it('encodes route identifiers and replaces the complete ordered waypoint list', async () => {
    const calls = mockFetch([{ status: 200, body: { csrfToken: 'token' } }, { status: 200 }]);
    await createAuthClient('http://api.test').admin.network.replaceWaypoints(
      'route/../id',
      'version/../id',
      [
        {
          kind: 'STOP',
          stopId: 'stop-id',
          boardingAllowed: true,
          alightingAllowed: false,
        },
        { kind: 'CHECKPOINT', checkpointId: 'checkpoint-id' },
      ],
    );
    expect(calls[1]?.url).toBe(
      'http://api.test/v1/admin/network/routes/route%2F..%2Fid/versions/version%2F..%2Fid/waypoints',
    );
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      waypoints: [
        {
          kind: 'STOP',
          stopId: 'stop-id',
          boardingAllowed: true,
          alightingAllowed: false,
        },
        { kind: 'CHECKPOINT', checkpointId: 'checkpoint-id' },
      ],
    });
  });

  it('types network results as the API returns them', () => {
    const network = createAuthClient('http://api.test').admin.network;
    // A new draft is a route version; a waypoint replacement returns the list.
    expectTypeOf(network.createVersion).returns.resolves.toEqualTypeOf<
      ApiResult<NetworkRouteVersion>
    >();
    expectTypeOf(network.replaceWaypoints).returns.resolves.toEqualTypeOf<
      ApiResult<NetworkWaypointReplacement>
    >();
    expectTypeOf(network.publishVersion).returns.resolves.toEqualTypeOf<
      ApiResult<NetworkRouteVersion>
    >();
  });

  it('lists vehicles with bounded options and a status filter', async () => {
    const calls = mockFetch([{ status: 200, body: { items: [], nextCursor: null } }]);
    await createAuthClient('http://api.test').admin.fleet.vehicles({
      limit: 25,
      status: 'OUT_OF_SERVICE',
    });
    expect(calls[0]?.url).toBe(
      'http://api.test/v1/admin/fleet/vehicles?limit=25&status=OUT_OF_SERVICE',
    );
    expect(calls[0]?.init.method).toBe('GET');
  });

  it('changes a vehicle status through the in-memory CSRF flow, with its reason', async () => {
    const calls = mockFetch([
      { status: 200, body: { csrfToken: 'v1.1.n.m' } },
      { status: 200, body: { id: 'vehicle-id', status: 'ACTIVE' } },
    ]);
    const result = await createAuthClient('http://api.test').admin.fleet.changeVehicleStatus(
      'vehicle/../id',
      { status: 'ACTIVE', reason: 'Mise en service', expectedStatus: 'PLANNED' },
    );
    expect(result.ok).toBe(true);
    expect(calls[1]?.url).toBe('http://api.test/v1/admin/fleet/vehicles/vehicle%2F..%2Fid/status');
    expect(calls[1]?.init).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'v1.1.n.m' },
    });
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      status: 'ACTIVE',
      reason: 'Mise en service',
      expectedStatus: 'PLANNED',
    });
  });

  it('types fleet results and refuses PLANNED as a transition target', () => {
    const fleet = createAuthClient('http://api.test').admin.fleet;
    expectTypeOf(fleet.vehicle).returns.resolves.toEqualTypeOf<ApiResult<AdminVehicleDetail>>();
    expectTypeOf(fleet.createVehicle).returns.resolves.toEqualTypeOf<ApiResult<AdminVehicle>>();
    expectTypeOf(fleet.changeVehicleStatus).returns.resolves.toEqualTypeOf<
      ApiResult<AdminVehicle>
    >();
    expectTypeOf(fleet.changeVehicleStatus)
      .parameter(1)
      .toHaveProperty('status')
      .toEqualTypeOf<'ACTIVE' | 'OUT_OF_SERVICE' | 'RETIRED'>();
    // The general update cannot carry a status.
    expectTypeOf(fleet.updateVehicle).parameter(1).not.toHaveProperty('status');
  });

  it('lists trips with bounded options and filters', async () => {
    const calls = mockFetch([{ status: 200, body: { items: [], nextCursor: null } }]);
    await createAuthClient('http://api.test').admin.trips.trips({
      limit: 20,
      status: 'SCHEDULED',
      routeId: 'route-id',
      departureFrom: '2030-01-15T00:00:00Z',
    });
    expect(calls[0]?.url).toBe(
      'http://api.test/v1/admin/trips?limit=20&status=SCHEDULED&routeId=route-id&departureFrom=2030-01-15T00%3A00%3A00Z',
    );
  });

  it('replaces a timetable and cancels a trip through the in-memory CSRF flow', async () => {
    const calls = mockFetch([
      { status: 200, body: { csrfToken: 'v1.1.n.m' } },
      { status: 200, body: { id: 'trip-id' } },
      { status: 200, body: { csrfToken: 'v1.2.n.m' } },
      { status: 200, body: { id: 'trip-id', status: 'CANCELLED' } },
    ]);
    const trips = createAuthClient('http://api.test').admin.trips;
    const timings = [
      { routeWaypointId: 'w1', plannedArrivalAt: null, plannedDepartureAt: '2030-01-15T08:00:00Z' },
      { routeWaypointId: 'w2', plannedArrivalAt: '2030-01-15T12:00:00Z', plannedDepartureAt: null },
    ];
    await trips.replaceTimetable('trip/../id', { timings });
    await trips.cancelTrip('trip-id', { reason: 'Annulation', expectedStatus: 'SCHEDULED' });
    expect(calls[1]?.url).toBe('http://api.test/v1/admin/trips/trip%2F..%2Fid/timetable');
    expect(calls[1]?.init).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'v1.1.n.m' },
    });
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ timings });
    expect(calls[3]?.url).toBe('http://api.test/v1/admin/trips/trip-id/cancel');
    expect(JSON.parse(String(calls[3]?.init.body))).toEqual({
      reason: 'Annulation',
      expectedStatus: 'SCHEDULED',
    });
  });

  it('types trip results and inputs', () => {
    const trips = createAuthClient('http://api.test').admin.trips;
    expectTypeOf(trips.trips).returns.resolves.toEqualTypeOf<ApiResult<Page<AdminTripSummary>>>();
    expectTypeOf(trips.trip).returns.resolves.toEqualTypeOf<ApiResult<AdminTrip>>();
    expectTypeOf(trips.scheduleTrip).returns.resolves.toEqualTypeOf<ApiResult<AdminTrip>>();
    expectTypeOf(trips.assignTripVehicle)
      .parameter(1)
      .toHaveProperty('vehicleId')
      .toEqualTypeOf<string | null>();
    // The status changes only through schedule/cancel, never at creation.
    expectTypeOf(trips.createTrip).parameter(0).not.toHaveProperty('status');
  });

  it('lists seat maps and replaces a draft layout through the in-memory CSRF flow', async () => {
    const calls = mockFetch([
      { status: 200, body: { items: [], nextCursor: null } },
      { status: 200, body: { csrfToken: 'v1.1.n.m' } },
      { status: 200, body: { id: 'map' } },
    ]);
    const seatMaps = createAuthClient('http://api.test').admin.seatMaps;
    await seatMaps.seatMaps({ limit: 10, active: true });
    const cells = [
      { deck: 1, row: 1, column: 1, kind: 'DRIVER' as const },
      { deck: 1, row: 2, column: 1, kind: 'SEAT' as const, seatLabel: '1A' },
    ];
    await seatMaps.replaceCells('map/../id', 'version-id', { cells });
    expect(calls[0]?.url).toBe('http://api.test/v1/admin/seat-maps?limit=10&active=true');
    expect(calls[2]?.url).toBe(
      'http://api.test/v1/admin/seat-maps/map%2F..%2Fid/versions/version-id/cells',
    );
    expect(calls[2]?.init).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'v1.1.n.m' },
    });
    expect(JSON.parse(String(calls[2]?.init.body))).toEqual({ cells });
  });

  it('assigns seat maps to vehicles and trips with an expected state', async () => {
    const calls = mockFetch([
      { status: 200, body: { csrfToken: 'a' } },
      { status: 200, body: {} },
      { status: 200, body: { csrfToken: 'b' } },
      { status: 200, body: {} },
    ]);
    const admin = createAuthClient('http://api.test').admin;
    await admin.fleet.assignVehicleSeatMap('vehicle-id', {
      seatMapVersionId: 'version-id',
      expectedSeatMapVersionId: null,
    });
    await admin.trips.assignTripSeatMap('trip-id', { seatMapVersionId: null });
    expect(calls[1]?.url).toBe('http://api.test/v1/admin/fleet/vehicles/vehicle-id/seat-map');
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      seatMapVersionId: 'version-id',
      expectedSeatMapVersionId: null,
    });
    expect(calls[3]?.url).toBe('http://api.test/v1/admin/trips/trip-id/seat-map');
  });

  it('types seat-map results and keeps capacity computed', () => {
    const admin = createAuthClient('http://api.test').admin;
    expectTypeOf(admin.seatMaps.seatMap).returns.resolves.toEqualTypeOf<ApiResult<AdminSeatMap>>();
    expectTypeOf(admin.trips.assignTripSeatMap).returns.resolves.toEqualTypeOf<
      ApiResult<AdminTrip>
    >();
    expectTypeOf<AdminSeatMap['versions'][number]['seatCount']>().toEqualTypeOf<number>();
    // No capacity can be sent: it is derived from SEAT cells.
    expectTypeOf(admin.seatMaps.replaceCells).parameter(2).not.toHaveProperty('seatCount');
    expectTypeOf(admin.fleet.updateVehicle).parameter(1).not.toHaveProperty('seatMapVersionId');
  });

  it('replaces a fare matrix in minor units through the in-memory CSRF flow', async () => {
    const calls = mockFetch([
      { status: 200, body: { csrfToken: 'v1.1.n.m' } },
      { status: 200, body: { id: 'table' } },
    ]);
    const fares = [
      { originRouteWaypointId: 'a', destinationRouteWaypointId: 'b', amountMinor: 12345 },
    ];
    await createAuthClient('http://api.test').admin.pricing.replaceFares(
      'table/../id',
      'version-id',
      { fares },
    );
    expect(calls[1]?.url).toBe(
      'http://api.test/v1/admin/pricing/fare-tables/table%2F..%2Fid/versions/version-id/fares',
    );
    expect(calls[1]?.init).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'v1.1.n.m' },
    });
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ fares });
  });

  it('resolves a trip fare with query parameters and assigns a fare table', async () => {
    const calls = mockFetch([
      { status: 200, body: { amountMinor: 12345, currencyCode: 'EUR', currencyMinorUnit: 2 } },
      { status: 200, body: { csrfToken: 'x' } },
      { status: 200, body: {} },
      { status: 200, body: { items: [], nextCursor: null } },
    ]);
    const admin = createAuthClient('http://api.test').admin;
    const resolved = await admin.trips.resolveTripFare('trip-id', 'origin-id', 'destination-id');
    expect(resolved).toMatchObject({ ok: true, data: { amountMinor: 12345 } });
    expect(calls[0]?.url).toBe(
      'http://api.test/v1/admin/trips/trip-id/fare?originRouteWaypointId=origin-id&destinationRouteWaypointId=destination-id',
    );
    await admin.trips.assignTripFareTable('trip-id', {
      fareTableVersionId: 'v',
      expectedFareTableVersionId: null,
    });
    expect(calls[2]?.url).toBe('http://api.test/v1/admin/trips/trip-id/fare-table');
    await admin.pricing.fareTables({ active: true, routeId: 'route-id', limit: 5 });
    expect(calls[3]?.url).toBe(
      'http://api.test/v1/admin/pricing/fare-tables?limit=5&active=true&routeId=route-id',
    );
  });

  it('types pricing results with exact integer amounts', () => {
    const admin = createAuthClient('http://api.test').admin;
    expectTypeOf(admin.pricing.fareTable).returns.resolves.toEqualTypeOf<
      ApiResult<AdminFareTable>
    >();
    expectTypeOf(admin.trips.resolveTripFare).returns.resolves.toEqualTypeOf<
      ApiResult<ResolvedTripFare>
    >();
    expectTypeOf<ResolvedTripFare['amountMinor']>().toEqualTypeOf<number>();
    // Route and currency cannot be updated.
    expectTypeOf(admin.pricing.updateFareTable).parameter(1).not.toHaveProperty('currencyCode');
    expectTypeOf(admin.pricing.updateFareTable).parameter(1).not.toHaveProperty('routeId');
  });
});
