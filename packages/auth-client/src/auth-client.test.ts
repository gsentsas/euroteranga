import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  createAuthClient,
  hasFareTableDetails,
  type AdminBooking,
  type AdminPaymentDetail,
  type CreatePaymentInput,
  type CreatePaymentResult,
  type CustomerPayment,
  type PaymentOptions,
  type PaymentQuote,
  type PaymentQuoteInput,
  type PaymentPage,
  type AdminFareTable,
  type BookingAvailability,
  type BookingItinerary,
  type PublicVehicle,
  type VehicleAmenity,
  type CustomerBooking,
  type AssignedFareTableVersion,
  type AdminSeatMap,
  type AdminTrip,
  type AdminTripSummary,
  type AdminVehicle,
  type Page,
  type AdminVehicleDetail,
  type ApiResult,
  type ResolvedTripFare,
  type TripFareTableIdentity,
  type TripCostPlan,
  type NetworkRouteVersion,
  type NetworkWaypointReplacement,
  type Passenger,
  type PassengerDocument,
  type PrivateDownload,
  type ComplianceEvaluationDetail,
  type CustomerBookingCompliance,
  type CustomerPassengerCompliance,
  type Baggage,
  type BaggageDetail,
  type BaggageEventResult,
  type BaggageQr,
  type BoardingResult,
  type BookingCheckInOverview,
  type CheckInReadiness,
  type CheckInResult,
  type PassengerCheckIn,
  type PassengerManifest,
  type PassengerManifestPage,
  type RegulatoryPermitDetail,
  type RegulatoryPermitSummary,
  type DepartureAuthorizationResult,
  type DepartureDispatchResult,
  type DeparturePermitPolicy,
  type DepartureReadinessResponse,
  type DepartureReadinessSnapshot,
  type StaffPassengerCheckIn,
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

describe('baggage client (PR-13)', () => {
  it('keeps customer registration narrow and encodes every public reference', async () => {
    const calls = mockFetch([
      { status: 200, body: { csrfToken: 'v1.baggage.csrf' } },
      { status: 201, body: { reference: 'ETG-AAAAAAAAAAAA' } },
      { status: 200, body: { items: [] } },
      { status: 200, body: { reference: 'ETG-A' } },
      { status: 200, body: { reference: 'ETG-A', svg: '<svg />' } },
    ]);
    const customer = createAuthClient('http://api.test').booking.customer;
    await customer.registerBaggage('ETB-A/../B', 'ETV-C/../D', { type: 'SUITCASE' });
    await customer.baggageForBooking('ETB-A/../B');
    await customer.baggage('ETG-A/../B');
    await customer.baggageQr('ETG-A/../B');

    expect(calls[1]?.url).toBe(
      'http://api.test/v1/booking/bookings/ETB-A%2F..%2FB/passengers/ETV-C%2F..%2FD/baggage',
    );
    expect(calls[1]?.init).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({ 'X-CSRF-Token': 'v1.baggage.csrf' }),
    });
    expect(JSON.parse(calls[1]?.init.body as string)).toEqual({ type: 'SUITCASE' });
    expect(calls[2]?.url).toBe('http://api.test/v1/booking/bookings/ETB-A%2F..%2FB/baggage');
    expect(calls[3]?.url).toBe('http://api.test/v1/booking/baggage/ETG-A%2F..%2FB');
    expect(calls[4]?.url).toBe('http://api.test/v1/booking/baggage/ETG-A%2F..%2FB/qr');
  });

  it('builds bounded staff filters and protects weight/events with staff CSRF', async () => {
    const calls = mockFetch([
      { status: 200, body: { items: [], nextCursor: null } },
      { status: 200, body: { csrfToken: 'v1.staff.csrf' } },
      { status: 201, body: { created: true } },
      { status: 200, body: { csrfToken: 'v1.staff.csrf' } },
      { status: 201, body: { created: true } },
    ]);
    const baggage = createAuthClient('http://api.test').admin.baggage;
    await baggage.list({
      limit: 25,
      bookingReference: 'ETB-A',
      type: 'BOX',
      lifecycleStatus: 'CHECKED_IN',
    });
    await baggage.updateWeight('ETG-A/../B', {
      measuredWeightKg: '12.345',
      occurredAt: '2030-01-01T00:00:00.000Z',
      clientEventId: 'weight-event-0001',
    });
    await baggage.scan('ETG1:ETG-AAAAAAAAAAAA', {
      type: 'LOADED',
      occurredAt: '2030-01-01T00:01:00.000Z',
      clientEventId: 'scan-event-00001',
    });

    expect(calls[0]?.url).toBe(
      'http://api.test/v1/admin/baggage?limit=25&bookingReference=ETB-A&type=BOX&lifecycleStatus=CHECKED_IN',
    );
    expect(calls[2]?.url).toBe('http://api.test/v1/admin/baggage/ETG-A%2F..%2FB/weight');
    expect(JSON.parse(calls[2]?.init.body as string)).toEqual({
      measuredWeightKg: '12.345',
      occurredAt: '2030-01-01T00:00:00.000Z',
      clientEventId: 'weight-event-0001',
    });
    expect(calls[4]?.url).toBe('http://api.test/v1/admin/baggage/scan');
    expect(JSON.parse(calls[4]?.init.body as string)).toEqual({
      qrPayload: 'ETG1:ETG-AAAAAAAAAAAA',
      type: 'LOADED',
      occurredAt: '2030-01-01T00:01:00.000Z',
      clientEventId: 'scan-event-00001',
    });
  });

  it('exposes exact safe types and no customer weight/status mutation', () => {
    const client = createAuthClient('http://api.test');
    expectTypeOf(client.booking.customer.registerBaggage).returns.resolves.toEqualTypeOf<
      ApiResult<BaggageDetail>
    >();
    expectTypeOf(client.booking.customer.baggageForBooking).returns.resolves.toEqualTypeOf<
      ApiResult<{ items: Baggage[] }>
    >();
    expectTypeOf(client.booking.customer.baggageQr).returns.resolves.toEqualTypeOf<
      ApiResult<BaggageQr>
    >();
    expectTypeOf(client.booking.customer).not.toHaveProperty('updateBaggageWeight');
    expectTypeOf(client.booking.customer).not.toHaveProperty('recordBaggageEvent');
    expectTypeOf(client.admin.baggage.updateWeight).returns.resolves.toEqualTypeOf<
      ApiResult<BaggageEventResult>
    >();
    expectTypeOf<Baggage['measuredWeightKg']>().toEqualTypeOf<string | null>();
    expectTypeOf<Baggage>().not.toHaveProperty('id');
    expectTypeOf<BaggageDetail['events'][number]>().not.toHaveProperty('actorIdentityId');
    expectTypeOf<BaggageDetail['events'][number]>().not.toHaveProperty('clientEventId');
  });
});

describe('check-in and boarding client (PR-14)', () => {
  it('encodes references, sends CSRF on every mutation and keeps blocker details', async () => {
    const calls = mockFetch([
      { status: 200, body: { items: [] } },
      { status: 200, body: { csrfToken: 'v1.checkin.csrf' } },
      { status: 201, body: { changed: true, seat: { label: '1A' } } },
      { status: 200, body: { csrfToken: 'v1.checkin.csrf' } },
      {
        status: 409,
        body: {
          code: 'CHECK_IN_NOT_READY',
          message: 'Le check-in n’est pas possible.',
          details: { blockers: [{ check: 'SEAT', code: 'SEAT_NOT_ASSIGNED' }] },
          requestId: 'r',
        },
      },
      { status: 200, body: { reference: 'ETK-AAAAAAAAAAAA', svg: '<svg/>' } },
    ]);
    const customer = createAuthClient('http://api.test').booking.customer;
    await customer.checkInOverview('ETB-A/../B');
    await customer.assignSeat('ETB-A/../B', 'ETV-C/../D', '1A');
    const refused = await customer.checkIn('ETB-A/../B', 'ETV-C/../D');
    await customer.checkInQr('ETK-A/../B');
    expect(calls[0]?.url).toBe('http://api.test/v1/booking/bookings/ETB-A%2F..%2FB/check-in');
    expect(calls[2]?.url).toBe(
      'http://api.test/v1/booking/bookings/ETB-A%2F..%2FB/passengers/ETV-C%2F..%2FD/seat',
    );
    expect(calls[2]?.init).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ seatLabel: '1A' }),
      headers: expect.objectContaining({ 'X-CSRF-Token': 'v1.checkin.csrf' }),
    });
    expect(calls[4]?.init.body).toBe('{}');
    expect(refused).toEqual({
      ok: false,
      error: {
        status: 409,
        code: 'CHECK_IN_NOT_READY',
        message: 'Le check-in n’est pas possible.',
        details: { blockers: [{ check: 'SEAT', code: 'SEAT_NOT_ASSIGNED' }] },
      },
    });
    expect(calls[5]?.url).toBe('http://api.test/v1/booking/check-ins/ETK-A%2F..%2FB/qr');
  });

  it('sends the staff list filters and the scan body as typed', async () => {
    const calls = mockFetch([
      { status: 200, body: { items: [], nextCursor: null } },
      { status: 200, body: { csrfToken: 'v1.boarding.csrf' } },
      { status: 201, body: { created: true, boarding: {} } },
    ]);
    const admin = createAuthClient('http://api.test').admin;
    await admin.checkIn.list({ tripReference: 'ET-T', checkInStatus: 'CHECKED_IN', limit: 25 });
    await admin.boarding.scan('ETPAX1:ETQ-AAAAAAAAAAAAAAAA', {
      deviceId: 'gate-01',
      clientEventId: 'scan-board-00001',
      occurredAt: '2030-01-01T00:00:00.000Z',
    });
    expect(calls[0]?.url).toBe(
      'http://api.test/v1/admin/check-in/booking-passengers?limit=25&tripReference=ET-T&checkInStatus=CHECKED_IN',
    );
    expect(calls[2]?.url).toBe('http://api.test/v1/admin/boarding/scan');
    expect(JSON.parse(String(calls[2]?.init.body))).toEqual({
      qrPayload: 'ETPAX1:ETQ-AAAAAAAAAAAAAAAA',
      deviceId: 'gate-01',
      clientEventId: 'scan-board-00001',
      occurredAt: '2030-01-01T00:00:00.000Z',
    });
  });

  it('exposes safe types: no customer boarding, no override input', () => {
    const client = createAuthClient('http://api.test');
    expectTypeOf(client.booking.customer.checkInOverview).returns.resolves.toEqualTypeOf<
      ApiResult<BookingCheckInOverview>
    >();
    expectTypeOf(client.booking.customer.checkInReadiness).returns.resolves.toEqualTypeOf<
      ApiResult<CheckInReadiness>
    >();
    expectTypeOf(client.booking.customer.checkIn).returns.resolves.toEqualTypeOf<
      ApiResult<CheckInResult<PassengerCheckIn>>
    >();
    expectTypeOf(client.booking.customer.checkIn).parameters.toEqualTypeOf<[string, string]>();
    expectTypeOf(client.booking.customer).not.toHaveProperty('board');
    expectTypeOf(client.booking.customer).not.toHaveProperty('scanBoarding');
    expectTypeOf(client.admin.checkIn.checkIn).returns.resolves.toEqualTypeOf<
      ApiResult<CheckInResult<StaffPassengerCheckIn>>
    >();
    expectTypeOf(client.admin.boarding.scan).returns.resolves.toEqualTypeOf<
      ApiResult<BoardingResult>
    >();
    expectTypeOf<PassengerCheckIn>().not.toHaveProperty('id');
    expectTypeOf<PassengerCheckIn>().not.toHaveProperty('readinessFingerprint');
    expectTypeOf<PassengerCheckIn['boarding']>().toEqualTypeOf<{
      reference: string;
      boardedAt: string;
    } | null>();
  });
});

describe('passenger manifest client (PR-15)', () => {
  it('encodes filters/references and protects every generation with STAFF CSRF', async () => {
    const calls = mockFetch([
      { status: 200, body: { items: [], nextCursor: null } },
      { status: 200, body: { reference: 'ETM-AAAAAAAAAAAA' } },
      { status: 200, body: { csrfToken: 'v1.manifest.csrf' } },
      { status: 201, body: { reference: 'ETM-BBBBBBBBBBBB', version: 2 } },
    ]);
    const manifests = createAuthClient('http://api.test').admin.manifests;
    await manifests.list({ tripReference: 'ET T/../X', cursor: 3, limit: 25 });
    await manifests.detail('ETM-A/../B');
    await manifests.generate('ET T/../X');
    expect(calls[0]?.url).toBe(
      'http://api.test/v1/admin/manifests?tripReference=ET+T%2F..%2FX&cursor=3&limit=25',
    );
    expect(calls[1]?.url).toBe('http://api.test/v1/admin/manifests/ETM-A%2F..%2FB');
    expect(calls[3]?.url).toBe('http://api.test/v1/admin/manifests/trips/ET%20T%2F..%2FX');
    expect(calls[3]?.init).toMatchObject({
      method: 'POST',
      body: '{}',
      headers: expect.objectContaining({ 'X-CSRF-Token': 'v1.manifest.csrf' }),
    });
  });

  it('exposes minimized manifest types and a private CSV download', async () => {
    const bytes = new Blob(['manifest_reference\r\nETM-AAAAAAAAAAAA\r\n'], {
      type: 'text/csv',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(bytes, {
            status: 200,
            headers: {
              'Content-Type': 'text/csv; charset=utf-8',
              'Content-Disposition': 'attachment; filename="passenger-manifest-ET-T-v1.csv"',
            },
          }),
      ),
    );
    const client = createAuthClient('http://api.test');
    const result = await client.admin.manifests.exportCsv('ETM-AAAAAAAAAAAA');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('download failed');
    expect(result.data.filename).toBe('passenger-manifest-ET-T-v1.csv');
    expect(await result.data.blob.text()).toContain('manifest_reference');
    expectTypeOf(client.admin.manifests.list).returns.resolves.toEqualTypeOf<
      ApiResult<PassengerManifestPage>
    >();
    expectTypeOf(client.admin.manifests.generate).returns.resolves.toEqualTypeOf<
      ApiResult<PassengerManifest>
    >();
    expectTypeOf(client.admin.manifests.exportCsv).returns.resolves.toEqualTypeOf<
      ApiResult<PrivateDownload>
    >();
    expectTypeOf<PassengerManifest>().not.toHaveProperty('generatedByIdentityId');
    expectTypeOf<PassengerManifest['snapshot']['passengers'][number]>().not.toHaveProperty(
      'credentialReference',
    );
    expectTypeOf<PassengerManifest['snapshot']['passengers'][number]>().not.toHaveProperty(
      'deviceId',
    );
  });
});

describe('regulatory permit client (PR-16)', () => {
  it('encodes filters/references and protects every mutation with STAFF CSRF', async () => {
    const calls = mockFetch([
      { status: 200, body: { items: [], nextCursor: null } },
      { status: 200, body: { reference: 'ETRP-AAAAAAAAAAAA' } },
      { status: 200, body: { csrfToken: 'create' } },
      { status: 201, body: { reference: 'ETRP-AAAAAAAAAAAA' } },
      { status: 200, body: { csrfToken: 'update' } },
      { status: 200, body: { reference: 'ETRP-AAAAAAAAAAAA' } },
      { status: 200, body: { csrfToken: 'activate' } },
      { status: 200, body: { reference: 'ETRP-AAAAAAAAAAAA' } },
      { status: 200, body: { csrfToken: 'revoke' } },
      { status: 200, body: { reference: 'ETRP-AAAAAAAAAAAA' } },
    ]);
    const permits = createAuthClient('http://api.test').admin.regulatoryPermits;
    await permits.list({
      cursor: 'ETRP-AAAAAAAAAAAA',
      limit: 25,
      status: 'ACTIVE',
      validityState: 'VALID',
      scopeType: 'TRIP',
      permitType: 'SYNTHETIC',
      country: 'SN',
      vehicleCode: 'BUS_A',
      routeCode: 'PAR_DKR',
      routeVersion: 2,
      tripReference: 'ET-TRIP-1',
      reference: 'ETRP-BBBBBBBBBBBB',
    });
    await permits.detail('ETRP-A/../B');
    await permits.create({
      permitType: 'SYNTHETIC',
      title: 'Synthetic permit',
      issuingAuthority: 'Synthetic authority',
      scope: { type: 'TRIP', tripReference: 'ET-TRIP-1' },
      validFrom: '2030-01-01',
      validUntil: '2030-12-31',
    });
    await permits.update('ETRP-A/../B', { expectedRevision: 1, title: 'Updated' });
    await permits.activate('ETRP-A/../B', 2);
    await permits.revoke('ETRP-A/../B', { expectedRevision: 3, reason: 'Synthetic revocation' });

    expect(calls[0]?.url).toBe(
      'http://api.test/v1/admin/regulatory-permits?cursor=ETRP-AAAAAAAAAAAA&limit=25&status=ACTIVE&validityState=VALID&scopeType=TRIP&permitType=SYNTHETIC&country=SN&vehicleCode=BUS_A&routeCode=PAR_DKR&routeVersion=2&tripReference=ET-TRIP-1&reference=ETRP-BBBBBBBBBBBB',
    );
    expect(calls[1]?.url).toBe('http://api.test/v1/admin/regulatory-permits/ETRP-A%2F..%2FB');
    expect(calls[3]?.url).toBe('http://api.test/v1/admin/regulatory-permits');
    expect(calls[5]?.url).toBe('http://api.test/v1/admin/regulatory-permits/ETRP-A%2F..%2FB');
    expect(calls[7]?.url).toBe(
      'http://api.test/v1/admin/regulatory-permits/ETRP-A%2F..%2FB/activate',
    );
    expect(calls[9]?.url).toBe(
      'http://api.test/v1/admin/regulatory-permits/ETRP-A%2F..%2FB/revoke',
    );
    for (const [index, token] of [
      [3, 'create'],
      [5, 'update'],
      [7, 'activate'],
      [9, 'revoke'],
    ] as const) {
      expect(calls[index]?.init.headers).toEqual(
        expect.objectContaining({ 'X-CSRF-Token': token }),
      );
    }
    expect(JSON.parse(calls[9]?.init.body as string)).toEqual({
      expectedRevision: 3,
      reason: 'Synthetic revocation',
    });
  });

  it('exposes public permit views without ids or departure authorization', () => {
    const permits = createAuthClient('http://api.test').admin.regulatoryPermits;
    expectTypeOf(permits.list).returns.resolves.toEqualTypeOf<
      ApiResult<Page<RegulatoryPermitSummary>>
    >();
    expectTypeOf(permits.detail).returns.resolves.toEqualTypeOf<
      ApiResult<RegulatoryPermitDetail>
    >();
    expectTypeOf<RegulatoryPermitDetail>().not.toHaveProperty('id');
    expectTypeOf<RegulatoryPermitDetail>().not.toHaveProperty('createdByIdentityId');
    expectTypeOf<RegulatoryPermitDetail>().not.toHaveProperty('tripReady');
    expectTypeOf(permits).not.toHaveProperty('approveDeparture');
  });
});

describe('departure readiness client (PR-17)', () => {
  it('encodes trip references and protects every mutation with STAFF CSRF', async () => {
    const calls = mockFetch([
      { status: 200, body: { trip: { reference: 'ET-T' }, readiness: { status: 'BLOCKED' } } },
      { status: 200, body: { csrfToken: 'policy' } },
      { status: 201, body: { tripReference: 'ET-T', version: 1 } },
      { status: 200, body: { csrfToken: 'authorize' } },
      { status: 200, body: { created: true, authorization: { reference: 'ETDA-AAAAAAAAAAAA' } } },
      { status: 200, body: { csrfToken: 'depart' } },
      { status: 200, body: { trip: { reference: 'ET-T', status: 'IN_PROGRESS' } } },
      { status: 200, body: { csrfToken: 'complete' } },
      { status: 200, body: { trip: { reference: 'ET-T', status: 'COMPLETED' } } },
    ]);
    const departure = createAuthClient('http://api.test').admin.departure;
    const trip = 'ET T/../X';
    await departure.readiness(trip);
    await departure.publishPermitPolicy(trip, {
      requirements: [
        { permitType: 'SYNTHETIC', scopeType: 'TRIP' },
        { permitType: 'COUNTRY_SYNTHETIC', scopeType: 'COUNTRY', countryIso2: 'SN' },
      ],
    });
    await departure.authorize(trip);
    await departure.depart(trip);
    await departure.complete(trip);

    const encoded = 'ET%20T%2F..%2FX';
    expect(calls[0]?.url).toBe(`http://api.test/v1/admin/departure/trips/${encoded}/readiness`);
    expect(calls[2]?.url).toBe(`http://api.test/v1/admin/departure/trips/${encoded}/permit-policy`);
    expect(JSON.parse(calls[2]?.init.body as string)).toEqual({
      requirements: [
        { permitType: 'SYNTHETIC', scopeType: 'TRIP' },
        { permitType: 'COUNTRY_SYNTHETIC', scopeType: 'COUNTRY', countryIso2: 'SN' },
      ],
    });
    expect(calls[4]?.url).toBe(`http://api.test/v1/admin/departure/trips/${encoded}/authorize`);
    expect(calls[6]?.url).toBe(`http://api.test/v1/admin/departure/trips/${encoded}/depart`);
    expect(calls[8]?.url).toBe(`http://api.test/v1/admin/departure/trips/${encoded}/complete`);
    for (const [index, token] of [
      [2, 'policy'],
      [4, 'authorize'],
      [6, 'depart'],
      [8, 'complete'],
    ] as const) {
      expect(calls[index]?.init.headers).toEqual(
        expect.objectContaining({ 'X-CSRF-Token': token }),
      );
    }
    expect(calls[4]?.init.body).toBe('{}');
    expect(calls[6]?.init.body).toBe('{}');
    expect(calls[8]?.init.body).toBe('{}');
  });

  it('exposes minimized departure types without internal ids or passenger PII', () => {
    const departure = createAuthClient('http://api.test').admin.departure;
    expectTypeOf(departure.readiness).returns.resolves.toEqualTypeOf<
      ApiResult<DepartureReadinessResponse>
    >();
    expectTypeOf(departure.publishPermitPolicy).returns.resolves.toEqualTypeOf<
      ApiResult<DeparturePermitPolicy>
    >();
    expectTypeOf(departure.authorize).returns.resolves.toEqualTypeOf<
      ApiResult<DepartureAuthorizationResult>
    >();
    expectTypeOf(departure.depart).returns.resolves.toEqualTypeOf<
      ApiResult<DepartureDispatchResult>
    >();
    expectTypeOf<DepartureReadinessResponse>().not.toHaveProperty('tripId');
    expectTypeOf<DepartureReadinessSnapshot['passengers']>().not.toHaveProperty('items');
    expectTypeOf<DepartureReadinessSnapshot>().not.toHaveProperty('documents');
    expectTypeOf<DepartureReadinessSnapshot>().not.toHaveProperty('payments');
    expectTypeOf<DepartureReadinessSnapshot>().not.toHaveProperty('qrPayload');
  });
});

describe('passenger-document client', () => {
  it('uses browser multipart boundaries and the existing in-memory CSRF flow', async () => {
    const calls = mockFetch([
      { status: 200, body: { csrfToken: 'v1.passenger.csrf' } },
      { status: 201, body: { reference: 'ETD-AAAAAAAAAAAA', status: 'ACCEPTED' } },
    ]);
    const file = new File(['%PDF-1.7\nsynthetic'], 'identity.pdf', {
      type: 'application/pdf',
    });
    const result = await createAuthClient('http://api.test').booking.customer.uploadDocument(
      'ETV-A/../B',
      { type: 'PASSPORT', expiresAt: '2032-05-09', file },
    );
    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toBe('http://api.test/v1/auth/customer/csrf');
    expect(calls[1]?.url).toBe('http://api.test/v1/booking/passengers/ETV-A%2F..%2FB/documents');
    expect(calls[1]?.init).toMatchObject({
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: { 'X-CSRF-Token': 'v1.passenger.csrf' },
    });
    expect((calls[1]?.init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
    const form = calls[1]?.init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('type')).toBe('PASSPORT');
    expect(form.get('expiresAt')).toBe('2032-05-09');
    const formFile = form.get('file') as File;
    expect(formFile).toMatchObject({
      name: 'identity.pdf',
      type: 'application/pdf',
      size: file.size,
    });
    expect(await formFile.text()).toBe(await file.text());
  });

  it('downloads private bytes with credentials and only a safe server filename', async () => {
    const bytes = new Blob(['%PDF-1.7\nprivate'], { type: 'application/pdf' });
    const calls: Call[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(bytes, {
          status: 200,
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Disposition': 'attachment; filename="ETD-AAAAAAAAAAAA.pdf"',
          },
        });
      }),
    );
    const result =
      await createAuthClient('http://api.test').booking.customer.downloadDocument('ETD-A/../B');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('download failed');
    expect(result.data.filename).toBe('ETD-AAAAAAAAAAAA.pdf');
    expect(result.data.mimeType).toBe('application/pdf');
    expect(await result.data.blob.text()).toContain('%PDF-1.7');
    expect(calls[0]).toMatchObject({
      url: 'http://api.test/v1/booking/documents/ETD-A%2F..%2FB/download',
      init: { method: 'GET', credentials: 'include', cache: 'no-store' },
    });
  });

  it('builds customer and staff URLs without undefined filters', async () => {
    const calls = mockFetch([
      { status: 200, body: { items: [] } },
      { status: 200, body: { items: [], nextCursor: null } },
      { status: 200, body: { reference: 'ETD-A' } },
    ]);
    const client = createAuthClient('http://api.test');
    await client.booking.customer.passengers('ETB-A/../B');
    await client.admin.passengerDocuments.list({
      type: 'VISA',
      status: 'REJECTED',
      bookingReference: 'ETB-A',
      passengerReference: 'ETV-A',
      limit: 20,
    });
    await client.admin.passengerDocuments.detail('ETD-A/../B');
    expect(calls[0]?.url).toBe('http://api.test/v1/booking/bookings/ETB-A%2F..%2FB/passengers');
    expect(calls[1]?.url).toBe(
      'http://api.test/v1/admin/passenger-documents?limit=20&type=VISA&status=REJECTED&bookingReference=ETB-A&passengerReference=ETV-A',
    );
    expect(calls[2]?.url).toBe('http://api.test/v1/admin/passenger-documents/ETD-A%2F..%2FB');
  });

  it('exposes technical types and no compliance mutation', () => {
    const client = createAuthClient('http://api.test');
    expectTypeOf(client.booking.customer.createPassenger).returns.resolves.toEqualTypeOf<
      ApiResult<Passenger>
    >();
    expectTypeOf(client.booking.customer.uploadDocument).returns.resolves.toEqualTypeOf<
      ApiResult<PassengerDocument>
    >();
    expectTypeOf(client.booking.customer.downloadDocument).returns.resolves.toEqualTypeOf<
      ApiResult<PrivateDownload>
    >();
    expectTypeOf(client.admin.passengerDocuments.detail).returns.resolves.toEqualTypeOf<
      ApiResult<PassengerDocument>
    >();
    expectTypeOf(client.admin.passengerDocuments).not.toHaveProperty('approve');
    expectTypeOf<PassengerDocument['status']>().toEqualTypeOf<
      'QUARANTINED' | 'ACCEPTED' | 'REJECTED'
    >();
  });
});

describe('compliance client (PR-12)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads compliance without side effect and evaluates through the CSRF flow', async () => {
    const calls = mockFetch([
      { status: 200, body: { bookingReference: 'ETB-A', items: [] } },
      { status: 200, body: { csrfToken: 'v1.compliance.csrf' } },
      { status: 200, body: {} },
    ]);
    const client = createAuthClient('http://api.test');
    await client.booking.customer.compliance('ETB-A/../B');
    await client.booking.customer.evaluateCompliance('ETB-A', 'ETV-A/../B');
    expect(calls[0]?.url).toBe('http://api.test/v1/booking/bookings/ETB-A%2F..%2FB/compliance');
    expect(calls[0]?.init.method).toBe('GET');
    expect(calls[1]?.url).toBe('http://api.test/v1/auth/customer/csrf');
    expect(calls[2]?.url).toBe(
      'http://api.test/v1/booking/bookings/ETB-A/passengers/ETV-A%2F..%2FB/compliance-evaluations',
    );
    expect(calls[2]?.init).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({ 'X-CSRF-Token': 'v1.compliance.csrf' }),
    });
    // The client sends no facts or result: the server derives everything.
    expect(calls[2]?.init.body).toBe('{}');
  });

  it('separates rule management, queue reads and reasoned reviews (staff realm CSRF)', async () => {
    const calls = mockFetch([
      { status: 200, body: { items: [], nextCursor: null } },
      { status: 200, body: { csrfToken: 'v1.staff.csrf' } },
      { status: 200, body: {} },
      { status: 200, body: { csrfToken: 'v1.staff.csrf' } },
      { status: 201, body: {} },
    ]);
    const client = createAuthClient('http://api.test');
    await client.admin.compliance.queue({
      status: 'REVIEW_REQUIRED',
      bookingReference: 'ETB-A',
      limit: 10,
    });
    await client.admin.compliance.publishVersion('ETCR-A/../B', 2, 'a'.repeat(64));
    await client.admin.compliance.review('ETCE-A', {
      decision: 'NEEDS_INFORMATION',
      reason: 'Motif interne obligatoire.',
      previousReviewId: null,
    });
    expect(calls[0]?.url).toBe(
      'http://api.test/v1/admin/compliance/booking-passengers?limit=10&status=REVIEW_REQUIRED&bookingReference=ETB-A',
    );
    expect(calls[1]?.url).toBe('http://api.test/v1/auth/staff/csrf');
    expect(calls[2]?.url).toBe(
      'http://api.test/v1/admin/compliance/rules/ETCR-A%2F..%2FB/versions/2/publish',
    );
    expect(JSON.parse(calls[2]?.init.body as string)).toEqual({ definitionSha256: 'a'.repeat(64) });
    expect(calls[4]?.url).toBe('http://api.test/v1/admin/compliance/evaluations/ETCE-A/reviews');
    expect(JSON.parse(calls[4]?.init.body as string)).toEqual({
      decision: 'NEEDS_INFORMATION',
      reason: 'Motif interne obligatoire.',
      previousReviewId: null,
    });
  });

  it('types compliance strictly and offers no bypass or override', () => {
    const client = createAuthClient('http://api.test');
    expectTypeOf(client.booking.customer.compliance).returns.resolves.toEqualTypeOf<
      ApiResult<CustomerBookingCompliance>
    >();
    expectTypeOf(client.booking.customer.evaluateCompliance).returns.resolves.toEqualTypeOf<
      ApiResult<CustomerPassengerCompliance>
    >();
    expectTypeOf(client.admin.compliance.evaluation).returns.resolves.toEqualTypeOf<
      ApiResult<ComplianceEvaluationDetail>
    >();
    expectTypeOf(client.admin.compliance).not.toHaveProperty('override');
    expectTypeOf(client.admin.compliance).not.toHaveProperty('bypass');
    expectTypeOf(client.booking.customer).not.toHaveProperty('review');
    expectTypeOf<CustomerPassengerCompliance>().not.toHaveProperty('rulesFingerprint');
    expectTypeOf<CustomerPassengerCompliance['review']>().toEqualTypeOf<{
      decision: 'COMPLIANT' | 'NON_COMPLIANT' | 'NEEDS_INFORMATION';
      reviewedAt: string;
      customerMessage: string | null;
    } | null>();
  });
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

  it('replaces vehicle media through the dedicated CSRF mutation', async () => {
    const calls = mockFetch([
      { status: 200, body: { csrfToken: 'v1.1.n.m' } },
      { status: 200, body: { id: 'vehicle-id', mediaGallery: [] } },
    ]);
    const result = await createAuthClient('http://api.test').admin.fleet.assignVehicleMedia(
      'vehicle/../id',
      {
        primaryMediaId: '01900000-0000-7000-8000-000000000001',
        gallery: [{ mediaId: '01900000-0000-7000-8000-000000000002', kind: 'INTERIOR' }],
      },
    );
    expect(result.ok).toBe(true);
    expect(calls[1]?.url).toBe('http://api.test/v1/admin/fleet/vehicles/vehicle%2F..%2Fid/media');
    expect(JSON.parse(String(calls[1]?.init.body))).toMatchObject({
      gallery: [{ kind: 'INTERIOR' }],
    });
  });

  it('types fleet results and refuses PLANNED as a transition target', () => {
    const fleet = createAuthClient('http://api.test').admin.fleet;
    expectTypeOf(fleet.vehicle).returns.resolves.toEqualTypeOf<ApiResult<AdminVehicleDetail>>();
    expectTypeOf(fleet.createVehicle).returns.resolves.toEqualTypeOf<ApiResult<AdminVehicle>>();
    expectTypeOf(fleet.changeVehicleStatus).returns.resolves.toEqualTypeOf<
      ApiResult<AdminVehicle>
    >();
    expectTypeOf(fleet.assignVehicleMedia).returns.resolves.toEqualTypeOf<
      ApiResult<AdminVehicleDetail>
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

  it('reads and atomically replaces internal trip costs through the CSRF flow', async () => {
    const calls = mockFetch([
      { status: 200, body: { id: null, items: [], totalCostMinor: '0' } },
      { status: 200, body: { csrfToken: 'v1.1.n.m' } },
      { status: 200, body: { id: 'plan-id', items: [], totalCostMinor: '12500' } },
    ]);
    const trips = createAuthClient('http://api.test').admin.trips;
    await trips.tripCosts('trip/../id');
    const input = {
      status: 'ESTIMATED' as const,
      currencyCode: 'EUR' as const,
      items: [
        {
          category: 'FUEL' as const,
          label: 'Carburant',
          amountMinor: '12500',
          position: 0,
        },
      ],
    };
    await trips.replaceTripCosts('trip/../id', input);
    expect(calls[0]?.url).toBe('http://api.test/v1/admin/trips/trip%2F..%2Fid/costs');
    expect(calls[0]?.init.method).toBe('GET');
    expect(calls[2]?.url).toBe('http://api.test/v1/admin/trips/trip%2F..%2Fid/costs');
    expect(calls[2]?.init).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'v1.1.n.m' },
    });
    expect(JSON.parse(String(calls[2]?.init.body))).toEqual(input);
  });

  it('types trip results and inputs', () => {
    const trips = createAuthClient('http://api.test').admin.trips;
    expectTypeOf(trips.trips).returns.resolves.toEqualTypeOf<ApiResult<Page<AdminTripSummary>>>();
    expectTypeOf(trips.trip).returns.resolves.toEqualTypeOf<ApiResult<AdminTrip>>();
    expectTypeOf(trips.tripCosts).returns.resolves.toEqualTypeOf<ApiResult<TripCostPlan>>();
    expectTypeOf(trips.replaceTripCosts).returns.resolves.toEqualTypeOf<ApiResult<TripCostPlan>>();
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

  it('distinguishes the trip pricing identity (trip.read) from the full summary', () => {
    const identity: TripFareTableIdentity = {
      id: 'v',
      version: 1,
      fareTable: { code: 'ROUTE_TEST_EUR', currencyCode: 'EUR' },
      entryCount: 2,
    };
    expect(hasFareTableDetails(identity)).toBe(false);
    expect(
      hasFareTableDetails({
        ...identity,
        status: 'RETIRED',
        publishedAt: null,
        retiredAt: null,
        routeVersionId: 'r',
        fareTable: {
          ...identity.fareTable,
          id: 't',
          name: 'n',
          currencyMinorUnit: 2,
          active: true,
        },
      }),
    ).toBe(true);
    expectTypeOf<TripFareTableIdentity>().not.toHaveProperty('status');
    expectTypeOf<TripFareTableIdentity['fareTable']>().not.toHaveProperty('currencyMinorUnit');
    expectTypeOf<AdminTripSummary['fareTableVersion']>().toEqualTypeOf<
      AssignedFareTableVersion | TripFareTableIdentity | null
    >();
  });

  it('separates public booking reads, customer actions and staff administration', async () => {
    const calls = mockFetch([
      { status: 200, body: { items: [], nextCursor: null } },
      { status: 200, body: { items: [], nextCursor: null } },
      { status: 200, body: { cells: [] } },
      { status: 200, body: { csrfToken: 'c' } },
      { status: 201, body: { reference: 'ETB-AAAAAAAAAAAA' } },
      { status: 200, body: { csrfToken: 'c' } },
      { status: 200, body: { status: 'CANCELLED' } },
      { status: 200, body: { csrfToken: 's' } },
      { status: 200, body: { status: 'CANCELLED' } },
    ]);
    const client = createAuthClient('http://api.test');
    await client.booking.public.stops({ query: 'arrêt', limit: 5 });
    expect(calls[0]?.url).toBe('http://api.test/v1/booking/stops?query=arr%C3%AAt&limit=5');
    await client.booking.public.searchTrips({
      originStopId: 'o',
      destinationStopId: 'd',
      minAvailableSeats: 2,
    });
    expect(calls[1]?.url).toBe(
      'http://api.test/v1/booking/trips?originStopId=o&destinationStopId=d&minAvailableSeats=2',
    );
    await client.booking.public.availability('trip', 'o', 'd');
    expect(calls[2]?.url).toBe(
      'http://api.test/v1/booking/trips/trip/availability?originRouteWaypointId=o&destinationRouteWaypointId=d',
    );
    // Public reads carry no CSRF header.
    for (const call of calls.slice(0, 3)) expect(call.init.headers).toEqual({});
    await client.booking.customer.createHold({
      tripId: 't',
      originRouteWaypointId: 'o',
      destinationRouteWaypointId: 'd',
      seatMapCellIds: ['c1', 'c2'],
    });
    expect(calls[3]?.url).toBe('http://api.test/v1/auth/customer/csrf');
    expect(calls[4]).toMatchObject({ url: 'http://api.test/v1/booking/bookings' });
    expect(calls[4]?.init.headers).toEqual({
      'Content-Type': 'application/json',
      'X-CSRF-Token': 'c',
    });
    expect(JSON.parse(String(calls[4]?.init.body))).toEqual({
      tripId: 't',
      originRouteWaypointId: 'o',
      destinationRouteWaypointId: 'd',
      seatMapCellIds: ['c1', 'c2'],
    });
    await client.booking.customer.cancel('ETB-AAAAAAAAAAAA');
    expect(calls[6]?.url).toBe('http://api.test/v1/booking/bookings/ETB-AAAAAAAAAAAA/cancel');
    await client.admin.bookings.cancel('booking-id', 'Raison');
    expect(calls[7]?.url).toBe('http://api.test/v1/auth/staff/csrf');
    expect(calls[8]?.url).toBe('http://api.test/v1/admin/bookings/booking-id/cancel');
    expect(JSON.parse(String(calls[8]?.init.body))).toEqual({ reason: 'Raison' });
  });

  it('reads the public itinerary and fleet without a session or CSRF token', async () => {
    const calls = mockFetch([
      { status: 200, body: { waypoints: [] } },
      { status: 200, body: { items: [] } },
    ]);
    const client = createAuthClient('http://api.test');
    await client.booking.public.itinerary('trip/../id');
    expect(calls[0]?.url).toBe('http://api.test/v1/booking/trips/trip%2F..%2Fid/itinerary');
    await client.booking.public.fleet();
    expect(calls[1]?.url).toBe('http://api.test/v1/booking/fleet');
    for (const call of calls) expect(call.init.headers).toEqual({});
    expectTypeOf(client.booking.public.itinerary).returns.resolves.toEqualTypeOf<
      ApiResult<BookingItinerary>
    >();
    // Public reads never type a VIN, a plate or a status.
    expectTypeOf<PublicVehicle>().not.toHaveProperty('vin');
    expectTypeOf<PublicVehicle>().not.toHaveProperty('registrationPlate');
    expectTypeOf<NonNullable<BookingItinerary['vehicle']>>().not.toHaveProperty('status');
    expectTypeOf<AdminVehicle['amenities']>().toEqualTypeOf<VehicleAmenity[]>();
  });

  it('types booking results explicitly, with exact integer amounts', () => {
    const client = createAuthClient('http://api.test');
    expectTypeOf(client.booking.public.availability).returns.resolves.toEqualTypeOf<
      ApiResult<BookingAvailability>
    >();
    expectTypeOf(client.booking.customer.createHold).returns.resolves.toEqualTypeOf<
      ApiResult<CustomerBooking>
    >();
    expectTypeOf(client.admin.bookings.booking).returns.resolves.toEqualTypeOf<
      ApiResult<AdminBooking>
    >();
    expectTypeOf<CustomerBooking['totalAmountMinor']>().toEqualTypeOf<number>();
    // PR-10 adds CONFIRMED (a succeeded payment) to the derived statuses.
    expectTypeOf<CustomerBooking['status']>().toEqualTypeOf<
      'HELD' | 'CONFIRMED' | 'EXPIRED' | 'CANCELLED'
    >();
    // The client never sends a price, a currency or an identity.
    expectTypeOf(client.booking.customer.createHold)
      .parameter(0)
      .not.toHaveProperty('unitAmountMinor');
    expectTypeOf(client.booking.customer.createHold)
      .parameter(0)
      .not.toHaveProperty('customerIdentityId');
    expectTypeOf<CustomerBooking>().not.toHaveProperty('customerIdentityId');
  });

  it('starts, lists and cancels payments with CSRF and an optional Idempotency-Key', async () => {
    // A synthetic, low-entropy key (as a browser would send a random UUID).
    const intentKey = 'i'.repeat(20);
    const payment = {
      reference: 'ETP-AAAAAAAAAAAA',
      status: 'PENDING',
      amountMinor: 6_000_000_000,
      currencyCode: 'EUR',
      currencyMinorUnit: 2,
      paymentMethod: 'CARD',
      payerCountry: 'FR',
      presentment: { amountMinor: 6_000_000_000, currencyCode: 'EUR', currencyMinorUnit: 2 },
      createdAt: '2030-01-01T00:00:00.000Z',
      succeededAt: null,
      failedAt: null,
      cancelledAt: null,
    };
    const intent = {
      quoteId: '01900000-0000-7000-8000-000000000001',
      paymentMethod: 'CARD',
    } as const;
    const calls = mockFetch([
      { status: 200, body: { csrfToken: 'c' } },
      {
        status: 201,
        body: { payment, checkout: { provider: 'SANDBOX', testMode: true, redirectUrl: null } },
      },
      { status: 200, body: { csrfToken: 'c2' } },
      {
        status: 200,
        body: { payment, checkout: { provider: 'SANDBOX', testMode: true, redirectUrl: null } },
      },
      { status: 200, body: { items: [payment] } },
      { status: 200, body: { csrfToken: 'c3' } },
      { status: 200, body: { ...payment, status: 'CANCELLED' } },
      { status: 200, body: { items: [], nextCursor: null } },
      { status: 200, body: { ...payment, id: 'p', events: [] } },
      { status: 200, body: { csrfToken: 's' } },
      { status: 200, body: { ...payment, id: 'p', status: 'CANCELLED', events: [] } },
    ]);
    const client = createAuthClient('http://api.test/');
    const created = await client.booking.customer.createPayment('ETB-AAAAAAAAAAAA', intent);
    expect(calls[0]?.url).toBe('http://api.test/v1/auth/customer/csrf');
    expect(calls[1]).toMatchObject({
      url: 'http://api.test/v1/booking/bookings/ETB-AAAAAAAAAAAA/payments',
    });
    expect(calls[1]?.init.method).toBe('POST');
    // The chosen quote and its method only: amount, currency and provider come from the server.
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual(intent);
    expect(calls[1]?.init.headers).toEqual({
      'Content-Type': 'application/json',
      'X-CSRF-Token': 'c',
    });
    expect(created.ok && created.data.payment.amountMinor).toBe(6_000_000_000);

    await client.booking.customer.createPayment('ETB-AAAAAAAAAAAA', intent, intentKey);
    expect(calls[3]?.init.headers).toEqual({
      'Idempotency-Key': intentKey,
      'Content-Type': 'application/json',
      'X-CSRF-Token': 'c2',
    });
    await client.booking.customer.listPayments('ETB-AAAAAAAAAAAA');
    expect(calls[4]?.url).toBe('http://api.test/v1/booking/bookings/ETB-AAAAAAAAAAAA/payments');
    expect(calls[4]?.init.headers).toEqual({});
    await client.booking.customer.cancelPayment('ETP-AAAAAAAAAAAA');
    expect(calls[6]?.url).toBe('http://api.test/v1/booking/payments/ETP-AAAAAAAAAAAA/cancel');
    expect(calls[6]?.init.headers).toMatchObject({ 'X-CSRF-Token': 'c3' });

    await client.admin.payments.listPayments({
      status: 'SUCCEEDED',
      bookingReference: 'ETB-X',
      limit: 10,
    });
    expect(calls[7]?.url).toBe(
      'http://api.test/v1/admin/payments?limit=10&status=SUCCEEDED&bookingReference=ETB-X',
    );
    await client.admin.payments.getPayment('p/1');
    expect(calls[8]?.url).toBe('http://api.test/v1/admin/payments/p%2F1');
    await client.admin.payments.cancelPayment('p', 'Bloqué');
    expect(calls[9]?.url).toBe('http://api.test/v1/auth/staff/csrf');
    expect(calls[10]?.url).toBe('http://api.test/v1/admin/payments/p/cancel');
    expect(JSON.parse(String(calls[10]?.init.body))).toEqual({ reason: 'Bloqué' });
  });

  it('reads payment options and requests quotes with intentions only (PAY-HUB-1)', async () => {
    const calls = mockFetch([
      { status: 200, body: { country: 'SN', currency: 'XOF', currencyMinorUnit: 0, methods: [] } },
      { status: 200, body: { csrfToken: 'q' } },
      { status: 201, body: { id: 'quote' } },
    ]);
    const client = createAuthClient('http://api.test');
    await client.booking.customer.paymentOptions('ETB-AAAAAAAAAAAA', 'SN');
    expect(calls[0]?.url).toBe(
      'http://api.test/v1/booking/bookings/ETB-AAAAAAAAAAAA/payment-options?payerCountry=SN',
    );
    expect(calls[0]?.init.method ?? 'GET').toBe('GET');
    await client.booking.customer.createPaymentQuote('ETB-AAAAAAAAAAAA', {
      payerCountry: 'SN',
      paymentMethod: 'WAVE_SN',
    });
    expect(calls[2]?.url).toBe(
      'http://api.test/v1/booking/bookings/ETB-AAAAAAAAAAAA/payment-quotes',
    );
    expect(calls[2]?.init.method).toBe('POST');
    expect(JSON.parse(String(calls[2]?.init.body))).toEqual({
      payerCountry: 'SN',
      paymentMethod: 'WAVE_SN',
    });
    expect(calls[2]?.init.headers).toMatchObject({ 'X-CSRF-Token': 'q' });
  });

  it('types payments explicitly: exact amounts, no provider detail for customers', () => {
    const client = createAuthClient('http://api.test');
    expectTypeOf(client.booking.customer.createPayment).returns.resolves.toEqualTypeOf<
      ApiResult<CreatePaymentResult>
    >();
    // The booking reference, the quote to pay (and an optional key): never an amount.
    expectTypeOf(client.booking.customer.createPayment).parameter(0).toEqualTypeOf<string>();
    expectTypeOf(client.booking.customer.createPayment)
      .parameter(1)
      .toEqualTypeOf<CreatePaymentInput>();
    expectTypeOf<CreatePaymentInput>().not.toHaveProperty('amountMinor');
    expectTypeOf<PaymentQuoteInput>().not.toHaveProperty('amountMinor');
    expectTypeOf<PaymentQuoteInput>().not.toHaveProperty('currencyCode');
    expectTypeOf(client.booking.customer.createPayment)
      .parameter(2)
      .toEqualTypeOf<string | undefined>();
    // Payment options never say which provider collects a method.
    expectTypeOf<PaymentOptions['methods'][number]>().not.toHaveProperty('provider');
    expectTypeOf<PaymentQuote>().not.toHaveProperty('providerCandidate');
    expectTypeOf(client.booking.customer.listPayments).returns.resolves.toEqualTypeOf<
      ApiResult<{ items: CustomerPayment[] }>
    >();
    expectTypeOf(client.admin.payments.listPayments).returns.resolves.toEqualTypeOf<
      ApiResult<PaymentPage>
    >();
    expectTypeOf(client.admin.payments.getPayment).returns.resolves.toEqualTypeOf<
      ApiResult<AdminPaymentDetail>
    >();
    expectTypeOf<CustomerPayment['amountMinor']>().toEqualTypeOf<number>();
    expectTypeOf<CustomerPayment['status']>().toEqualTypeOf<
      'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED'
    >();
    expectTypeOf<CustomerPayment>().not.toHaveProperty('providerPaymentId');
    expectTypeOf<CustomerPayment>().not.toHaveProperty('failureCode');
    expectTypeOf<CustomerBooking['payment']>().toEqualTypeOf<CustomerPayment | null>();
    // STAFF booking details carry payments only with payment.read.
    expectTypeOf<AdminBooking>().toHaveProperty('payments');
    // No STAFF method can make an attempt succeed.
    expectTypeOf(client.admin.payments).not.toHaveProperty('markPaid');
    expectTypeOf(client.admin.payments).toHaveProperty('cancelPayment');
  });
});

describe('content client (CMS-1)', () => {
  it('reads published content publicly and encodes the page path', async () => {
    const calls = mockFetch([
      { status: 200, body: { path: '/paris-dakar', revision: 2, publishedAt: 'x', document: {} } },
      { status: 200, body: { settings: null, navigation: null, updatedAt: null } },
      { status: 200, body: { items: [] } },
    ]);
    const client = createAuthClient('http://api.test');
    const page = await client.content.page('/paris-dakar');
    expect(page.ok).toBe(true);
    expect(calls[0]?.url).toBe('http://api.test/v1/content/pages?path=%2Fparis-dakar');
    expect(calls[0]?.init.method).toBe('GET');
    await client.content.site();
    await client.content.sitemap();
    expect(calls.map((call) => call.url)).toEqual([
      'http://api.test/v1/content/pages?path=%2Fparis-dakar',
      'http://api.test/v1/content/site',
      'http://api.test/v1/content/sitemap',
    ]);
  });

  it('sends every STAFF content mutation with a CSRF token and the expected draft', async () => {
    const entry = { id: '01900000-0000-7000-8000-00000000c0de' };
    const calls = mockFetch([
      { status: 200, body: { csrfToken: 'c1' } },
      { status: 200, body: entry },
      { status: 200, body: { csrfToken: 'c2' } },
      { status: 200, body: entry },
      { status: 200, body: { csrfToken: 'c3' } },
      { status: 409, body: { code: 'CONTENT_DRAFT_CONFLICT', message: 'Conflit' } },
    ]);
    const client = createAuthClient('http://api.test');
    await client.admin.content.saveDraft(entry.id, {
      document: { title: 'Accueil' },
      expectedDraftUpdatedAt: null,
    });
    expect(calls[1]?.url).toBe(`http://api.test/v1/admin/content/entries/${entry.id}/draft`);
    expect((calls[1]?.init.headers as Record<string, string>)['X-CSRF-Token']).toBe('c1');
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      document: { title: 'Accueil' },
      expectedDraftUpdatedAt: null,
    });
    await client.admin.content.restore(entry.id, 3);
    expect(JSON.parse(String(calls[3]?.init.body))).toEqual({ revision: 3 });
    const conflict = await client.admin.content.publish(entry.id, '2030-01-01T00:00:00.000Z');
    expect(conflict).toMatchObject({
      ok: false,
      error: { status: 409, code: 'CONTENT_DRAFT_CONFLICT' },
    });
    expect(JSON.parse(String(calls[5]?.init.body))).toEqual({
      expectedDraftUpdatedAt: '2030-01-01T00:00:00.000Z',
    });
  });

  it('keeps only well-formed validation issues of a refused document (CMS-2)', async () => {
    mockFetch([
      { status: 200, body: { csrfToken: 'c1' } },
      {
        status: 422,
        body: {
          code: 'CONTENT_DOCUMENT_INVALID',
          message: 'Le contenu ne respecte pas le modèle de la page.',
          details: {
            issues: [
              { path: 'blocks.0.title', message: 'Too small', extra: 'dropped' },
              { path: 3, message: 'not a path' },
              'not an issue',
            ],
          },
        },
      },
    ]);
    const client = createAuthClient('http://api.test');
    const result = await client.admin.content.saveDraft('01900000-0000-7000-8000-00000000c0de', {
      document: {},
      expectedDraftUpdatedAt: null,
    });
    expect(result).toEqual({
      ok: false,
      error: {
        status: 422,
        code: 'CONTENT_DOCUMENT_INVALID',
        message: 'Le contenu ne respecte pas le modèle de la page.',
        details: { issues: [{ path: 'blocks.0.title', message: 'Too small' }] },
      },
    });
  });
  it('uploads a media image as multipart and keeps only well-formed media details (MEDIA-1)', async () => {
    const calls = mockFetch([
      { status: 200, body: { csrfToken: 'c1' } },
      {
        status: 409,
        body: {
          code: 'MEDIA_DUPLICATE',
          message: 'Cette image est déjà dans la médiathèque.',
          details: { mediaId: '01900000-0000-7000-8000-00000000c0de', storageKey: 'dropped' },
        },
      },
      { status: 200, body: { csrfToken: 'c2' } },
      {
        status: 409,
        body: {
          code: 'MEDIA_IN_USE',
          message: 'Cette image est utilisée.',
          details: {
            usages: [
              { kind: 'PAGE', key: '/', status: 'PUBLISHED', email: 'dropped@example.test' },
              { kind: 'PAGE', key: '/x', status: 'SUPERSEDED' },
              'not a usage',
            ],
          },
        },
      },
      { status: 200, body: { items: [] } },
    ]);
    const client = createAuthClient('http://api.test/');
    const file = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' });
    const duplicate = await client.admin.media.upload({
      file,
      altText: 'Autocar',
      caption: 'Départ',
      focalX: 30,
      focalY: 0,
      replaces: '01900000-0000-7000-8000-000000000001',
    });
    expect(calls[1]?.url).toBe('http://api.test/v1/admin/media');
    expect((calls[1]?.init.headers as Record<string, string>)['X-CSRF-Token']).toBe('c1');
    const form = calls[1]?.init.body as FormData;
    expect([...form.keys()]).toEqual([
      'altText',
      'caption',
      'focalX',
      'focalY',
      'replaces',
      'file',
    ]);
    expect(form.get('focalY')).toBe('0');
    expect(duplicate).toEqual({
      ok: false,
      error: {
        status: 409,
        code: 'MEDIA_DUPLICATE',
        message: 'Cette image est déjà dans la médiathèque.',
        details: { mediaId: '01900000-0000-7000-8000-00000000c0de' },
      },
    });

    const inUse = await client.admin.media.archive(
      '01900000-0000-7000-8000-00000000c0de',
      'Vieille',
    );
    expect(JSON.parse(String(calls[3]?.init.body))).toEqual({ reason: 'Vieille' });
    expect(inUse).toMatchObject({
      ok: false,
      error: {
        details: {
          usages: [{ kind: 'PAGE', key: '/', status: 'PUBLISHED', entryArchived: false }],
        },
      },
    });

    await client.media.many([
      '01900000-0000-7000-8000-000000000001',
      '01900000-0000-7000-8000-000000000002',
    ]);
    expect(calls[4]?.url).toBe(
      'http://api.test/v1/media?ids=01900000-0000-7000-8000-000000000001%2C01900000-0000-7000-8000-000000000002',
    );
    expect(client.media.url('/v1/media/files/a/480.webp')).toBe(
      'http://api.test/v1/media/files/a/480.webp',
    );
  });
});
