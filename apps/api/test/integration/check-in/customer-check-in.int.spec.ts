import type { ApiEnv } from '@euroteranga/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderBoardingQrSvg } from '../../../src/check-in/check-in-rules.js';
import { staffActor, type StaffActor } from '../../support/admin-helpers.js';
import { client, db, withoutRequestId } from '../../support/auth-helpers.js';
import { customerBaggageApi, staffBaggageApi } from '../../support/baggage-helpers.js';
import { bookingApi, customerActor, type CustomerActor } from '../../support/booking-helpers.js';
import {
  compliantPassenger,
  customerCheckInApi,
  type ReadyPassenger,
} from '../../support/check-in-helpers.js';
import { confirmedJourney, journeyPassenger } from '../../support/compliance-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

const codes = (body: { blockers: Array<{ code: string }> }) =>
  body.blockers.map((blocker) => blocker.code).sort();

describe('customer check-in: gates, seat assignment, ownership and QR', () => {
  let t: TestApp;
  let env: ApiEnv;
  let owner: CustomerActor;
  let stranger: CustomerActor;
  let ruleManager: StaffActor;
  let baggageManager: StaffActor;

  beforeAll(async () => {
    env = integrationEnv();
    t = await startTestApp(env);
    [owner, stranger, ruleManager, baggageManager] = await Promise.all([
      customerActor(t.app),
      customerActor(t.app),
      staffActor(t.app, ['DIRECTOR']),
      staffActor(t.app, ['OPS_MANAGER']),
    ]);
  }, 60_000);

  afterAll(async () => {
    await t.app.close();
  });

  it('reports every blocker with stable codes and never checks in on GET', async () => {
    const journey = await confirmedJourney(t.app, env, owner);
    const passenger = await journeyPassenger(owner, journey, journey.origin.id);
    const readiness = await customerCheckInApi(owner).readiness(
      journey.bookingReference,
      passenger,
    );
    expect(readiness.status).toBe(200);
    expect(readiness.body.eligible).toBe(false);
    expect(codes(readiness.body)).toEqual([
      'COMPLIANCE_MISSING',
      'DOCUMENTS_NOT_VERIFIED',
      'SEAT_NOT_ASSIGNED',
    ]);
    expect(readiness.body.checks).toEqual([
      { check: 'BOOKING', status: 'PASS', blockers: [] },
      { check: 'PAYMENT', status: 'PASS', blockers: [] },
      { check: 'DOCUMENTS', status: 'BLOCKED', blockers: ['DOCUMENTS_NOT_VERIFIED'] },
      { check: 'COMPLIANCE', status: 'BLOCKED', blockers: ['COMPLIANCE_MISSING'] },
      { check: 'SEAT', status: 'BLOCKED', blockers: ['SEAT_NOT_ASSIGNED'] },
      { check: 'BAGGAGE', status: 'PASS', blockers: [] },
    ]);

    const refused = await customerCheckInApi(owner).checkIn(journey.bookingReference, passenger);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('CHECK_IN_NOT_READY');
    expect(
      refused.body.details.blockers.map((blocker: { code: string }) => blocker.code).sort(),
    ).toEqual(['COMPLIANCE_MISSING', 'DOCUMENTS_NOT_VERIFIED', 'SEAT_NOT_ASSIGNED']);
    const booking = await db(t.app).booking.findUniqueOrThrow({
      where: { reference: journey.bookingReference },
    });
    expect(await db(t.app).passengerCheckIn.count({ where: { bookingId: booking.id } })).toBe(0);
  });

  it('checks in an all-green passenger once, with a PII-free QR credential', async () => {
    const ready = await compliantPassenger(t.app, env, owner, ruleManager);
    const api = customerCheckInApi(owner);
    const readiness = await api.readiness(ready.bookingReference, ready.passengerReference);
    expect(readiness.body).toMatchObject({ eligible: true, blockers: [] });
    expect(
      readiness.body.checks.every((check: { status: string }) => check.status === 'PASS'),
    ).toBe(true);

    const first = await api.checkIn(ready.bookingReference, ready.passengerReference);
    expect(first.status, first.text).toBe(201);
    expect(first.body.created).toBe(true);
    const checkIn = first.body.checkIn;
    expect(checkIn).toMatchObject({
      reference: expect.stringMatching(/^ETK-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/u),
      qrPayload: expect.stringMatching(/^ETPAX1:ETQ-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{16}$/u),
      seat: { label: '1A' },
      passenger: { reference: ready.passengerReference },
      booking: { reference: ready.bookingReference },
      trip: { reference: ready.journey.tripReference },
      boarding: null,
    });
    const serialized = JSON.stringify(first.body);
    for (const forbidden of ['"id"', 'Fingerprint', 'snapshot', 'deviceId', 'channel', '@']) {
      expect(serialized).not.toContain(forbidden);
    }

    const again = await api.checkIn(ready.bookingReference, ready.passengerReference);
    expect(again.status).toBe(201);
    expect(again.body).toEqual({ created: false, checkIn });

    const stored = await db(t.app).passengerCheckIn.findUniqueOrThrow({
      where: { reference: checkIn.reference },
    });
    expect(stored.readinessFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    const snapshot = JSON.stringify(stored.readinessSnapshot);
    expect(snapshot).not.toContain('Awa');
    expect(snapshot).not.toContain(owner.email);
    expect(
      await db(t.app).auditEvent.count({
        where: { action: 'PASSENGER_CHECKED_IN', resourceId: stored.id },
      }),
    ).toBe(1);

    const qr = await api.qr(checkIn.reference);
    expect(qr.status).toBe(200);
    expect(qr.headers['cache-control']).toContain('no-store');
    expect(qr.body.svg).toBe(renderBoardingQrSvg(stored.credentialReference));
    expect(qr.body.svg).not.toContain(ready.bookingReference);

    const overview = await api.booking(ready.bookingReference);
    expect(overview.status).toBe(200);
    expect(overview.body.items).toEqual([
      expect.objectContaining({
        passenger: expect.objectContaining({ reference: ready.passengerReference }),
        seat: { label: '1A' },
        checkIn,
      }),
    ]);
    expect(overview.body.seats).toEqual([{ label: '1A', assignedTo: ready.passengerReference }]);
  });

  it('assigns only booked seats, one passenger per seat, frozen after check-in', async () => {
    const journey = await confirmedJourney(t.app, env, owner, { seats: ['1A', '1B'] });
    const [first, second] = [
      await journeyPassenger(owner, journey, journey.origin.id),
      await journeyPassenger(owner, journey, journey.origin.id, { givenName: 'Moussa' }),
    ];
    const api = customerCheckInApi(owner);
    expect((await api.seat(journey.bookingReference, first, { seatLabel: '1a' })).status).toBe(201);
    const taken = await api.seat(journey.bookingReference, second, { seatLabel: '1A' });
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe('SEAT_ALREADY_ASSIGNED');
    // A seat of the seat map that this booking did not book is not its seat.
    const unbooked = await api.seat(journey.bookingReference, second, { seatLabel: '2A' });
    expect(unbooked.status).toBe(404);
    expect(unbooked.body.code).toBe('SEAT_NOT_FOUND');
    expect((await api.seat(journey.bookingReference, second, { seatLabel: '1B' })).status).toBe(
      201,
    );
    // Reassignment before check-in moves the passenger; the same seat is a no-op.
    const same = await api.seat(journey.bookingReference, second, { seatLabel: '1B' });
    expect(same.body).toEqual({ changed: false, seat: { label: '1B' } });
    for (const injected of [
      { seatLabel: '1B', bookingSeatId: '01900000-0000-7000-8000-000000000000' },
      { seatLabel: '1B', passengerId: first },
      { seat: '1B' },
    ]) {
      const response = await api.seat(journey.bookingReference, second, injected);
      expect(response.status, JSON.stringify(injected)).toBe(400);
    }
    expect(
      await db(t.app).auditEvent.count({
        where: {
          action: 'PASSENGER_SEAT_ASSIGNED',
          resourceId: `${journey.bookingReference}/${second}`,
        },
      }),
    ).toBe(1);
  });

  it('refuses any client-supplied authority on check-in', async () => {
    const ready = await compliantPassenger(t.app, env, owner, ruleManager);
    for (const injected of [
      { status: 'CHECKED_IN' },
      { eligible: true },
      { force: true },
      { complianceStatus: 'COMPLIANT' },
      { actorIdentityId: stranger.id },
      { deviceId: 'counter-01' },
    ]) {
      const response = await customerCheckInApi(owner).checkIn(
        ready.bookingReference,
        ready.passengerReference,
        injected,
      );
      expect(response.status, JSON.stringify(injected)).toBe(400);
    }
    const noCsrf = await customerCheckInApi(owner).checkIn(
      ready.bookingReference,
      ready.passengerReference,
      {},
      { csrf: null },
    );
    expect(noCsrf.status).toBe(403);
  });

  it('makes a foreign booking passenger, check-in or QR indistinguishable from unknown', async () => {
    const ready: ReadyPassenger = await compliantPassenger(t.app, env, owner, ruleManager);
    const checkIn = await customerCheckInApi(owner).checkIn(
      ready.bookingReference,
      ready.passengerReference,
    );
    const reference = checkIn.body.checkIn.reference as string;
    const foreign = customerCheckInApi(stranger);
    const pairs: Array<
      [
        () => Promise<{ status: number; body: unknown }>,
        () => Promise<{ status: number; body: unknown }>,
      ]
    > = [
      [
        () => foreign.readiness(ready.bookingReference, ready.passengerReference),
        () => foreign.readiness('ETB-ZZZZZZZZZZZZ', 'ETV-ZZZZZZZZZZZZ'),
      ],
      [
        () => foreign.seat(ready.bookingReference, ready.passengerReference, { seatLabel: '1A' }),
        () => foreign.seat('ETB-ZZZZZZZZZZZZ', 'ETV-ZZZZZZZZZZZZ', { seatLabel: '1A' }),
      ],
      [
        () => foreign.checkIn(ready.bookingReference, ready.passengerReference),
        () => foreign.checkIn('ETB-ZZZZZZZZZZZZ', 'ETV-ZZZZZZZZZZZZ'),
      ],
      [() => foreign.booking(ready.bookingReference), () => foreign.booking('ETB-ZZZZZZZZZZZZ')],
      [() => foreign.qr(reference), () => foreign.qr('ETK-ZZZZZZZZZZZZ')],
    ];
    for (const [foreignCall, unknownCall] of pairs) {
      const [a, b] = [await foreignCall(), await unknownCall()];
      expect(a.status).toBe(404);
      expect(withoutRequestId(a.body)).toEqual(withoutRequestId(b.body));
    }
  });

  it('gives a CUSTOMER no boarding or STAFF route', async () => {
    const ready = await compliantPassenger(t.app, env, owner, ruleManager);
    const checkIn = await customerCheckInApi(owner).checkIn(
      ready.bookingReference,
      ready.passengerReference,
    );
    const payload = checkIn.body.checkIn.qrPayload as string;
    const staff = client(t.app, 'staff');
    expect(
      (
        await staff.post(
          '/v1/admin/boarding/scan',
          { qrPayload: payload, deviceId: 'customer-phone' },
          owner.cookie,
        )
      ).status,
    ).toBe(401);
    expect((await staff.get('/v1/admin/check-in/booking-passengers', owner.cookie)).status).toBe(
      401,
    );
    for (const path of ['/boarding/scan', `/check-ins/${checkIn.body.checkIn.reference}/board`]) {
      const response = await bookingApi(owner).post(path, { qrPayload: payload });
      expect(response.status, path).toBe(404);
    }
    expect(
      await db(t.app).passengerBoarding.count({
        where: {
          checkIn: { bookingPassenger: { booking: { reference: ready.bookingReference } } },
        },
      }),
    ).toBe(0);
  });

  it('blocks on an active baggage exception, ignores REMOVED bags and normal progress', async () => {
    const ready = await compliantPassenger(t.app, env, owner, ruleManager);
    const bags = customerBaggageApi(owner);
    const [kept, removed] = [
      (await bags.register(ready.bookingReference, ready.passengerReference)).body.reference,
      (await bags.register(ready.bookingReference, ready.passengerReference)).body.reference,
    ] as string[];
    const staffBags = staffBaggageApi(baggageManager);
    expect((await staffBags.event(kept!, { type: 'CHECKED_IN' })).status).toBe(201);
    expect((await staffBags.event(removed!, { type: 'MISSING' })).status).toBe(201);
    const api = customerCheckInApi(owner);
    const blocked = await api.readiness(ready.bookingReference, ready.passengerReference);
    expect(blocked.body.blockers).toEqual([
      { check: 'BAGGAGE', code: 'BAGGAGE_EXCEPTION_ACTIVE', reference: removed },
    ]);
    expect(blocked.body.checks.at(-1)).toEqual({
      check: 'BAGGAGE',
      status: 'PENDING_REVIEW',
      blockers: ['BAGGAGE_EXCEPTION_ACTIVE'],
    });
    // REMOVED is history: the bag no longer blocks the passenger.
    expect((await staffBags.event(removed!, { type: 'REMOVED' })).status).toBe(201);
    expect((await staffBags.event(kept!, { type: 'LOADED' })).status).toBe(201);
    const clear = await api.readiness(ready.bookingReference, ready.passengerReference);
    expect(clear.body).toMatchObject({ eligible: true, blockers: [] });
  });

  it('rate-limits customer seat and check-in operations per identity', async () => {
    const limited = await customerActor(t.app);
    const journey = await confirmedJourney(t.app, env, limited, { seats: ['1A', '1B'] });
    const passenger = await journeyPassenger(limited, journey, journey.origin.id);
    const api = customerCheckInApi(limited);
    for (let index = 0; index < 60; index += 1) {
      const response = await api.seat(journey.bookingReference, passenger, {
        seatLabel: index % 2 === 0 ? '1A' : '1B',
      });
      expect(response.status, `operation ${index + 1}: ${response.text}`).toBe(201);
    }
    const limitedResponse = await api.checkIn(journey.bookingReference, passenger);
    expect(limitedResponse.status).toBe(429);
    expect(limitedResponse.headers['retry-after']).toBeDefined();
  });
});
