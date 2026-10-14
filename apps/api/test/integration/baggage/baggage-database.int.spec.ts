import type { ApiEnv } from '@euroteranga/config';
import type { Prisma } from '@euroteranga/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isolatedDatabase, staffActor, type StaffActor } from '../../support/admin-helpers.js';
import { db } from '../../support/auth-helpers.js';
import {
  confirmedPassenger,
  customerBaggageApi,
  staffBaggageApi,
} from '../../support/baggage-helpers.js';
import { customerActor, type CustomerActor } from '../../support/booking-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

describe('baggage PostgreSQL invariants, idempotence and true concurrency', () => {
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let t: TestApp;
  let env: ApiEnv;
  let manager: StaffActor;
  let customer: CustomerActor;
  let stranger: CustomerActor;
  let subject: Awaited<ReturnType<typeof confirmedPassenger>>;
  let foreignSubject: Awaited<ReturnType<typeof confirmedPassenger>>;

  beforeAll(async () => {
    database = await isolatedDatabase();
    env = integrationEnv({ DATABASE_URL: database.url });
    t = await startTestApp(env);
    [manager, customer, stranger] = await Promise.all([
      staffActor(t.app, ['OPS_MANAGER']),
      customerActor(t.app),
      customerActor(t.app),
    ]);
    [subject, foreignSubject] = await Promise.all([
      confirmedPassenger(t.app, env, customer, ['1A', '1B']),
      confirmedPassenger(t.app, env, stranger),
    ]);
  }, 60_000);

  afterAll(async () => {
    await t.app.close();
    await database.drop();
  });

  async function createBag(type = 'SUITCASE') {
    const response = await customerBaggageApi(customer).register(
      subject.bookingReference,
      subject.passengerReference,
      { type },
    );
    if (response.status !== 201) throw new Error(`baggage creation failed: ${response.text}`);
    const reference = response.body.reference as string;
    const row = await db(t.app).baggage.findUniqueOrThrow({ where: { reference } });
    return { reference, row };
  }

  async function lockWaiters(): Promise<number> {
    const [row] = await db(t.app).$queryRaw<Array<{ count: bigint }>>`
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
      'both HTTP operations must overlap behind the row lock',
    ).toBeGreaterThanOrEqual(count);
  }

  async function forcedOverlap<A, B>(
    baggageId: string,
    first: () => PromiseLike<A>,
    second: () => PromiseLike<B>,
  ) {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const gate = db(t.app).$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "baggage" WHERE "id" = ${baggageId}::uuid FOR UPDATE`;
        locked();
        await released;
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    await isLocked;
    const a = Promise.resolve(first());
    await waitForWaiters(1);
    const b = Promise.resolve(second());
    await waitForWaiters(2);
    release();
    await gate;
    return Promise.all([a, b]);
  }

  it('exposes the intended catalogue, numeric precision, composite ownership and guards', async () => {
    const columns = await db(t.app).$queryRaw<
      Array<{
        table_name: string;
        column_name: string;
        data_type: string;
        numeric_precision: number | null;
        numeric_scale: number | null;
      }>
    >`
      SELECT table_name, column_name, data_type, numeric_precision, numeric_scale
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('baggage', 'baggage_event')
      ORDER BY table_name, ordinal_position`;
    expect(new Set(columns.map((column) => column.table_name))).toEqual(
      new Set(['baggage', 'baggage_event']),
    );
    for (const name of ['measured_weight_kg', 'included_weight_kg', 'excess_weight_kg']) {
      expect(
        columns.find((column) => column.table_name === 'baggage' && column.column_name === name),
      ).toMatchObject({
        data_type: 'numeric',
        numeric_precision: 6,
        numeric_scale: 3,
      });
    }
    const [composite] = await db(t.app).$queryRaw<Array<{ definition: string }>>`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conname = 'baggage_booking_passenger_fkey'`;
    expect(composite?.definition).toContain(
      'FOREIGN KEY (booking_id, passenger_id) REFERENCES booking_passenger(booking_id, passenger_id)',
    );

    const triggers = await db(t.app).$queryRaw<Array<{ name: string }>>`
      SELECT tgname AS name FROM pg_trigger
      WHERE NOT tgisinternal AND tgrelid IN ('baggage'::regclass, 'baggage_event'::regclass)`;
    expect(triggers.map((trigger) => trigger.name)).toEqual(
      expect.arrayContaining([
        'baggage_guard',
        'baggage_event_guard',
        'baggage_projection_consistency_on_baggage',
        'baggage_projection_consistency_on_event',
        'baggage_no_truncate',
        'baggage_event_no_truncate',
      ]),
    );

    const grants = await db(t.app).authorizationPermission.findMany({
      where: { key: { startsWith: 'baggage.' } },
      include: { roles: true },
      orderBy: { key: 'asc' },
    });
    expect(grants.map((permission) => permission.key)).toEqual(['baggage.manage', 'baggage.read']);
    expect(
      grants
        .find((permission) => permission.key === 'baggage.manage')
        ?.roles.map((role) => role.roleKey),
    ).not.toContain('CUSTOMER_SUPPORT');

    const unique = await db(t.app).$queryRaw<Array<{ name: string; definition: string }>>`
      SELECT indexname AS name, indexdef AS definition FROM pg_indexes
      WHERE schemaname = 'public' AND tablename IN ('baggage', 'baggage_event')
        AND indexdef LIKE 'CREATE UNIQUE INDEX%'
      ORDER BY indexname`;
    expect(unique.map((index) => index.definition)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'baggage_event_baggage_id_client_event_id_key ON public.baggage_event USING btree (baggage_id, client_event_id)',
        ),
        expect.stringContaining(
          'baggage_event_baggage_id_sequence_key ON public.baggage_event USING btree (baggage_id, sequence)',
        ),
        expect.stringContaining('baggage_reference_key ON public.baggage USING btree (reference)'),
      ]),
    );
  });

  it('requires one valid initial event and protects subject, identity and policy snapshots', async () => {
    const pair = await db(t.app).bookingPassenger.findUniqueOrThrow({
      where: {
        bookingId_passengerId: {
          bookingId: (
            await db(t.app).booking.findUniqueOrThrow({
              where: { reference: subject.bookingReference },
              select: { id: true },
            })
          ).id,
          passengerId: (
            await db(t.app).passenger.findUniqueOrThrow({
              where: { reference: subject.passengerReference },
              select: { id: true },
            })
          ).id,
        },
      },
    });

    await expect(
      db(t.app).baggage.create({
        data: {
          reference: 'ETG-000000000000',
          bookingId: pair.bookingId,
          passengerId: pair.passengerId,
          type: 'SUITCASE',
        },
      }),
    ).rejects.toThrow(/initial REGISTERED event/);
    await expect(
      db(t.app).baggage.create({
        data: {
          reference: 'ETG-000000000001',
          bookingId: pair.bookingId,
          passengerId: pair.passengerId,
          type: 'SUITCASE',
          lifecycleStatus: 'DELIVERED',
        },
      }),
    ).rejects.toThrow(/registered without operational/);

    const foreignBooking = await db(t.app).booking.findUniqueOrThrow({
      where: { reference: foreignSubject.bookingReference },
    });
    await expect(
      db(t.app).baggage.create({
        data: {
          reference: 'ETG-000000000002',
          bookingId: foreignBooking.id,
          passengerId: pair.passengerId,
          type: 'BOX',
        },
      }),
    ).rejects.toThrow(/Foreign key constraint|foreign key/i);

    await expect(
      db(t.app).baggage.create({
        data: {
          reference: 'ETG-000000000004',
          bookingId: pair.bookingId,
          passengerId: pair.passengerId,
          type: 'SUITCASE',
          measuredWeightKg: '12.345',
        },
      }),
    ).rejects.toThrow(/registered without operational/);

    const { row } = await createBag();
    // The public reference is unique: a second bag cannot reuse it.
    await expect(
      db(t.app).baggage.create({
        data: {
          reference: row.reference,
          bookingId: pair.bookingId,
          passengerId: pair.passengerId,
          type: 'BOX',
        },
      }),
    ).rejects.toThrow(/Unique constraint failed/);
    await expect(
      db(t.app).baggage.update({ where: { id: row.id }, data: { reference: 'ETG-111111111111' } }),
    ).rejects.toThrow(/identity, subject, type and reference are immutable/);
    await expect(
      db(t.app).baggage.update({ where: { id: row.id }, data: { type: 'BOX' } }),
    ).rejects.toThrow(/identity, subject, type and reference are immutable/);
    await expect(
      db(t.app).baggage.update({ where: { id: row.id }, data: { includedWeightKg: '20.000' } }),
    ).rejects.toThrow(/no PR-13 policy/);
    await expect(
      db(t.app).baggage.update({ where: { id: row.id }, data: { lifecycleStatus: 'CHECKED_IN' } }),
    ).rejects.toThrow(/matching event/);
  });

  it('makes event history append-only, sequence-safe and projection-consistent', async () => {
    const { row, reference } = await createBag('TRAVEL_BAG');
    const registered = await db(t.app).baggageEvent.findFirstOrThrow({
      where: { baggageId: row.id },
    });
    await expect(
      db(t.app).baggageEvent.update({ where: { id: registered.id }, data: { sequence: 9 } }),
    ).rejects.toThrow(/append-only/);
    await expect(db(t.app).baggageEvent.delete({ where: { id: registered.id } })).rejects.toThrow(
      /append-only/,
    );
    await expect(db(t.app).baggage.delete({ where: { id: row.id } })).rejects.toThrow(
      /cannot be deleted/,
    );
    await expect(db(t.app).$executeRawUnsafe('TRUNCATE TABLE "baggage_event"')).rejects.toThrow(
      /cannot be truncated/,
    );
    await expect(db(t.app).$executeRawUnsafe('TRUNCATE TABLE "baggage"')).rejects.toThrow(
      /cannot be truncated|cannot truncate a table referenced/i,
    );

    await expect(
      db(t.app).baggageEvent.create({
        data: {
          baggageId: row.id,
          sequence: 5,
          type: 'CHECKED_IN',
          lifecycleStatus: 'CHECKED_IN',
          occurredAt: new Date(),
          actorIdentityId: manager.id,
          payloadFingerprint: 'a'.repeat(64),
        },
      }),
    ).rejects.toThrow(/sequence must be 2/);

    // An event without its projection is rejected by the deferred assertion.
    await expect(
      db(t.app).baggageEvent.create({
        data: {
          baggageId: row.id,
          sequence: 2,
          type: 'CHECKED_IN',
          lifecycleStatus: 'CHECKED_IN',
          occurredAt: new Date(),
          actorIdentityId: manager.id,
          payloadFingerprint: 'b'.repeat(64),
        },
      }),
    ).rejects.toThrow(/projection must equal/);

    expect((await staffBaggageApi(manager).event(reference, { type: 'CHECKED_IN' })).status).toBe(
      201,
    );
    const events = await db(t.app).baggageEvent.findMany({
      where: { baggageId: row.id },
      orderBy: { sequence: 'asc' },
    });
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
  });

  it('stores exact weights as three-decimal strings and enforces numeric bounds in SQL', async () => {
    const { reference, row } = await createBag('BOX');
    for (const [input, weight] of [
      ['0.001', '0.001'],
      ['12.345', '12.345'],
      ['99.999', '99.999'],
      ['20.5', '20.500'],
      ['999.999', '999.999'],
    ]) {
      const response = await staffBaggageApi(manager).weight(reference, {
        measuredWeightKg: input,
      });
      expect(response.status, `${input}: ${response.text}`).toBe(201);
      expect(response.body.event.measuredWeightKg).toBe(weight);
      expect(
        (
          await db(t.app).baggage.findUniqueOrThrow({ where: { id: row.id } })
        ).measuredWeightKg?.toFixed(3),
      ).toBe(weight);
      expect((await staffBaggageApi(manager).detail(reference)).body.measuredWeightKg).toBe(weight);
    }
    await expect(
      db(t.app).$executeRaw`
        UPDATE "baggage" SET "measured_weight_kg" = 1000.000 WHERE "id" = ${row.id}::uuid`,
    ).rejects.toThrow(/numeric field overflow|baggage_measured_weight_valid/i);
    await expect(
      db(t.app).baggageEvent.create({
        data: {
          baggageId: row.id,
          sequence: 7,
          type: 'WEIGHT_UPDATED',
          lifecycleStatus: 'REGISTERED',
          measuredWeightKg: '-0.001',
          occurredAt: new Date(),
          actorIdentityId: manager.id,
          payloadFingerprint: 'd'.repeat(64),
        },
      }),
    ).rejects.toThrow(/baggage_event_weight_valid|check constraint/i);
  });

  /** One direct-SQL event with its projection, bypassing the API checks. */
  async function directEvent(
    baggageId: string,
    data: {
      sequence: number;
      type: string;
      lifecycleStatus: string;
      exceptionStatus?: string | null;
      measuredWeightKg?: string | null;
      clientEventId?: string;
      actorIdentityId?: string;
    },
  ) {
    await db(t.app).$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO "baggage_event" ("id", "baggage_id", "sequence", "type", "lifecycle_status",
          "exception_status", "measured_weight_kg", "occurred_at", "actor_identity_id",
          "client_event_id", "payload_fingerprint")
        VALUES (gen_random_uuid(), ${baggageId}::uuid, ${data.sequence},
          ${data.type}::"baggage_event_type", ${data.lifecycleStatus}::"baggage_lifecycle_status",
          ${data.exceptionStatus ?? null}::"baggage_exception_status",
          ${data.measuredWeightKg ?? null}::numeric, now(),
          ${data.actorIdentityId ?? manager.id}::uuid, ${data.clientEventId ?? null},
          ${'e'.repeat(64)})`;
      await tx.$executeRaw`
        UPDATE "baggage" SET "lifecycle_status" = ${data.lifecycleStatus}::"baggage_lifecycle_status",
          "exception_status" = ${data.exceptionStatus ?? null}::"baggage_exception_status",
          "measured_weight_kg" = ${data.measuredWeightKg ?? null}::numeric
        WHERE "id" = ${baggageId}::uuid`;
    });
  }

  it('enforces the transition matrix and actor rules in PostgreSQL, not only in the API', async () => {
    const { row, reference } = await createBag();
    await expect(
      directEvent(row.id, { sequence: 2, type: 'DELIVERED', lifecycleStatus: 'DELIVERED' }),
    ).rejects.toThrow(/invalid baggage lifecycle transition from REGISTERED to DELIVERED/);
    await expect(
      directEvent(row.id, { sequence: 2, type: 'REGISTERED', lifecycleStatus: 'REGISTERED' }),
    ).rejects.toThrow(/REGISTERED is only valid as the first baggage event/);
    await expect(
      directEvent(row.id, {
        sequence: 2,
        type: 'CHECKED_IN',
        lifecycleStatus: 'CHECKED_IN',
        actorIdentityId: customer.id,
      }),
    ).rejects.toThrow(/only active STAFF may record operational baggage events/);
    await expect(
      directEvent(row.id, {
        sequence: 2,
        type: 'WEIGHT_UPDATED',
        lifecycleStatus: 'CHECKED_IN',
        measuredWeightKg: '1.000',
      }),
    ).rejects.toThrow(/WEIGHT_UPDATED must change only the exact measured weight/);

    expect((await staffBaggageApi(manager).event(reference, { type: 'DAMAGED' })).status).toBe(201);
    await expect(
      directEvent(row.id, {
        sequence: 3,
        type: 'CHECKED_IN',
        lifecycleStatus: 'CHECKED_IN',
        exceptionStatus: 'DAMAGED',
      }),
    ).rejects.toThrow(/resolve the active baggage exception before normal progression/);
    await expect(
      directEvent(row.id, {
        sequence: 3,
        type: 'MISSING',
        lifecycleStatus: 'REGISTERED',
        exceptionStatus: 'MISSING',
      }),
    ).rejects.toThrow(/baggage cannot open this exception/);
    await expect(
      directEvent(row.id, {
        sequence: 3,
        type: 'EXCEPTION_RESOLVED',
        lifecycleStatus: 'REGISTERED',
        exceptionStatus: 'DAMAGED',
      }),
    ).rejects.toThrow(/EXCEPTION_RESOLVED requires and clears one active exception/);

    // A valid direct event is accepted: the guards are the matrix, not a lock-out.
    await directEvent(row.id, {
      sequence: 3,
      type: 'EXCEPTION_RESOLVED',
      lifecycleStatus: 'REGISTERED',
    });
    await directEvent(row.id, { sequence: 4, type: 'CHECKED_IN', lifecycleStatus: 'CHECKED_IN' });
    const stored = await db(t.app).baggage.findUniqueOrThrow({
      where: { id: row.id },
      include: { events: { orderBy: { sequence: 'asc' } } },
    });
    expect(stored.lifecycleStatus).toBe('CHECKED_IN');
    expect(stored.events.map((event) => event.type)).toEqual([
      'REGISTERED',
      'DAMAGED',
      'EXCEPTION_RESOLVED',
      'CHECKED_IN',
    ]);
  });

  it('refuses a batch of events appended before the projection follows', async () => {
    const { row } = await createBag();
    const insert = (tx: Prisma.TransactionClient, sequence: number) =>
      tx.$executeRaw`
        INSERT INTO "baggage_event" ("id", "baggage_id", "sequence", "type", "lifecycle_status",
          "occurred_at", "actor_identity_id", "payload_fingerprint")
        VALUES (gen_random_uuid(), ${row.id}::uuid, ${sequence}, 'CHECKED_IN', 'CHECKED_IN',
          now(), ${manager.id}::uuid, ${'f'.repeat(64)})`;
    // Two CHECKED_IN events validated against the same stale projection would
    // duplicate a transition; the guard requires each event to be projected first.
    await expect(
      db(t.app).$transaction(async (tx) => {
        await insert(tx, 2);
        await insert(tx, 3);
        await tx.$executeRaw`
          UPDATE "baggage" SET "lifecycle_status" = 'CHECKED_IN' WHERE "id" = ${row.id}::uuid`;
      }),
    ).rejects.toThrow(/projection must be updated before the next event/);
    expect(await db(t.app).baggageEvent.count({ where: { baggageId: row.id } })).toBe(1);
  });

  it('serializes concurrent direct writers on the bag row and re-validates the second', async () => {
    const { row } = await createBag();
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let inserted!: () => void;
    const isInserted = new Promise<void>((resolve) => (inserted = resolve));
    const first = db(t.app).$transaction(
      async (tx) => {
        await tx.$executeRaw`
          INSERT INTO "baggage_event" ("id", "baggage_id", "sequence", "type", "lifecycle_status",
            "occurred_at", "actor_identity_id", "payload_fingerprint")
          VALUES (gen_random_uuid(), ${row.id}::uuid, 2, 'CHECKED_IN', 'CHECKED_IN',
            now(), ${manager.id}::uuid, ${'1'.repeat(64)})`;
        await tx.$executeRaw`
          UPDATE "baggage" SET "lifecycle_status" = 'CHECKED_IN' WHERE "id" = ${row.id}::uuid`;
        inserted();
        await released;
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    await isInserted;
    const second = directEvent(row.id, {
      sequence: 2,
      type: 'MISSING',
      lifecycleStatus: 'REGISTERED',
      exceptionStatus: 'MISSING',
    }).then(
      () => null,
      (error: unknown) => String(error),
    );
    await waitForWaiters(1);
    release();
    await first;
    // The trigger waited on the bag row lock, then saw the committed event.
    expect(await second).toMatch(/baggage event sequence must be 3/);
    const events = await db(t.app).baggageEvent.findMany({
      where: { baggageId: row.id },
      orderBy: { sequence: 'asc' },
    });
    expect(events.map((event) => [event.sequence, event.type])).toEqual([
      [1, 'REGISTERED'],
      [2, 'CHECKED_IN'],
    ]);
  });

  it('keeps clientEventId unique per bag in PostgreSQL', async () => {
    const { row, reference } = await createBag();
    const first = await staffBaggageApi(manager).event(reference, {
      type: 'CHECKED_IN',
      occurredAt: new Date().toISOString(),
      clientEventId: 'evt-unique-sql-0001',
    });
    expect(first.status, first.text).toBe(201);
    await expect(
      directEvent(row.id, {
        sequence: 3,
        type: 'LOADED',
        lifecycleStatus: 'LOADED',
        clientEventId: 'evt-unique-sql-0001',
      }),
    ).rejects.toThrow(/baggage_event_baggage_id_client_event_id_key|duplicate key/);
    // The same id on another bag is a different logical event.
    const other = await createBag();
    await directEvent(other.row.id, {
      sequence: 2,
      type: 'CHECKED_IN',
      lifecycleStatus: 'CHECKED_IN',
      clientEventId: 'evt-unique-sql-0001',
    });
  });

  it('deduplicates simultaneous clientEventId retries and rejects payload reuse', async () => {
    const { reference, row } = await createBag();
    const occurredAt = new Date().toISOString();
    const body = {
      type: 'CHECKED_IN',
      occurredAt,
      clientEventId: 'evt-idempotent-0001',
    };
    const [a, b] = await forcedOverlap(
      row.id,
      () => staffBaggageApi(manager).event(reference, body),
      () => staffBaggageApi(manager).event(reference, body),
    );
    expect([a.status, b.status]).toEqual([201, 201]);
    expect([a.body.created, b.body.created].sort()).toEqual([false, true]);
    expect(
      await db(t.app).baggageEvent.count({
        where: { baggageId: row.id, clientEventId: body.clientEventId },
      }),
    ).toBe(1);
    expect(a.body.event).toEqual(b.body.event);

    const conflict = await staffBaggageApi(manager).event(reference, {
      type: 'ARRIVED',
      occurredAt,
      clientEventId: body.clientEventId,
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('BAGGAGE_CLIENT_EVENT_ID_REUSED');
  });

  it('serializes two equal transitions with a real lock waiter and loses no event', async () => {
    const { reference, row } = await createBag();
    const [a, b] = await forcedOverlap(
      row.id,
      () => staffBaggageApi(manager).event(reference, { type: 'CHECKED_IN' }),
      () => staffBaggageApi(manager).event(reference, { type: 'CHECKED_IN' }),
    );
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const stored = await db(t.app).baggage.findUniqueOrThrow({
      where: { id: row.id },
      include: { events: { orderBy: { sequence: 'asc' } } },
    });
    expect(stored.lifecycleStatus).toBe('CHECKED_IN');
    expect(stored.events.map((event) => [event.sequence, event.type])).toEqual([
      [1, 'REGISTERED'],
      [2, 'CHECKED_IN'],
    ]);
  });

  it('serializes incompatible transitions without duplicate sequence or mismatch', async () => {
    const { reference, row } = await createBag();
    const [a, b] = await forcedOverlap(
      row.id,
      () => staffBaggageApi(manager).event(reference, { type: 'CHECKED_IN' }),
      () => staffBaggageApi(manager).event(reference, { type: 'ARRIVED' }),
    );
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const stored = await db(t.app).baggage.findUniqueOrThrow({
      where: { id: row.id },
      include: { events: { orderBy: { sequence: 'asc' } } },
    });
    expect(stored.lifecycleStatus).toBe('CHECKED_IN');
    expect(stored.events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(stored.events.at(-1)?.lifecycleStatus).toBe(stored.lifecycleStatus);
  });

  it('treats REMOVED as history, never DELETE, and as a terminal projection', async () => {
    const { reference, row } = await createBag();
    expect((await staffBaggageApi(manager).event(reference, { type: 'REMOVED' })).status).toBe(201);
    expect((await staffBaggageApi(manager).event(reference, { type: 'MISSING' })).status).toBe(409);
    expect(
      (await staffBaggageApi(manager).weight(reference, { measuredWeightKg: '1.000' })).status,
    ).toBe(409);
    expect(await db(t.app).baggage.count({ where: { id: row.id } })).toBe(1);
    expect(await db(t.app).baggageEvent.count({ where: { baggageId: row.id } })).toBe(2);
    await expect(
      db(t.app).baggageEvent.create({
        data: {
          baggageId: row.id,
          sequence: 3,
          type: 'MISSING',
          lifecycleStatus: 'REMOVED',
          exceptionStatus: 'MISSING',
          occurredAt: new Date(),
          actorIdentityId: manager.id,
          payloadFingerprint: 'c'.repeat(64),
        },
      }),
    ).rejects.toThrow(/REMOVED is terminal/);
  });

  it('rolls back the business event when its required audit write fails', async () => {
    const { reference, row } = await createBag();
    await db(t.app).$executeRawUnsafe(`
      CREATE FUNCTION baggage_test_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action LIKE 'BAGGAGE_%' THEN
          RAISE EXCEPTION 'synthetic baggage audit failure';
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER baggage_test_reject_audit
        BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION baggage_test_reject_audit();
    `);
    try {
      const response = await staffBaggageApi(manager).event(reference, { type: 'CHECKED_IN' });
      expect(response.status).toBe(500);
      const stored = await db(t.app).baggage.findUniqueOrThrow({
        where: { id: row.id },
        include: { events: true },
      });
      expect(stored.lifecycleStatus).toBe('REGISTERED');
      expect(stored.events).toHaveLength(1);
    } finally {
      await db(t.app).$executeRawUnsafe(`
        DROP TRIGGER baggage_test_reject_audit ON audit_event;
        DROP FUNCTION baggage_test_reject_audit();
      `);
    }
  });

  it('refuses a cancelled historical booking and keeps no partial baggage', async () => {
    const cancellable = await confirmedPassenger(t.app, env, customer);
    const booking = await db(t.app).booking.findUniqueOrThrow({
      where: { reference: cancellable.bookingReference },
      select: { id: true },
    });
    // PR-10 deliberately forbids cancellation after confirmation. Simulate a
    // pre-existing corrupted/historical row with triggers disabled only in
    // this isolated test transaction, then prove the PR-13 guard fails closed.
    await db(t.app).$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
      await tx.$executeRaw`
        UPDATE "booking"
        SET "confirmed_at" = NULL,
            "cancelled_at" = now(),
            "cancellation_reason" = 'Annulation synthétique pour invariant bagage.'
        WHERE "id" = ${booking.id}::uuid`;
    });
    const passenger = await db(t.app).passenger.findUniqueOrThrow({
      where: { reference: cancellable.passengerReference },
      select: { id: true },
    });
    await expect(
      db(t.app).baggage.create({
        data: {
          reference: 'ETG-000000000003',
          bookingId: booking.id,
          passengerId: passenger.id,
          type: 'OTHER',
        },
      }),
    ).rejects.toThrow(/confirmed, active scheduled journey/);
    const response = await customerBaggageApi(customer).register(
      cancellable.bookingReference,
      cancellable.passengerReference,
    );
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('BAGGAGE_BOOKING_NOT_ELIGIBLE');
    expect(await db(t.app).baggage.count({ where: { bookingId: booking.id } })).toBe(0);
  });
});
