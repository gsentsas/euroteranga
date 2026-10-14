import type { ApiEnv } from '@euroteranga/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminApi, staffActor, type StaffActor } from '../../support/admin-helpers.js';
import { db } from '../../support/auth-helpers.js';
import {
  confirmedPassenger,
  customerBaggageApi,
  staffBaggageApi,
} from '../../support/baggage-helpers.js';
import {
  bookableFixture,
  customerActor,
  type CustomerActor,
} from '../../support/booking-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

describe('staff baggage workspace, RBAC, lifecycle and audit', () => {
  let t: TestApp;
  let env: ApiEnv;
  let manager: StaffActor;
  let reader: StaffActor;
  let denied: StaffActor;
  let customer: CustomerActor;
  let subject: Awaited<ReturnType<typeof confirmedPassenger>>;
  let reference: string;

  beforeAll(async () => {
    env = integrationEnv();
    t = await startTestApp(env);
    [manager, reader, denied, customer] = await Promise.all([
      staffActor(t.app, ['OPS_MANAGER']),
      staffActor(t.app, ['CUSTOMER_SUPPORT']),
      staffActor(t.app, ['FINANCE']),
      customerActor(t.app),
    ]);
    subject = await confirmedPassenger(t.app, env, customer);
    const created = await customerBaggageApi(customer).register(
      subject.bookingReference,
      subject.passengerReference,
      { type: 'BOX' },
    );
    if (created.status !== 201) {
      throw new Error(`baggage fixture failed: ${created.text}\n${t.logs.raw.slice(-3).join('')}`);
    }
    reference = created.body.reference as string;
  }, 60_000);

  afterAll(async () => {
    await t.app.close();
  });

  it('separates baggage.read from baggage.manage and requires CSRF', async () => {
    expect((await staffBaggageApi(reader).detail(reference)).status).toBe(200);
    expect((await staffBaggageApi(reader).list(`?reference=${reference}`)).status).toBe(200);
    expect(
      (await staffBaggageApi(reader).weight(reference, { measuredWeightKg: '12.345' })).status,
    ).toBe(403);
    expect((await staffBaggageApi(denied).detail(reference)).status).toBe(403);
    expect(
      (
        await staffBaggageApi(manager).weight(
          reference,
          { measuredWeightKg: '12.345' },
          { csrf: null },
        )
      ).status,
    ).toBe(403);
  });

  it('records exact staff weight and refuses floats, overflow and customer authority', async () => {
    const response = await staffBaggageApi(manager).weight(reference, {
      measuredWeightKg: '12.345',
    });
    expect(response.status, response.text).toBe(201);
    expect(response.body).toMatchObject({
      created: true,
      event: { sequence: 2, type: 'WEIGHT_UPDATED', measuredWeightKg: '12.345' },
    });
    const stored = await db(t.app).baggage.findUniqueOrThrow({ where: { reference } });
    expect(stored.measuredWeightKg?.toFixed(3)).toBe('12.345');

    for (const measuredWeightKg of ['0', '1000', '12.3456', '1e2', '-1']) {
      const invalid = await staffBaggageApi(manager).weight(reference, { measuredWeightKg });
      expect(invalid.status, measuredWeightKg).toBe(400);
    }
    const unchanged = await staffBaggageApi(manager).weight(reference, {
      measuredWeightKg: '12.345',
    });
    expect(unchanged.status).toBe(409);
  });

  it('enforces normal progression and preserves exception history independently', async () => {
    const checkedIn = await staffBaggageApi(manager).event(reference, { type: 'CHECKED_IN' });
    expect(checkedIn.status, checkedIn.text).toBe(201);
    const missing = await staffBaggageApi(manager).event(reference, { type: 'MISSING' });
    expect(missing.status).toBe(201);
    expect(missing.body.event).toMatchObject({
      lifecycleStatus: 'CHECKED_IN',
      exceptionStatus: 'MISSING',
    });
    expect((await staffBaggageApi(manager).event(reference, { type: 'LOADED' })).status).toBe(409);
    expect(
      (await staffBaggageApi(manager).event(reference, { type: 'EXCEPTION_RESOLVED' })).status,
    ).toBe(201);

    for (const type of ['LOADED', 'IN_TRANSIT', 'ARRIVED', 'DELIVERED']) {
      const event = await staffBaggageApi(manager).event(reference, { type });
      expect(event.status, `${type}: ${event.text}`).toBe(201);
    }
    const detail = await staffBaggageApi(manager).detail(reference);
    expect(detail.body).toMatchObject({
      lifecycleStatus: 'DELIVERED',
      exceptionStatus: null,
      measuredWeightKg: '12.345',
    });
    expect(detail.body.events.map((event: { type: string }) => event.type)).toEqual([
      'REGISTERED',
      'WEIGHT_UPDATED',
      'CHECKED_IN',
      'MISSING',
      'EXCEPTION_RESOLVED',
      'LOADED',
      'IN_TRANSIT',
      'ARRIVED',
      'DELIVERED',
    ]);
    expect((await staffBaggageApi(manager).event(reference, { type: 'LOADED' })).status).toBe(409);
    expect((await staffBaggageApi(manager).event(reference, { type: 'REMOVED' })).status).toBe(409);
  });

  it('validates QR version, route location and bounded timestamps', async () => {
    const otherRoute = await bookableFixture(t.app);
    const another = await staffBaggageApi(manager).register({
      bookingReference: subject.bookingReference,
      passengerReference: subject.passengerReference,
      type: 'OTHER',
    });
    expect(another.status).toBe(201);
    const anotherReference = another.body.reference as string;
    expect(
      (
        await staffBaggageApi(manager).event(anotherReference, {
          type: 'CHECKED_IN',
          routeWaypointId: otherRoute.wp[1],
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await staffBaggageApi(manager).event(anotherReference, {
          type: 'CHECKED_IN',
          occurredAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        })
      ).status,
    ).toBe(422);
    expect((await staffBaggageApi(manager).resolveQr(`ETG2:${anotherReference}`)).status).toBe(422);
    const resolved = await staffBaggageApi(manager).resolveQr(`ETG1:${anotherReference}`);
    expect(resolved.status).toBe(201);
    expect(resolved.body.reference).toBe(anotherReference);
  });

  it('filters and paginates server-side, emits only business references in audit', async () => {
    const result = await staffBaggageApi(manager).list(
      `?limit=1&bookingReference=${subject.bookingReference}&type=BOX`,
    );
    expect(result.status).toBe(200);
    expect(result.body.items).toHaveLength(1);
    expect(result.body.items[0]).toMatchObject({ reference, type: 'BOX' });

    const bag = await db(t.app).baggage.findUniqueOrThrow({ where: { reference } });
    const actions = await db(t.app).auditEvent.findMany({
      where: { resourceId: bag.id },
      select: { action: true, before: true, after: true, metadata: true },
    });
    expect(actions.map((event) => event.action)).toEqual(
      expect.arrayContaining([
        'BAGGAGE_REGISTERED',
        'BAGGAGE_WEIGHT_UPDATED',
        'BAGGAGE_EVENT_RECORDED',
        'BAGGAGE_ACCESSED',
      ]),
    );
    const auditJson = JSON.stringify(actions);
    expect(auditJson).not.toContain(customer.email);
    expect(auditJson).not.toContain('<svg');
    expect(auditJson).not.toContain('clientEventId');

    // The permission catalogue is really enforced by the shared authorization layer.
    const access = await adminApi(reader).get('/access/me');
    expect(access.body.permissions).toContain('baggage.read');
    expect(access.body.permissions).not.toContain('baggage.manage');
  });

  it('records authenticated QR scans idempotently, even after later events', async () => {
    const registered = await staffBaggageApi(manager).register({
      bookingReference: subject.bookingReference,
      passengerReference: subject.passengerReference,
      type: 'TRAVEL_BAG',
    });
    expect(registered.status, registered.text).toBe(201);
    const bag = registered.body.reference as string;
    const scan = {
      type: 'CHECKED_IN',
      occurredAt: new Date().toISOString(),
      clientEventId: 'scan-checkin-0001',
    };
    // A QR payload is an identifier, never an authorization.
    expect((await staffBaggageApi(reader).scan({ qrPayload: `ETG1:${bag}`, ...scan })).status).toBe(
      403,
    );
    expect((await staffBaggageApi(manager).scan({ qrPayload: bag, ...scan })).status).toBe(422);
    expect(
      (await staffBaggageApi(manager).scan({ qrPayload: `ETG2:${bag}`, ...scan })).status,
    ).toBe(422);

    const first = await staffBaggageApi(manager).scan({ qrPayload: `ETG1:${bag}`, ...scan });
    expect(first.status, first.text).toBe(201);
    expect(first.body).toMatchObject({ created: true, event: { sequence: 2, type: 'CHECKED_IN' } });
    expect((await staffBaggageApi(manager).event(bag, { type: 'LOADED' })).status).toBe(201);

    // The offline retry arrives after LOADED: same logical event, no 409.
    const replay = await staffBaggageApi(manager).scan({ qrPayload: `ETG1:${bag}`, ...scan });
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual({ created: false, event: first.body.event });
    const conflict = await staffBaggageApi(manager).scan({
      qrPayload: `ETG1:${bag}`,
      ...scan,
      type: 'IN_TRANSIT',
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('BAGGAGE_CLIENT_EVENT_ID_REUSED');

    const stored = await db(t.app).baggage.findUniqueOrThrow({
      where: { reference: bag },
      include: { events: { orderBy: { sequence: 'asc' } } },
    });
    expect(stored.lifecycleStatus).toBe('LOADED');
    expect(stored.events.map((event) => event.type)).toEqual([
      'REGISTERED',
      'CHECKED_IN',
      'LOADED',
    ]);
  });

  it('records REMOVED as audited terminal history and never deletes the bag', async () => {
    const registered = await staffBaggageApi(manager).register({
      bookingReference: subject.bookingReference,
      passengerReference: subject.passengerReference,
      type: 'SUITCASE',
    });
    expect(registered.status, registered.text).toBe(201);
    const bag = registered.body.reference as string;
    const removed = await staffBaggageApi(manager).event(bag, { type: 'REMOVED' });
    expect(removed.status, removed.text).toBe(201);
    expect(removed.body.event).toMatchObject({ type: 'REMOVED', lifecycleStatus: 'REMOVED' });
    const row = await db(t.app).baggage.findUniqueOrThrow({ where: { reference: bag } });
    expect(row.lifecycleStatus).toBe('REMOVED');
    const audits = await db(t.app).auditEvent.findMany({
      where: { resourceId: row.id, action: 'BAGGAGE_REMOVED' },
      select: { metadata: true },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toMatchObject({ reference: bag, event: 'REMOVED', sequence: 2 });
    expect((await staffBaggageApi(manager).detail(bag)).body.lifecycleStatus).toBe('REMOVED');
    expect((await staffBaggageApi(manager).event(bag, { type: 'CHECKED_IN' })).status).toBe(409);
  });
});
