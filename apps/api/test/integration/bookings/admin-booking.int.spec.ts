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
import {
  bookableFixture,
  bookingApi,
  customerActor,
  expiredHold,
  holdBody,
  syntheticCountry,
  type CustomerActor,
} from '../../support/booking-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

const UNKNOWN_ID = '01900000-0000-7000-8000-000000000000';

/**
 * STAFF administration of holds (booking.read / booking.manage) and the trip
 * cancellation cascade. Own database (temporary failing audit triggers).
 */
describe('booking administration and trip cancellation (isolated database)', () => {
  let t: TestApp;
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let countryId: string;
  let agent: StaffActor;
  let admin: StaffActor;
  let customer: CustomerActor;

  beforeAll(async () => {
    database = await isolatedDatabase();
    t = await startTestApp(integrationEnv({ DATABASE_URL: database.url }));
    countryId = await syntheticCountry(t.app);
    [agent, admin, customer] = await Promise.all([
      staffActor(t.app, ['BOOKING_AGENT']),
      staffActor(t.app, ['SUPER_ADMIN']),
      customerActor(t.app),
    ]);
  });

  afterAll(async () => {
    await t.app.close();
    await database.drop();
  });

  const fixture = () => bookableFixture(t.app, { countryId });
  const hold = async (seats: string[], origin = 1, destination = 3) => {
    const f = await fixture();
    const response = await bookingApi(customer).post(
      '/bookings',
      holdBody(f, origin, destination, seats),
    );
    const booking = await db(t.app).booking.findUniqueOrThrow({
      where: { reference: response.body.reference },
    });
    return { f, booking };
  };

  describe('permissions', () => {
    it('booking.read reads, booking.manage cancels; other roles get 403', async () => {
      const { booking } = await hold(['1A']);
      // Each role's read access is checked by the RBAC matrix test; here the
      // actors are created in parallel (Argon2 + TOTP enrollment each).
      const deniedRoles = ['DISPATCHER', 'FINANCE', 'AUDITOR', 'COMPLIANCE_AGENT'];
      const [support, ...deniedActors] = await Promise.all(
        ['CUSTOMER_SUPPORT', ...deniedRoles].map((role) => staffActor(t.app, [role])),
      );
      expect((await adminApi(support!).get('/bookings')).status).toBe(200);
      expect((await adminApi(support!).get(`/bookings/${booking.id}`)).status).toBe(200);
      for (const [index, actor] of deniedActors.entries()) {
        const role = deniedRoles[index]!;
        const api = adminApi(actor);
        const response = await api.get('/bookings');
        expect(response.status, role).toBe(403);
        expect(response.body.code).toBe('FORBIDDEN');
        expect((await api.get(`/bookings/${booking.id}`)).status, role).toBe(403);
        expect(
          (await api.post(`/bookings/${booking.id}/cancel`, { reason: 'Interdit' })).status,
          role,
        ).toBe(403);
      }
      const readOnly = adminApi(
        await staffActor(t.app, [await createTestRole(t.app, ['ops.access', 'booking.read'])]),
      );
      expect((await readOnly.get(`/bookings/${booking.id}`)).status).toBe(200);
      const denied = await readOnly.post(`/bookings/${booking.id}/cancel`, {
        reason: 'Lecture seule',
      });
      expect(denied.status).toBe(403);
      expect(
        (
          await adminApi(agent).post(
            `/bookings/${booking.id}/cancel`,
            { reason: 'Sans CSRF' },
            { csrf: null },
          )
        ).status,
      ).toBe(403);
      expect(
        (await db(t.app).booking.findUniqueOrThrow({ where: { id: booking.id } })).cancelledAt,
      ).toBeNull();
      // A customer session cannot reach the STAFF API: refused by origin,
      // and without an origin the customer cookie is not a STAFF session.
      const fromClient = await customer.http.get('/v1/admin/bookings', customer.cookie);
      expect(fromClient.status).toBe(403);
      expect(fromClient.body.code).toBe('ORIGIN_NOT_ALLOWED');
      const noOrigin = await request(t.app.getHttpServer())
        .get('/v1/admin/bookings')
        .set('Cookie', customer.cookie);
      expect(noOrigin.status).toBe(401);
    });
  });

  describe('reads', () => {
    it('lists with derived status, trip and reference filters, keyset pages; never the customer email', async () => {
      const { f, booking } = await hold(['1A', '1B']);
      const expired = await expiredHold(t.app, f, customer.id, 3, 5, ['2A']);
      const cancelled = await bookingApi(customer).post('/bookings', holdBody(f, 3, 5, ['2B']));
      await bookingApi(customer).post(`/bookings/${cancelled.body.reference}/cancel`, {});
      const api = adminApi(agent);
      const byTrip = await api.get(`/bookings?tripId=${f.tripId}`);
      expect(
        (byTrip.body.items as Array<{ reference: string; status: string }>)
          .map((item) => [item.reference, item.status])
          .sort(),
      ).toEqual(
        [
          [booking.reference, 'HELD'],
          [expired.reference, 'EXPIRED'],
          [cancelled.body.reference, 'CANCELLED'],
        ].sort(),
      );
      for (const status of ['HELD', 'EXPIRED', 'CANCELLED']) {
        const filtered = await api.get(`/bookings?tripId=${f.tripId}&status=${status}`);
        expect(
          filtered.body.items.map((item: { status: string }) => item.status),
          status,
        ).toEqual([status]);
      }
      const byReference = await api.get(`/bookings?reference=${booking.reference.toLowerCase()}`);
      expect(byReference.body.items).toHaveLength(1);
      const detail = await api.get(`/bookings/${booking.id}`);
      expect(detail.body).toMatchObject({
        id: booking.id,
        reference: booking.reference,
        status: 'HELD',
        customerIdentityId: customer.id,
        tripStatus: 'SCHEDULED',
        seatCount: 2,
        totalAmountMinor: 4000,
      });
      expect(JSON.stringify(byTrip.body) + JSON.stringify(detail.body)).not.toContain(
        customer.email,
      );
      const first = await api.get(`/bookings?tripId=${f.tripId}&limit=1`);
      expect(first.body.nextCursor).toBe(first.body.items[0].id);
      const second = await api.get(
        `/bookings?tripId=${f.tripId}&limit=1&cursor=${first.body.nextCursor}`,
      );
      expect(second.body.items[0].id < first.body.items[0].id).toBe(true);
      expect((await api.get(`/bookings/${UNKNOWN_ID}`)).status).toBe(404);
      expect((await api.get('/bookings?status=PAID')).status).toBe(400);
    });
  });

  describe('staff cancellation', () => {
    it('cancels an active hold with a mandatory reason, audited by the staff member', async () => {
      const { f, booking } = await hold(['1A']);
      const api = adminApi(agent);
      expect((await api.post(`/bookings/${booking.id}/cancel`, {})).status).toBe(400);
      expect((await api.post(`/bookings/${booking.id}/cancel`, { reason: ' ' })).status).toBe(400);
      const cancelled = await api.post(`/bookings/${booking.id}/cancel`, {
        reason: 'Demande du client au guichet',
      });
      expect(cancelled.status).toBe(200);
      expect(cancelled.body).toMatchObject({
        status: 'CANCELLED',
        cancellationReason: 'Demande du client au guichet',
      });
      expect(await db(t.app).seatInventoryLock.count({ where: { tripId: f.tripId } })).toBe(0);
      const audit = await db(t.app).auditEvent.findFirstOrThrow({
        where: { resourceId: booking.id, action: 'BOOKING_CANCELLED' },
      });
      expect(audit).toMatchObject({ actorIdentityId: agent.id, actorRealm: 'STAFF' });
      expect(audit.metadata).toMatchObject({
        reason: 'Demande du client au guichet',
        cancelledBy: 'STAFF',
      });
      const again = await api.post(`/bookings/${booking.id}/cancel`, { reason: 'Encore' });
      expect(again.body.code).toBe('BOOKING_CANCELLED');
      const expired = await expiredHold(t.app, f, customer.id, 1, 2, ['2B']);
      const late = await api.post(`/bookings/${expired.id}/cancel`, { reason: 'Trop tard' });
      expect(late.status).toBe(409);
      expect(late.body.code).toBe('BOOKING_EXPIRED');
      expect(
        (await api.post(`/bookings/${UNKNOWN_ID}/cancel`, { reason: 'Inconnue' })).status,
      ).toBe(404);
    });

    it('rolls back a staff cancellation when its audit insert fails', async () => {
      const { booking } = await hold(['1A']);
      await db(t.app).$executeRawUnsafe(`
        CREATE FUNCTION test_fail_staff_cancel_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.action = 'BOOKING_CANCELLED' THEN RAISE EXCEPTION 'simulated audit failure'; END IF;
          RETURN NEW;
        END; $$`);
      await db(t.app).$executeRawUnsafe(
        'CREATE TRIGGER test_fail_staff_cancel_audit BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION test_fail_staff_cancel_audit()',
      );
      try {
        expect(
          (await adminApi(agent).post(`/bookings/${booking.id}/cancel`, { reason: 'Échec audit' }))
            .status,
        ).toBe(500);
        const stored = await db(t.app).booking.findUniqueOrThrow({
          where: { id: booking.id },
          include: { seats: { include: { locks: true } } },
        });
        expect(stored.cancelledAt).toBeNull();
        expect(stored.seats[0]!.locks).toHaveLength(2);
      } finally {
        await db(t.app).$executeRawUnsafe(
          'DROP TRIGGER test_fail_staff_cancel_audit ON audit_event',
        );
        await db(t.app).$executeRawUnsafe('DROP FUNCTION test_fail_staff_cancel_audit()');
      }
    });
  });

  describe('trip cancellation', () => {
    it('cancels every active hold of the trip atomically, audited per booking by the staff member', async () => {
      const f = await fixture();
      const first = await bookingApi(customer).post('/bookings', holdBody(f, 1, 3, ['1A', '1B']));
      const other = await customerActor(t.app);
      const second = await bookingApi(other).post('/bookings', holdBody(f, 3, 5, ['1A']));
      const expired = await expiredHold(t.app, f, customer.id, 1, 5, ['2A']);
      const gone = await bookingApi(customer).post('/bookings', holdBody(f, 1, 2, ['2B']));
      await bookingApi(customer).post(`/bookings/${gone.body.reference}/cancel`, {});

      const cancelled = await adminApi(admin).post(`/trips/${f.tripId}/cancel`, {
        reason: 'Panne majeure',
      });
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.status).toBe('CANCELLED');
      const bookings = await db(t.app).booking.findMany({
        where: { tripId: f.tripId },
        include: { seats: true },
      });
      const byReference = new Map(bookings.map((booking) => [booking.reference, booking]));
      for (const reference of [first.body.reference, second.body.reference]) {
        const booking = byReference.get(reference)!;
        expect(booking.cancellationReason).toBe('Voyage annulé : Panne majeure');
        expect(booking.seats.every((seat) => seat.releasedAt !== null)).toBe(true);
      }
      const stale = byReference.get(expired.reference)!;
      expect(stale.cancelledAt).toBeNull(); // still EXPIRED, never "cancelled by trip"
      expect(stale.seats[0]!.releasedAt?.toISOString()).toBe(stale.holdExpiresAt.toISOString());
      expect(await db(t.app).seatInventoryLock.count({ where: { tripId: f.tripId } })).toBe(0);
      const audits = await db(t.app).auditEvent.findMany({
        where: {
          action: 'BOOKING_CANCELLED_BY_TRIP',
          resourceId: { in: bookings.map((booking) => booking.id) },
        },
      });
      expect(audits).toHaveLength(2);
      for (const audit of audits) {
        expect(audit).toMatchObject({ actorIdentityId: admin.id, actorRealm: 'STAFF' });
        expect(audit.metadata).toMatchObject({ tripId: f.tripId, tripReference: f.tripReference });
      }
      const tripAudit = await db(t.app).auditEvent.findFirstOrThrow({
        where: { resourceId: f.tripId, action: 'TRIP_CANCELLED' },
      });
      expect(tripAudit.metadata).toMatchObject({
        reason: 'Panne majeure',
        cancelledBookingCount: 2,
      });
      expect(
        (await bookingApi(customer).get(`/bookings/${first.body.reference}`)).body.status,
      ).toBe('CANCELLED');
    });

    it('rolls the trip cancellation and the booking cancellations back together when an audit fails', async () => {
      for (const failing of ['BOOKING_CANCELLED_BY_TRIP', 'TRIP_CANCELLED']) {
        const { f, booking } = await hold(['1A']);
        await db(t.app).$executeRawUnsafe(`
          CREATE FUNCTION test_fail_trip_cancel_audit() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW.action = '${failing}' THEN RAISE EXCEPTION 'simulated audit failure'; END IF;
            RETURN NEW;
          END; $$`);
        await db(t.app).$executeRawUnsafe(
          'CREATE TRIGGER test_fail_trip_cancel_audit BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION test_fail_trip_cancel_audit()',
        );
        try {
          expect(
            (await adminApi(admin).post(`/trips/${f.tripId}/cancel`, { reason: 'Échec audit' }))
              .status,
            failing,
          ).toBe(500);
          expect(
            (await db(t.app).trip.findUniqueOrThrow({ where: { id: f.tripId } })).status,
            failing,
          ).toBe('SCHEDULED');
          const stored = await db(t.app).booking.findUniqueOrThrow({
            where: { id: booking.id },
            include: { seats: { include: { locks: true } } },
          });
          expect(stored.cancelledAt, failing).toBeNull();
          expect(stored.seats[0]!.locks, failing).toHaveLength(2);
        } finally {
          await db(t.app).$executeRawUnsafe(
            'DROP TRIGGER test_fail_trip_cancel_audit ON audit_event',
          );
          await db(t.app).$executeRawUnsafe('DROP FUNCTION test_fail_trip_cancel_audit()');
        }
      }
    });

    it('leaves trips without bookings and DRAFT trips cancellable as before (PR-06)', async () => {
      const f = await fixture();
      const scheduled = await adminApi(admin).post(`/trips/${f.tripId}/cancel`, {
        reason: 'Sans réservation',
      });
      expect(scheduled.status).toBe(200);
      const draft = await bookableFixture(t.app, { countryId, status: 'DRAFT' });
      expect(
        (await adminApi(admin).post(`/trips/${draft.tripId}/cancel`, { reason: 'Brouillon' }))
          .status,
      ).toBe(200);
      const audit = await db(t.app).auditEvent.findFirstOrThrow({
        where: { resourceId: draft.tripId, action: 'TRIP_CANCELLED' },
      });
      expect(audit.metadata).toMatchObject({ cancelledBookingCount: 0 });
    });
  });
});
