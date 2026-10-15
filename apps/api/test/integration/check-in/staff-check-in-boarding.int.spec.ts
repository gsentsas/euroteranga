import { randomBytes } from 'node:crypto';
import type { ApiEnv } from '@euroteranga/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestRole, staffActor, type StaffActor } from '../../support/admin-helpers.js';
import { db, withoutRequestId } from '../../support/auth-helpers.js';
import { customerBaggageApi, staffBaggageApi } from '../../support/baggage-helpers.js';
import { customerActor, type CustomerActor } from '../../support/booking-helpers.js';
import {
  boardingApi,
  compliantPassenger,
  customerCheckInApi,
  staffCheckInApi,
} from '../../support/check-in-helpers.js';
import {
  acceptedDocument,
  complianceApi,
  confirmedJourney,
  journeyPassenger,
} from '../../support/compliance-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

describe('staff check-in and authenticated boarding', () => {
  // The shared test database keeps earlier runs: idempotency keys are per run.
  const run = randomBytes(4).toString('hex');
  let t: TestApp;
  let env: ApiEnv;
  let customer: CustomerActor;
  let ruleManager: StaffActor;
  let agent: StaffActor;
  let support: StaffActor;
  let dispatcher: StaffActor;
  let compliance: StaffActor;

  beforeAll(async () => {
    env = integrationEnv();
    t = await startTestApp(env);
    [customer, ruleManager, agent, support, dispatcher, compliance] = await Promise.all([
      customerActor(t.app),
      staffActor(t.app, ['DIRECTOR']),
      staffActor(t.app, ['BOOKING_AGENT']),
      staffActor(t.app, ['CUSTOMER_SUPPORT']),
      staffActor(t.app, ['DISPATCHER']),
      staffActor(t.app, ['COMPLIANCE_AGENT']),
    ]);
  }, 60_000);

  afterAll(async () => {
    await t.app.close();
  });

  async function checkedIn(options: { seat?: string } = {}) {
    const ready = await compliantPassenger(t.app, env, customer, ruleManager, options);
    const response = await staffCheckInApi(agent).checkIn(
      ready.bookingReference,
      ready.passengerReference,
    );
    if (response.status !== 201) throw new Error(`check-in fixture failed: ${response.text}`);
    return { ...ready, checkIn: response.body.checkIn };
  }

  it('separates checkin.read, checkin.manage, boarding.read and boarding.scan', async () => {
    const ready = await compliantPassenger(t.app, env, customer, ruleManager);
    const reader = staffCheckInApi(support);
    expect((await reader.detail(ready.bookingReference, ready.passengerReference)).status).toBe(
      200,
    );
    expect((await reader.checkIn(ready.bookingReference, ready.passengerReference)).status).toBe(
      403,
    );
    expect(
      (await reader.seat(ready.bookingReference, ready.passengerReference, { seatLabel: '1A' }))
        .status,
    ).toBe(403);
    // compliance.read and passenger.document.read never imply check-in access.
    expect((await staffCheckInApi(compliance).list()).status).toBe(403);

    const checkIn = await staffCheckInApi(agent).checkIn(
      ready.bookingReference,
      ready.passengerReference,
    );
    expect(checkIn.status, checkIn.text).toBe(201);
    expect(checkIn.body.checkIn).toMatchObject({ channel: 'STAFF', boarding: null });
    const payload = checkIn.body.checkIn.qrPayload as string;
    // checkin.manage is not boarding.scan.
    expect(
      (await boardingApi(agent).scan({ qrPayload: payload, deviceId: 'counter-01' })).status,
    ).toBe(403);
    expect((await boardingApi(support).resolve(payload)).status).toBe(403);
    // boarding.read resolves a QR but never boards without boarding.scan.
    const readOnly = await staffActor(t.app, [
      await createTestRole(t.app, ['ops.access', 'checkin.read', 'boarding.read']),
    ]);
    expect((await boardingApi(readOnly).resolve(payload)).status).toBe(200);
    expect(
      (await boardingApi(readOnly).scan({ qrPayload: payload, deviceId: 'reader-01' })).status,
    ).toBe(403);
    expect(
      (
        await boardingApi(dispatcher).scan(
          { qrPayload: payload, deviceId: 'gate-01' },
          { csrf: null },
        )
      ).status,
    ).toBe(403);
    expect(
      await db(t.app).passengerBoarding.count({
        where: {
          checkIn: { bookingPassenger: { booking: { reference: ready.bookingReference } } },
        },
      }),
    ).toBe(0);
  });

  it('never lets STAFF override a blocker', async () => {
    const journey = await confirmedJourney(t.app, env, customer);
    const passenger = await journeyPassenger(customer, journey, journey.origin.id);
    const refused = await staffCheckInApi(agent).checkIn(journey.bookingReference, passenger);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('CHECK_IN_NOT_READY');
    for (const override of [
      { force: true },
      { ignoreCompliance: true },
      { overridePayment: true },
    ]) {
      const response = await staffCheckInApi(agent).checkIn(
        journey.bookingReference,
        passenger,
        override,
      );
      expect(response.status, JSON.stringify(override)).toBe(400);
    }
    const detail = await staffCheckInApi(support).detail(journey.bookingReference, passenger);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ checkIn: null, readiness: { eligible: false } });
  });

  it('boards once by QR scan; replays are idempotent, other scans are stable 409s', async () => {
    const { checkIn, bookingReference, passengerReference } = await checkedIn();
    const api = boardingApi(dispatcher);
    const resolved = await api.resolve(checkIn.qrPayload.toLowerCase());
    expect(resolved.status, resolved.text).toBe(200);
    expect(resolved.body).toMatchObject({
      checkIn: { reference: checkIn.reference, seat: { label: '1A' }, current: true },
      readiness: { eligible: true },
    });

    const occurredAt = new Date().toISOString();
    const scan = {
      qrPayload: checkIn.qrPayload,
      deviceId: 'gate-01',
      clientEventId: `scan-board-${run}-1`,
      occurredAt,
    };
    const first = await api.scan(scan);
    expect(first.status, first.text).toBe(201);
    expect(first.body).toMatchObject({
      created: true,
      boarding: {
        reference: expect.stringMatching(/^ETE-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/u),
        deviceId: 'gate-01',
        occurredAt,
      },
    });
    const replay = await api.scan(scan);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual({ created: false, boarding: first.body.boarding });

    const reused = await api.scan({
      ...scan,
      deviceId: 'gate-01',
      occurredAt: new Date(Date.now() - 1_000).toISOString(),
    });
    expect(reused.status).toBe(409);
    expect(reused.body.code).toBe('BOARDING_CLIENT_EVENT_ID_REUSED');
    for (const second of [
      { qrPayload: checkIn.qrPayload, deviceId: 'gate-02' },
      {
        qrPayload: checkIn.qrPayload,
        deviceId: 'gate-01',
        clientEventId: `scan-board-${run}-2`,
        occurredAt,
      },
    ]) {
      const response = await api.scan(second);
      expect(response.status, JSON.stringify(second)).toBe(409);
      expect(response.body.code).toBe('PASSENGER_ALREADY_BOARDED');
    }

    const stored = await db(t.app).passengerCheckIn.findUniqueOrThrow({
      where: { reference: checkIn.reference },
      include: { boarding: true },
    });
    expect(stored.boarding).toMatchObject({
      deviceId: 'gate-01',
      clientEventId: `scan-board-${run}-1`,
    });
    expect(
      await db(t.app).auditEvent.count({
        where: { action: 'PASSENGER_BOARDED', resourceId: stored.id },
      }),
    ).toBe(1);
    const audit = await db(t.app).auditEvent.findFirstOrThrow({
      where: { action: 'PASSENGER_BOARDED', resourceId: stored.id },
    });
    expect(audit.metadata).toMatchObject({
      checkInReference: checkIn.reference,
      bookingReference,
      passengerReference,
      deviceId: 'gate-01',
    });
    expect(JSON.stringify(audit)).not.toContain('<svg');
    expect(JSON.stringify(audit)).not.toContain(customer.email);

    // The customer now sees the boarding, without device id.
    const view = await customerCheckInApi(customer).booking(bookingReference);
    expect(view.body.items[0].checkIn.boarding).toEqual({
      reference: first.body.boarding.reference,
      boardedAt: first.body.boarding.boardedAt,
    });
    // The boarded passenger's seat stays frozen.
    const frozen = await customerCheckInApi(customer).seat(bookingReference, passengerReference, {
      seatLabel: '1A',
    });
    expect(frozen.status).toBe(409);
    expect(frozen.body.code).toBe('SEAT_ASSIGNMENT_LOCKED');
  });

  it('rejects malformed, unsupported, unknown and foreign-looking QR payloads uniformly', async () => {
    const api = boardingApi(dispatcher);
    for (const qrPayload of [
      'ETQ-0123456789ABCDEF',
      'ETPAX2:ETQ-0123456789ABCDEF',
      'ETG1:ETG-0123456789AB',
      'x',
    ]) {
      const response = await api.scan({ qrPayload, deviceId: 'gate-01' });
      expect(response.status, qrPayload).toBe(422);
      expect(response.body.code).toBe('BOARDING_QR_INVALID');
    }
    const unknown = await api.scan({
      qrPayload: 'ETPAX1:ETQ-ZZZZZZZZZZZZZZZZ',
      deviceId: 'gate-01',
    });
    const unknownResolve = await api.resolve('ETPAX1:ETQ-ZZZZZZZZZZZZZZZZ');
    expect(unknown.status).toBe(404);
    expect(withoutRequestId(unknown.body)).toEqual(withoutRequestId(unknownResolve.body));
    for (const deviceId of ['', ' ', 'gate 01', 'x'.repeat(65), 'gate\u0007', '-gate']) {
      const response = await api.scan({ qrPayload: 'ETPAX1:ETQ-ZZZZZZZZZZZZZZZZ', deviceId });
      expect(response.status, JSON.stringify(deviceId)).toBe(400);
    }
    expect((await api.scan({ qrPayload: 'ETPAX1:ETQ-ZZZZZZZZZZZZZZZZ' })).status).toBe(400);
  });

  it('refuses a stale check-in at boarding, audits it, and boards once revalidated', async () => {
    const { checkIn, bookingReference, passengerReference, journey } = await checkedIn();
    // A new technically accepted document changes the compliance facts.
    await acceptedDocument(t.app, passengerReference, 'NATIONAL_ID', null);
    const api = boardingApi(dispatcher);
    const stale = await api.scan({ qrPayload: checkIn.qrPayload, deviceId: 'gate-03' });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('CHECK_IN_STALE');
    expect(
      stale.body.details.blockers.map((blocker: { code: string }) => blocker.code).sort(),
    ).toEqual(['COMPLIANCE_STALE', 'DOCUMENTS_NOT_VERIFIED']);
    const stored = await db(t.app).passengerCheckIn.findUniqueOrThrow({
      where: { reference: checkIn.reference },
      include: { boarding: true },
    });
    expect(stored.boarding).toBeNull();
    const refusal = await db(t.app).auditEvent.findFirstOrThrow({
      where: { action: 'PASSENGER_BOARDING_REFUSED', resourceId: stored.id },
    });
    expect(refusal.metadata).toMatchObject({
      code: 'CHECK_IN_STALE',
      blockers: ['DOCUMENTS_NOT_VERIFIED', 'COMPLIANCE_STALE'],
    });
    const detail = await staffCheckInApi(support).detail(bookingReference, passengerReference);
    expect(detail.body.checkIn).toMatchObject({ current: false, factsChangedSinceCheckIn: true });

    // A current PASS again: the same check-in is revalidated, never duplicated.
    const evaluated = await complianceApi(customer).evaluate(bookingReference, passengerReference);
    expect(evaluated.body.status).toBe('COMPLIANT_BY_RULES');
    const boarded = await api.scan({ qrPayload: checkIn.qrPayload, deviceId: 'gate-03' });
    expect(boarded.status, boarded.text).toBe(201);
    const audit = await db(t.app).auditEvent.findFirstOrThrow({
      where: { action: 'PASSENGER_BOARDED', resourceId: stored.id },
    });
    expect(audit.metadata).toMatchObject({
      factsChangedSinceCheckIn: true,
      tripReference: journey.tripReference,
    });
  });

  it('refuses boarding when a blocking baggage exception appears after check-in', async () => {
    const { checkIn, bookingReference, passengerReference } = await checkedIn();
    const bag = await customerBaggageApi(customer).register(bookingReference, passengerReference);
    const manager = await staffActor(t.app, ['OPS_MANAGER']);
    // Normal bag progress does not invalidate the check-in.
    expect(
      (await staffBaggageApi(manager).event(bag.body.reference, { type: 'CHECKED_IN' })).status,
    ).toBe(201);
    const resolved = await boardingApi(dispatcher).resolve(checkIn.qrPayload);
    expect(resolved.body.checkIn).toMatchObject({ current: true, factsChangedSinceCheckIn: false });
    expect(
      (await staffBaggageApi(manager).event(bag.body.reference, { type: 'HELD_BY_CUSTOMS' }))
        .status,
    ).toBe(201);
    const stale = await boardingApi(dispatcher).scan({
      qrPayload: checkIn.qrPayload,
      deviceId: 'gate-04',
    });
    expect(stale.status).toBe(409);
    expect(stale.body.details.blockers).toEqual([
      { check: 'BAGGAGE', code: 'BAGGAGE_EXCEPTION_ACTIVE', reference: bag.body.reference },
    ]);
  });

  it('keeps already-boarded precedence when later facts become stale', async () => {
    const { checkIn, bookingReference, passengerReference } = await checkedIn();
    const api = boardingApi(dispatcher);

    const first = await api.scan({
      qrPayload: checkIn.qrPayload,
      deviceId: 'gate-priority-01',
    });
    expect(first.status, first.text).toBe(201);
    expect(first.body.created).toBe(true);

    // Introduce a blocker only after the passenger has already boarded.
    const bag = await customerBaggageApi(customer).register(bookingReference, passengerReference);
    expect(bag.status, bag.text).toBe(201);

    const manager = await staffActor(t.app, ['OPS_MANAGER']);
    const blocked = await staffBaggageApi(manager).event(bag.body.reference, {
      type: 'HELD_BY_CUSTOMS',
    });
    expect(blocked.status, blocked.text).toBe(201);

    // Once boarding is a historical fact, later staleness must not replace
    // the more specific PASSENGER_ALREADY_BOARDED result.
    const second = await api.scan({
      qrPayload: checkIn.qrPayload,
      deviceId: 'gate-priority-02',
    });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('PASSENGER_ALREADY_BOARDED');

    const stored = await db(t.app).passengerCheckIn.findUniqueOrThrow({
      where: { reference: checkIn.reference },
      include: { boarding: true },
    });
    expect(stored.boarding).not.toBeNull();

    expect(
      await db(t.app).auditEvent.count({
        where: {
          action: 'PASSENGER_BOARDING_REFUSED',
          resourceId: stored.id,
        },
      }),
    ).toBe(0);
  });

  it('bounds the operator time and lists passengers with server-side filters, audited', async () => {
    const { checkIn, journey, bookingReference, passengerReference } = await checkedIn();
    const api = boardingApi(dispatcher);
    for (const occurredAt of [
      new Date(Date.now() + 10 * 60_000).toISOString(),
      new Date(Date.now() - 31 * 86_400_000).toISOString(),
      new Date(Date.now() - 60 * 60_000).toISOString(),
    ]) {
      const response = await api.scan({
        qrPayload: checkIn.qrPayload,
        deviceId: 'gate-05',
        occurredAt,
      });
      expect(response.status, occurredAt).toBe(422);
      expect(response.body.code).toBe('BOARDING_TIME_INVALID');
    }

    const list = await staffCheckInApi(support).list(
      `?tripReference=${journey.tripReference}&checkInStatus=CHECKED_IN&boardingStatus=NOT_BOARDED`,
    );
    expect(list.status, list.text).toBe(200);
    expect(list.body.items).toEqual([
      expect.objectContaining({
        passenger: expect.objectContaining({ reference: passengerReference }),
        booking: { reference: bookingReference },
        seat: { label: '1A' },
        checkIn: expect.objectContaining({ reference: checkIn.reference }),
        boarding: null,
        readiness: { eligible: true, blockers: [] },
      }),
    ]);
    expect(
      (
        await staffCheckInApi(support).list(
          `?tripReference=${journey.tripReference}&boardingStatus=BOARDED`,
        )
      ).body.items,
    ).toEqual([]);
    expect((await staffCheckInApi(support).list('?limit=100')).status).toBe(400);
    const pages = await db(t.app).auditEvent.findMany({
      where: { action: 'PASSENGER_CHECKIN_READINESS_ACCESSED', actorIdentityId: support.id },
      select: { metadata: true },
    });
    expect(
      pages.some((event) =>
        ((event.metadata as { references?: string[] }).references ?? []).includes(
          `${bookingReference}/${passengerReference}`,
        ),
      ),
    ).toBe(true);
    const label = await staffCheckInApi(support).qr(checkIn.reference);
    expect(label.status).toBe(200);
    expect(label.body.svg).toContain('<svg');
  });
});
