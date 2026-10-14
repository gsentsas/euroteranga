import type { ApiEnv } from '@euroteranga/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, withoutRequestId } from '../../support/auth-helpers.js';
import { confirmedPassenger, customerBaggageApi } from '../../support/baggage-helpers.js';
import { customerActor, type CustomerActor } from '../../support/booking-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

describe('customer baggage registration and ownership', () => {
  let t: TestApp;
  let env: ApiEnv;
  let owner: CustomerActor;
  let stranger: CustomerActor;
  let subject: Awaited<ReturnType<typeof confirmedPassenger>>;
  let foreign: Awaited<ReturnType<typeof confirmedPassenger>>;
  let reference: string;

  beforeAll(async () => {
    env = integrationEnv();
    t = await startTestApp(env);
    [owner, stranger] = await Promise.all([customerActor(t.app), customerActor(t.app)]);
    [subject, foreign] = await Promise.all([
      confirmedPassenger(t.app, env, owner),
      confirmedPassenger(t.app, env, stranger),
    ]);
  });

  afterAll(async () => {
    await t.app.close();
  });

  it('atomically registers on the owned BookingPassenger with its initial event', async () => {
    const response = await customerBaggageApi(owner).register(
      subject.bookingReference,
      subject.passengerReference,
      { type: 'SUITCASE' },
    );
    expect(response.status, `${response.text}\n${t.logs.raw.slice(-3).join('')}`).toBe(201);
    reference = response.body.reference as string;
    expect(response.body).toMatchObject({
      reference: expect.stringMatching(/^ETG-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/u),
      qrPayload: expect.stringMatching(/^ETG1:ETG-/u),
      type: 'SUITCASE',
      lifecycleStatus: 'REGISTERED',
      exceptionStatus: null,
      measuredWeightKg: null,
      passenger: { reference: subject.passengerReference },
      booking: { reference: subject.bookingReference },
      events: [{ sequence: 1, type: 'REGISTERED', lifecycleStatus: 'REGISTERED' }],
    });

    const stored = await db(t.app).baggage.findUniqueOrThrow({
      where: { reference },
      include: { events: true },
    });
    expect(stored.events).toHaveLength(1);
    expect(stored.events[0]).toMatchObject({ sequence: 1, type: 'REGISTERED' });
    expect(
      await db(t.app).auditEvent.count({
        where: { resourceId: stored.id, action: 'BAGGAGE_REGISTERED' },
      }),
    ).toBe(1);
  });

  it('lists, reads and renders only the owner baggage with a PII-free QR', async () => {
    const list = await customerBaggageApi(owner).list(subject.bookingReference);
    expect(list.status).toBe(200);
    expect(list.body.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ reference, measuredWeightKg: null })]),
    );
    const detail = await customerBaggageApi(owner).detail(reference);
    expect(detail.status).toBe(200);
    expect(detail.body.events).toHaveLength(1);

    const qr = await customerBaggageApi(owner).qr(reference);
    expect(qr.status).toBe(200);
    expect(qr.body).toMatchObject({ reference, svg: expect.stringContaining('<svg') });
    expect(qr.headers['cache-control']).toContain('no-store');
    expect(qr.headers['x-content-type-options']).toBe('nosniff');
    expect(qr.body.svg).not.toContain(owner.email);
    expect(qr.body.svg).not.toContain('Awa');
    expect(detail.body.qrPayload).toBe(`ETG1:${reference}`);
  });

  it('makes a foreign reference indistinguishable from an unknown one', async () => {
    const unknown = 'ETG-ZZZZZZZZZZZZ';
    const foreignDetail = await customerBaggageApi(stranger).detail(reference);
    const unknownDetail = await customerBaggageApi(stranger).detail(unknown);
    expect(foreignDetail.status).toBe(404);
    expect(withoutRequestId(foreignDetail.body)).toEqual(withoutRequestId(unknownDetail.body));

    const foreignQr = await customerBaggageApi(stranger).qr(reference);
    const unknownQr = await customerBaggageApi(stranger).qr(unknown);
    expect(foreignQr.status).toBe(404);
    expect(withoutRequestId(foreignQr.body)).toEqual(withoutRequestId(unknownQr.body));

    const foreignList = await customerBaggageApi(stranger).list(subject.bookingReference);
    const unknownList = await customerBaggageApi(stranger).list('ETB-ZZZZZZZZZZZZ');
    expect(foreignList.status).toBe(404);
    expect(withoutRequestId(foreignList.body)).toEqual(withoutRequestId(unknownList.body));

    const registration = await customerBaggageApi(stranger).register(
      subject.bookingReference,
      subject.passengerReference,
    );
    const unknownRegistration = await customerBaggageApi(stranger).register(
      'ETB-ZZZZZZZZZZZZ',
      'ETV-ZZZZZZZZZZZZ',
    );
    expect(registration.status).toBe(404);
    expect(withoutRequestId(registration.body)).toEqual(withoutRequestId(unknownRegistration.body));
  });

  it('rejects CSRF bypass and all customer mass-assigned authority', async () => {
    const noCsrf = await customerBaggageApi(owner).register(
      subject.bookingReference,
      subject.passengerReference,
      { type: 'BOX' },
      { csrf: null },
    );
    expect(noCsrf.status).toBe(403);

    for (const injected of [
      { measuredWeightKg: '12.345' },
      { lifecycleStatus: 'DELIVERED' },
      { tripId: foreign.fixture.tripId },
      { customerIdentityId: stranger.id },
      { passengerId: foreign.passengerReference },
      { includedWeightKg: '20.000', excessChargeMinor: '1' },
    ]) {
      const response = await customerBaggageApi(owner).register(
        subject.bookingReference,
        subject.passengerReference,
        { type: 'TRAVEL_BAG', ...injected },
      );
      expect(response.status, JSON.stringify(injected)).toBe(400);
    }
  });

  it('rate-limits customer pre-registration per identity without a permanent lockout', async () => {
    const limited = await customerActor(t.app);
    const limitedSubject = await confirmedPassenger(t.app, env, limited);
    for (let index = 0; index < 30; index += 1) {
      const response = await customerBaggageApi(limited).register(
        limitedSubject.bookingReference,
        limitedSubject.passengerReference,
        { type: index % 2 === 0 ? 'SUITCASE' : 'OTHER' },
      );
      expect(response.status, `registration ${index + 1}: ${response.text}`).toBe(201);
    }
    const limitedResponse = await customerBaggageApi(limited).register(
      limitedSubject.bookingReference,
      limitedSubject.passengerReference,
    );
    expect(limitedResponse.status).toBe(429);
    expect(limitedResponse.headers['retry-after']).toBeDefined();
  });
});
