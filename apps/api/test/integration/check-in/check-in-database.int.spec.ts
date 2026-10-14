import type { ApiEnv } from '@euroteranga/config';
import { createDatabaseClient } from '@euroteranga/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isolatedDatabase, staffActor, type StaffActor } from '../../support/admin-helpers.js';
import { db } from '../../support/auth-helpers.js';
import { customerActor, type CustomerActor } from '../../support/booking-helpers.js';
import {
  boardingApi,
  compliantPassenger,
  customerCheckInApi,
  staffCheckInApi,
} from '../../support/check-in-helpers.js';
import {
  complianceApi,
  confirmedJourney,
  journeyPassenger,
} from '../../support/compliance-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

describe('check-in and boarding PostgreSQL invariants and true concurrency', () => {
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let gate: ReturnType<typeof createDatabaseClient>;
  let t: TestApp;
  let env: ApiEnv;
  let customer: CustomerActor;
  let stranger: CustomerActor;
  let ruleManager: StaffActor;
  let agent: StaffActor;
  let dispatcher: StaffActor;

  beforeAll(async () => {
    database = await isolatedDatabase();
    // A separate client holds the barrier locks, so the API keeps its whole pool.
    gate = createDatabaseClient({ databaseUrl: database.url });
    env = integrationEnv({ DATABASE_URL: database.url });
    t = await startTestApp(env);
    [customer, stranger, ruleManager, agent, dispatcher] = await Promise.all([
      customerActor(t.app),
      customerActor(t.app),
      staffActor(t.app, ['DIRECTOR']),
      staffActor(t.app, ['BOOKING_AGENT']),
      staffActor(t.app, ['DISPATCHER']),
    ]);
  }, 60_000);

  afterAll(async () => {
    await t.app.close();
    await gate.$disconnect();
    await database.drop();
  });

  async function ids(bookingReference: string, passengerReference: string) {
    const booking = await db(t.app).booking.findUniqueOrThrow({
      where: { reference: bookingReference },
      include: { seats: { include: { seatMapCell: true } } },
    });
    const passenger = await db(t.app).passenger.findUniqueOrThrow({
      where: { reference: passengerReference },
    });
    const seat = (label: string) =>
      booking.seats.find((item) => item.seatMapCell.seatLabel === label)!.id;
    return { bookingId: booking.id, passengerId: passenger.id, seat };
  }

  async function lockWaiters(): Promise<number> {
    const [row] = await gate.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) AS count FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    return Number(row!.count);
  }

  async function waitForWaiters(count: number) {
    for (let attempt = 0; attempt < 400 && (await lockWaiters()) < count; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(
      await lockWaiters(),
      'every request must wait behind the held lock',
    ).toBeGreaterThanOrEqual(count);
  }

  /** Holds `lockSql` in a transaction until `count` requests wait behind it. */
  async function forcedOverlap<T>(
    lock: (tx: Parameters<Parameters<typeof gate.$transaction>[0]>[0]) => Promise<unknown>,
    requests: Array<() => PromiseLike<T>>,
  ): Promise<T[]> {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const holder = gate.$transaction(
      async (tx) => {
        await lock(tx);
        locked();
        await released;
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
    await isLocked;
    const pending: Array<Promise<T>> = [];
    for (const [index, request] of requests.entries()) {
      pending.push(Promise.resolve(request()));
      await waitForWaiters(index + 1);
    }
    release();
    await holder;
    return Promise.all(pending);
  }

  it('exposes the intended catalogue: tables, composite keys, uniques, triggers, grants', async () => {
    const constraints = await db(t.app).$queryRaw<Array<{ name: string; definition: string }>>`
      SELECT conname AS name, pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid IN ('booking_passenger_seat'::regclass, 'passenger_check_in'::regclass,
                         'passenger_boarding'::regclass)`;
    const byName = Object.fromEntries(constraints.map((row) => [row.name, row.definition]));
    expect(byName.booking_passenger_seat_booking_seat_fkey).toContain(
      'FOREIGN KEY (booking_seat_id, booking_id) REFERENCES booking_seat(id, booking_id)',
    );
    expect(byName.booking_passenger_seat_booking_passenger_fkey).toContain(
      'FOREIGN KEY (booking_id, passenger_id) REFERENCES booking_passenger(booking_id, passenger_id)',
    );
    expect(byName.passenger_check_in_seat_assignment_fkey).toContain(
      'REFERENCES booking_passenger_seat(booking_id, passenger_id, booking_seat_id) ON UPDATE RESTRICT ON DELETE RESTRICT',
    );
    const unique = await db(t.app).$queryRaw<Array<{ definition: string }>>`
      SELECT indexdef AS definition FROM pg_indexes
      WHERE schemaname = 'public' AND indexdef LIKE 'CREATE UNIQUE INDEX%'
        AND tablename IN ('booking_passenger_seat', 'passenger_check_in', 'passenger_boarding')`;
    expect(unique.map((row) => row.definition)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'booking_passenger_seat_booking_seat_id_key ON public.booking_passenger_seat USING btree (booking_seat_id)',
        ),
        expect.stringContaining(
          'passenger_check_in_booking_id_passenger_id_key ON public.passenger_check_in USING btree (booking_id, passenger_id)',
        ),
        expect.stringContaining(
          'passenger_check_in_credential_reference_key ON public.passenger_check_in USING btree (credential_reference)',
        ),
        expect.stringContaining(
          'passenger_boarding_check_in_id_key ON public.passenger_boarding USING btree (check_in_id)',
        ),
        expect.stringContaining(
          'passenger_boarding_device_id_client_event_id_key ON public.passenger_boarding USING btree (device_id, client_event_id)',
        ),
      ]),
    );
    const triggers = await db(t.app).$queryRaw<Array<{ name: string }>>`
      SELECT tgname AS name FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN (
        'booking_passenger_seat'::regclass, 'passenger_check_in'::regclass,
        'passenger_boarding'::regclass)`;
    expect(triggers.map((row) => row.name).sort()).toEqual([
      'booking_passenger_seat_guard',
      'booking_passenger_seat_no_truncate',
      'passenger_boarding_guard',
      'passenger_boarding_no_truncate',
      'passenger_check_in_guard',
      'passenger_check_in_no_truncate',
    ]);
    const grants = await db(t.app).authorizationRolePermission.findMany({
      where: {
        permissionKey: { in: ['checkin.read', 'checkin.manage', 'boarding.read', 'boarding.scan'] },
      },
      orderBy: [{ permissionKey: 'asc' }, { roleKey: 'asc' }],
    });
    const holders = (key: string) =>
      grants.filter((grant) => grant.permissionKey === key).map((grant) => grant.roleKey);
    expect(holders('boarding.scan')).toEqual([
      'DIRECTOR',
      'DISPATCHER',
      'OPS_MANAGER',
      'SUPER_ADMIN',
    ]);
    expect(holders('checkin.manage')).toEqual([
      'BOOKING_AGENT',
      'DIRECTOR',
      'DISPATCHER',
      'OPS_MANAGER',
      'SUPER_ADMIN',
    ]);
  });

  it('keeps seat assignment on the same booking, one seat per passenger, one passenger per seat', async () => {
    const journey = await confirmedJourney(t.app, env, customer, { seats: ['1A', '1B'] });
    const first = await journeyPassenger(customer, journey, journey.origin.id);
    const second = await journeyPassenger(customer, journey, journey.origin.id, {
      givenName: 'Ibou',
    });
    const foreign = await confirmedJourney(t.app, env, stranger);
    const a = await ids(journey.bookingReference, first);
    const b = await ids(journey.bookingReference, second);
    const other = await ids(
      foreign.bookingReference,
      await journeyPassenger(stranger, foreign, foreign.origin.id),
    );

    // A seat of another booking: the composite foreign key refuses it.
    await expect(
      db(t.app).bookingPassengerSeat.create({
        data: {
          bookingId: a.bookingId,
          passengerId: a.passengerId,
          bookingSeatId: other.seat('1A'),
          assignedByIdentityId: agent.id,
        },
      }),
    ).rejects.toThrow(/booking_passenger_seat_booking_seat_fkey|Foreign key/i);
    await db(t.app).bookingPassengerSeat.create({
      data: {
        bookingId: a.bookingId,
        passengerId: a.passengerId,
        bookingSeatId: a.seat('1A'),
        assignedByIdentityId: agent.id,
      },
    });
    await expect(
      db(t.app).bookingPassengerSeat.create({
        data: {
          bookingId: b.bookingId,
          passengerId: b.passengerId,
          bookingSeatId: a.seat('1A'),
          assignedByIdentityId: agent.id,
        },
      }),
    ).rejects.toThrow(/Unique constraint failed/);
    await expect(
      db(t.app).bookingPassengerSeat.create({
        data: {
          bookingId: a.bookingId,
          passengerId: a.passengerId,
          bookingSeatId: a.seat('1B'),
          assignedByIdentityId: agent.id,
        },
      }),
    ).rejects.toThrow(/Unique constraint failed/);
    // Only the booking customer or STAFF may assign.
    await expect(
      db(t.app).bookingPassengerSeat.create({
        data: {
          bookingId: b.bookingId,
          passengerId: b.passengerId,
          bookingSeatId: a.seat('1B'),
          assignedByIdentityId: stranger.id,
        },
      }),
    ).rejects.toThrow(/only the active booking customer or active STAFF may assign a seat/);
    await expect(
      db(t.app).bookingPassengerSeat.update({
        where: { bookingId_passengerId: { bookingId: a.bookingId, passengerId: a.passengerId } },
        data: { passengerId: b.passengerId },
      }),
    ).rejects.toThrow(/subject is immutable|Foreign key/i);
    await expect(
      db(t.app).bookingPassengerSeat.delete({
        where: { bookingId_passengerId: { bookingId: a.bookingId, passengerId: a.passengerId } },
      }),
    ).rejects.toThrow(/never deleted/);
    await expect(
      db(t.app).$executeRawUnsafe('TRUNCATE TABLE "booking_passenger_seat" CASCADE'),
    ).rejects.toThrow(/cannot be truncated/);
  });

  it('refuses a released seat (pre-existing corrupted row) in assignment and check-in', async () => {
    const journey = await confirmedJourney(t.app, env, customer);
    const passenger = await journeyPassenger(customer, journey, journey.origin.id);
    const subject = await ids(journey.bookingReference, passenger);
    // PR-10 forbids releasing a confirmed booking's seat: simulate a corrupted
    // historical row with triggers disabled in this isolated transaction only.
    await db(t.app).$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
      await tx.$executeRaw`UPDATE "booking_seat" SET "released_at" = now() WHERE "id" = ${subject.seat('1A')}::uuid`;
    });
    await expect(
      db(t.app).bookingPassengerSeat.create({
        data: {
          bookingId: subject.bookingId,
          passengerId: subject.passengerId,
          bookingSeatId: subject.seat('1A'),
          assignedByIdentityId: agent.id,
        },
      }),
    ).rejects.toThrow(/a released seat cannot be assigned/);
    const response = await customerCheckInApi(customer).seat(journey.bookingReference, passenger, {
      seatLabel: '1A',
    });
    expect(response.status).toBe(404);
  });

  it('makes the check-in a single append-only fact pinned to its seat and compliance', async () => {
    const ready = await compliantPassenger(t.app, env, customer, ruleManager, {
      seats: ['1A', '1B'],
    });
    const subject = await ids(ready.bookingReference, ready.passengerReference);
    const evaluation = await db(t.app).complianceEvaluation.findFirstOrThrow({
      where: { bookingId: subject.bookingId, passengerId: subject.passengerId },
    });
    const base = {
      bookingId: subject.bookingId,
      passengerId: subject.passengerId,
      complianceEvaluationId: evaluation.id,
      engineVersion: 'checkin-readiness/1',
      readinessFingerprint: 'a'.repeat(64),
      readinessSnapshot: {},
      checkedInByIdentityId: agent.id,
    };
    // Not the assigned seat.
    await expect(
      db(t.app).passengerCheckIn.create({
        data: {
          ...base,
          reference: 'ETK-000000000001',
          credentialReference: 'ETQ-0000000000000001',
          bookingSeatId: subject.seat('1B'),
        },
      }),
    ).rejects.toThrow(/pins the current seat assignment/);
    // A foreign customer cannot be the actor.
    await expect(
      db(t.app).passengerCheckIn.create({
        data: {
          ...base,
          reference: 'ETK-000000000002',
          credentialReference: 'ETQ-0000000000000002',
          bookingSeatId: subject.seat('1A'),
          checkedInByIdentityId: stranger.id,
        },
      }),
    ).rejects.toThrow(/only the active booking customer or active STAFF may check in/);
    const created = await staffCheckInApi(agent).checkIn(
      ready.bookingReference,
      ready.passengerReference,
    );
    expect(created.status, created.text).toBe(201);
    const row = await db(t.app).passengerCheckIn.findUniqueOrThrow({
      where: { reference: created.body.checkIn.reference },
    });
    await expect(
      db(t.app).passengerCheckIn.create({
        data: {
          ...base,
          reference: 'ETK-000000000003',
          credentialReference: 'ETQ-0000000000000003',
          bookingSeatId: subject.seat('1A'),
        },
      }),
    ).rejects.toThrow(/Unique constraint failed/);
    await expect(
      db(t.app).passengerCheckIn.update({
        where: { id: row.id },
        data: { credentialReference: 'ETQ-0000000000000004' },
      }),
    ).rejects.toThrow(/append-only/);
    await expect(db(t.app).passengerCheckIn.delete({ where: { id: row.id } })).rejects.toThrow(
      /append-only/,
    );
    await expect(
      db(t.app).$executeRawUnsafe('TRUNCATE TABLE "passenger_check_in" CASCADE'),
    ).rejects.toThrow(/cannot be truncated/);
    // The seat of a checked-in passenger is frozen (trigger and RESTRICT key).
    await expect(
      db(t.app).bookingPassengerSeat.update({
        where: {
          bookingId_passengerId: { bookingId: subject.bookingId, passengerId: subject.passengerId },
        },
        data: { bookingSeatId: subject.seat('1B') },
      }),
    ).rejects.toThrow(/seat of a checked-in passenger is immutable/);
    // A later compliance evaluation cannot be bypassed by pinning an older one.
    expect(row.complianceEvaluationId).toBe(evaluation.id);
  });

  it('requires the latest PASS evaluation or a current COMPLIANT review in PostgreSQL', async () => {
    const journey = await confirmedJourney(t.app, env, customer);
    const passenger = await journeyPassenger(customer, journey, journey.origin.id);
    const subject = await ids(journey.bookingReference, passenger);
    // No rule covers this journey: the evaluation is REVIEW_REQUIRED.
    const reviewed = await customerCheckInApi(customer).seat(journey.bookingReference, passenger, {
      seatLabel: '1A',
    });
    expect(reviewed.status).toBe(201);
    await complianceApi(customer).evaluate(journey.bookingReference, passenger);
    const evaluation = await db(t.app).complianceEvaluation.findFirstOrThrow({
      where: { bookingId: subject.bookingId, passengerId: subject.passengerId },
    });
    expect(evaluation.result).toBe('REVIEW_REQUIRED');
    await expect(
      db(t.app).passengerCheckIn.create({
        data: {
          reference: 'ETK-000000000005',
          credentialReference: 'ETQ-0000000000000005',
          bookingId: subject.bookingId,
          passengerId: subject.passengerId,
          bookingSeatId: subject.seat('1A'),
          complianceEvaluationId: evaluation.id,
          engineVersion: 'checkin-readiness/1',
          readinessFingerprint: 'b'.repeat(64),
          readinessSnapshot: {},
          checkedInByIdentityId: agent.id,
        },
      }),
    ).rejects.toThrow(/compliance PASS or a current COMPLIANT review/);
  });

  it('serializes two simultaneous check-ins into one logical check-in', async () => {
    const ready = await compliantPassenger(t.app, env, customer, ruleManager);
    const subject = await ids(ready.bookingReference, ready.passengerReference);
    const [a, b] = await forcedOverlap(
      (tx) =>
        tx.$queryRaw`SELECT 1 FROM "booking_passenger" WHERE "booking_id" = ${subject.bookingId}::uuid AND "passenger_id" = ${subject.passengerId}::uuid FOR UPDATE`,
      [
        () =>
          customerCheckInApi(customer).checkIn(ready.bookingReference, ready.passengerReference),
        () => staffCheckInApi(agent).checkIn(ready.bookingReference, ready.passengerReference),
      ],
    );
    expect([a.status, b.status]).toEqual([201, 201]);
    expect([a.body.created, b.body.created].sort()).toEqual([false, true]);
    expect(a.body.checkIn.reference).toBe(b.body.checkIn.reference);
    expect(
      await db(t.app).passengerCheckIn.count({ where: { bookingId: subject.bookingId } }),
    ).toBe(1);
    expect(
      await db(t.app).auditEvent.count({
        where: {
          action: 'PASSENGER_CHECKED_IN',
          metadata: { path: ['bookingReference'], equals: ready.bookingReference },
        },
      }),
    ).toBe(1);
  });

  it('gives one booked seat to exactly one of two simultaneous passengers', async () => {
    const journey = await confirmedJourney(t.app, env, customer, { seats: ['1A', '1B'] });
    const first = await journeyPassenger(customer, journey, journey.origin.id);
    const second = await journeyPassenger(customer, journey, journey.origin.id, {
      givenName: 'Fatou',
    });
    const subject = await ids(journey.bookingReference, first);
    const [a, b] = await forcedOverlap(
      (tx) =>
        tx.$queryRaw`SELECT 1 FROM "booking_seat" WHERE "id" = ${subject.seat('1A')}::uuid FOR UPDATE`,
      [
        () =>
          customerCheckInApi(customer).seat(journey.bookingReference, first, { seatLabel: '1A' }),
        () => staffCheckInApi(agent).seat(journey.bookingReference, second, { seatLabel: '1A' }),
      ],
    );
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect([a.body.code, b.body.code]).toContain('SEAT_ALREADY_ASSIGNED');
    expect(
      await db(t.app).bookingPassengerSeat.count({ where: { bookingSeatId: subject.seat('1A') } }),
    ).toBe(1);
  });

  it('boards once under eight simultaneous scans of the same QR, then rejects a burst', async () => {
    const ready = await compliantPassenger(t.app, env, customer, ruleManager);
    const checkIn = await staffCheckInApi(agent).checkIn(
      ready.bookingReference,
      ready.passengerReference,
    );
    const payload = checkIn.body.checkIn.qrPayload as string;
    const row = await db(t.app).passengerCheckIn.findUniqueOrThrow({
      where: { reference: checkIn.body.checkIn.reference },
    });
    const occurredAt = new Date().toISOString();
    const responses = await forcedOverlap(
      (tx) =>
        tx.$queryRaw`SELECT 1 FROM "passenger_check_in" WHERE "id" = ${row.id}::uuid FOR UPDATE`,
      Array.from(
        { length: 8 },
        (_, index) => () =>
          boardingApi(dispatcher).scan(
            index < 4
              ? {
                  qrPayload: payload,
                  deviceId: 'gate-race',
                  clientEventId: 'scan-race-000001',
                  occurredAt,
                }
              : { qrPayload: payload, deviceId: `gate-race-${index}` },
          ),
      ),
    );
    const created = responses.filter(
      (response) => response.status === 201 && response.body.created,
    );
    expect(created).toHaveLength(1);
    for (const response of responses) {
      if (response === created[0]) continue;
      if (response.status === 201) expect(response.body.created).toBe(false);
      else expect(response.body.code).toBe('PASSENGER_ALREADY_BOARDED');
    }
    // A free burst afterwards adds nothing either.
    const burst = await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        boardingApi(dispatcher).scan({ qrPayload: payload, deviceId: `gate-burst-${index}` }),
      ),
    );
    expect(burst.every((response) => response.status === 409)).toBe(true);
    expect(await db(t.app).passengerBoarding.count({ where: { checkInId: row.id } })).toBe(1);
    expect(
      await db(t.app).auditEvent.count({
        where: { action: 'PASSENGER_BOARDED', resourceId: row.id },
      }),
    ).toBe(1);
  });

  it('keeps boarding append-only, staff-only, time-bounded and tied to a check-in', async () => {
    const ready = await compliantPassenger(t.app, env, customer, ruleManager);
    const checkIn = await staffCheckInApi(agent).checkIn(
      ready.bookingReference,
      ready.passengerReference,
    );
    const row = await db(t.app).passengerCheckIn.findUniqueOrThrow({
      where: { reference: checkIn.body.checkIn.reference },
    });
    const base = {
      checkInId: row.id,
      deviceId: 'gate-sql',
      payloadFingerprint: 'c'.repeat(64),
      readinessFingerprint: 'd'.repeat(64),
      occurredAt: new Date(),
      boardedByIdentityId: dispatcher.id,
    };
    await expect(
      db(t.app).passengerBoarding.create({
        data: {
          ...base,
          reference: 'ETE-000000000001',
          checkInId: '01900000-0000-7000-8000-000000000000',
        },
      }),
    ).rejects.toThrow(/Foreign key|passenger_boarding_check_in_id_fkey/i);
    await expect(
      db(t.app).passengerBoarding.create({
        data: { ...base, reference: 'ETE-000000000002', boardedByIdentityId: customer.id },
      }),
    ).rejects.toThrow(/only active STAFF may board a passenger/);
    await expect(
      db(t.app).passengerBoarding.create({
        data: {
          ...base,
          reference: 'ETE-000000000003',
          occurredAt: new Date(Date.now() + 3_600_000),
        },
      }),
    ).rejects.toThrow(/occurred_at is outside the accepted window/);
    await expect(
      db(t.app).passengerBoarding.create({
        data: { ...base, reference: 'ETE-000000000004', deviceId: 'bad device' },
      }),
    ).rejects.toThrow(/passenger_boarding_device_id_format|check constraint/i);
    const boarded = await db(t.app).passengerBoarding.create({
      data: { ...base, reference: 'ETE-000000000005' },
    });
    await expect(
      db(t.app).passengerBoarding.create({
        data: { ...base, reference: 'ETE-000000000006', deviceId: 'gate-sql-2' },
      }),
    ).rejects.toThrow(/Unique constraint failed/);
    await expect(
      db(t.app).passengerBoarding.update({
        where: { id: boarded.id },
        data: { deviceId: 'gate-other' },
      }),
    ).rejects.toThrow(/append-only/);
    await expect(db(t.app).passengerBoarding.delete({ where: { id: boarded.id } })).rejects.toThrow(
      /append-only/,
    );
    await expect(
      db(t.app).$executeRawUnsafe('TRUNCATE TABLE "passenger_boarding"'),
    ).rejects.toThrow(/cannot be truncated/);
  });

  it('rolls back check-in and boarding when their required audit write fails', async () => {
    const ready = await compliantPassenger(t.app, env, customer, ruleManager);
    const subject = await ids(ready.bookingReference, ready.passengerReference);
    await db(t.app).$executeRawUnsafe(`
      CREATE FUNCTION check_in_test_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action IN ('PASSENGER_CHECKED_IN', 'PASSENGER_BOARDED') THEN
          RAISE EXCEPTION 'synthetic check-in audit failure';
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER check_in_test_reject_audit
        BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION check_in_test_reject_audit();
    `);
    try {
      const failed = await staffCheckInApi(agent).checkIn(
        ready.bookingReference,
        ready.passengerReference,
      );
      expect(failed.status).toBe(500);
      expect(
        await db(t.app).passengerCheckIn.count({ where: { bookingId: subject.bookingId } }),
      ).toBe(0);
    } finally {
      await db(t.app).$executeRawUnsafe(`
        DROP TRIGGER check_in_test_reject_audit ON audit_event;
        DROP FUNCTION check_in_test_reject_audit();
      `);
    }
    const checkIn = await staffCheckInApi(agent).checkIn(
      ready.bookingReference,
      ready.passengerReference,
    );
    expect(checkIn.status).toBe(201);
    await db(t.app).$executeRawUnsafe(`
      CREATE FUNCTION check_in_test_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'PASSENGER_BOARDED' THEN RAISE EXCEPTION 'synthetic boarding audit failure'; END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER check_in_test_reject_audit
        BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION check_in_test_reject_audit();
    `);
    try {
      const failed = await boardingApi(dispatcher).scan({
        qrPayload: checkIn.body.checkIn.qrPayload,
        deviceId: 'gate-audit',
      });
      expect(failed.status).toBe(500);
      const row = await db(t.app).passengerCheckIn.findUniqueOrThrow({
        where: { reference: checkIn.body.checkIn.reference },
        include: { boarding: true },
      });
      expect(row.boarding).toBeNull();
    } finally {
      await db(t.app).$executeRawUnsafe(`
        DROP TRIGGER check_in_test_reject_audit ON audit_event;
        DROP FUNCTION check_in_test_reject_audit();
      `);
    }
  });
});
