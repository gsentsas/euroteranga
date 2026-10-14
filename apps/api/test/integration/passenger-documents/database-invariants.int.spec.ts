import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApiEnv } from '@euroteranga/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  generateDocumentObjectKey,
  generateDocumentReference,
  generatePassengerReference,
} from '../../../src/passenger-documents/passenger-document-rules.js';
import { isolatedDatabase } from '../../support/admin-helpers.js';
import { createIdentity, db } from '../../support/auth-helpers.js';
import {
  bookableFixture,
  bookingApi,
  customerActor,
  holdBody,
  type CustomerActor,
} from '../../support/booking-helpers.js';
import { confirmedBooking } from '../../support/passenger-document-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

describe('passenger-document PostgreSQL invariants (isolated database)', () => {
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let t: TestApp;
  let env: ApiEnv;
  let storageRoot: string;
  let owner: CustomerActor;
  let countryId: string;
  let confirmedReference: string;

  beforeAll(async () => {
    database = await isolatedDatabase();
    storageRoot = await mkdtemp(join(tmpdir(), 'et-passenger-db-'));
    env = integrationEnv({ DATABASE_URL: database.url, OBJECT_STORAGE_LOCAL_ROOT: storageRoot });
    t = await startTestApp(env);
    owner = await customerActor(t.app);
    const confirmed = await confirmedBooking(t.app, env, owner, ['1A', '1B']);
    countryId = confirmed.fixture.countryId;
    confirmedReference = confirmed.reference;
  });

  afterAll(async () => {
    await t.app.close();
    await database.drop();
    await rm(storageRoot, { recursive: true, force: true });
  });

  async function passenger(ownerCustomerIdentityId = owner.id, givenName = 'Awa') {
    return db(t.app).passenger.create({
      data: {
        reference: generatePassengerReference(),
        ownerCustomerIdentityId,
        givenName,
        familyName: 'Ndiaye',
        dateOfBirth: new Date('1990-05-12T00:00:00.000Z'),
        nationalityCountryId: countryId,
      },
    });
  }

  const documentData = (passengerId: string) => ({
    reference: generateDocumentReference(),
    passengerId,
    type: 'PASSPORT' as const,
    objectKey: generateDocumentObjectKey(),
    sha256: 'ab'.repeat(32),
    mimeType: 'application/pdf',
    sizeBytes: 10n,
  });

  it('requires an ACTIVE CUSTOMER owner, a real nationality and valid immutable identity data', async () => {
    const created = await passenger();
    expect(created.id.split('-')[2]?.startsWith('7')).toBe(true);
    const staff = await createIdentity(t.app, { realm: 'staff' });
    await expect(passenger(staff.id)).rejects.toThrow(/ACTIVE CUSTOMER/);
    const suspended = await createIdentity(t.app, { realm: 'customer', status: 'SUSPENDED' });
    await expect(passenger(suspended.id)).rejects.toThrow(/ACTIVE CUSTOMER/);
    await expect(
      db(t.app).passenger.create({
        data: {
          reference: generatePassengerReference(),
          ownerCustomerIdentityId: owner.id,
          givenName: 'Future',
          familyName: 'Passenger',
          dateOfBirth: new Date('2999-01-01T00:00:00.000Z'),
          nationalityCountryId: countryId,
        },
      }),
    ).rejects.toThrow(/date of birth cannot be in the future/);
    await expect(
      db(t.app).passenger.update({
        where: { id: created.id },
        data: { ownerCustomerIdentityId: suspended.id },
      }),
    ).rejects.toThrow(/immutable/);
    await expect(db(t.app).passenger.delete({ where: { id: created.id } })).rejects.toThrow(
      /cannot be deleted/,
    );
    await expect(
      db(t.app).passenger.create({
        data: {
          reference: created.reference,
          ownerCustomerIdentityId: owner.id,
          givenName: 'Same',
          familyName: 'Reference',
          dateOfBirth: new Date('1990-05-12T00:00:00.000Z'),
          nationalityCountryId: countryId,
        },
      }),
    ).rejects.toThrow(/Unique constraint/);
  });

  it('only links same-owner passengers to confirmed bookings and never beyond seats', async () => {
    const booking = await db(t.app).booking.findUniqueOrThrow({
      where: { reference: confirmedReference },
    });
    const first = await passenger();
    const second = await passenger();
    const third = await passenger();
    await db(t.app).bookingPassenger.create({
      data: { bookingId: booking.id, passengerId: first.id },
    });
    await db(t.app).bookingPassenger.create({
      data: { bookingId: booking.id, passengerId: second.id },
    });
    await expect(
      db(t.app).bookingPassenger.create({
        data: { bookingId: booking.id, passengerId: third.id },
      }),
    ).rejects.toThrow(/more passengers than seats/);

    const foreign = await customerActor(t.app);
    const foreignPassenger = await passenger(foreign.id, 'Foreign');
    const otherConfirmed = await confirmedBooking(t.app, env, owner);
    const otherBooking = await db(t.app).booking.findUniqueOrThrow({
      where: { reference: otherConfirmed.reference },
    });
    await expect(
      db(t.app).bookingPassenger.create({
        data: { bookingId: otherBooking.id, passengerId: foreignPassenger.id },
      }),
    ).rejects.toThrow(/same CUSTOMER owner/);

    const fixture = await bookableFixture(t.app, { countryId });
    const held = await bookingApi(owner).post('/bookings', holdBody(fixture, 1, 2, ['1A']));
    const heldBooking = await db(t.app).booking.findUniqueOrThrow({
      where: { reference: held.body.reference as string },
    });
    await expect(
      db(t.app).bookingPassenger.create({
        data: { bookingId: heldBooking.id, passengerId: third.id },
      }),
    ).rejects.toThrow(/only be attached to a confirmed booking/);
    await expect(
      db(t.app).bookingPassenger.delete({
        where: { bookingId_passengerId: { bookingId: booking.id, passengerId: first.id } },
      }),
    ).rejects.toThrow(/cannot be changed or deleted/);
  });

  it('serializes two real concurrent claims for the final passenger slot', async () => {
    const confirmed = await confirmedBooking(t.app, env, owner, ['1A', '1B']);
    const booking = await db(t.app).booking.findUniqueOrThrow({
      where: { reference: confirmed.reference },
    });
    const already = await passenger();
    await db(t.app).bookingPassenger.create({
      data: { bookingId: booking.id, passengerId: already.id },
    });
    const candidates = await Promise.all([passenger(), passenger()]);
    const outcomes = await Promise.allSettled(
      candidates.map((candidate) =>
        db(t.app).bookingPassenger.create({
          data: { bookingId: booking.id, passengerId: candidate.id },
        }),
      ),
    );
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    expect(await db(t.app).bookingPassenger.count({ where: { bookingId: booking.id } })).toBe(2);
  });

  it('makes a second claim for the final slot wait for the first, then refuses it', async () => {
    // Forced overlap: the first claim inserts and stays uncommitted; the
    // second must queue on the booking row lock (seen in pg_stat_activity),
    // then recount once the first commits. Without that lock it would count
    // the committed state, succeed, and leave N+1 passengers.
    const confirmed = await confirmedBooking(t.app, env, owner, ['1A', '1B']);
    const booking = await db(t.app).booking.findUniqueOrThrow({
      where: { reference: confirmed.reference },
    });
    const already = await passenger();
    await db(t.app).bookingPassenger.create({
      data: { bookingId: booking.id, passengerId: already.id },
    });
    const [first, second] = await Promise.all([passenger(), passenger()]);
    const lockWaiters = async () => {
      const [row] = await db(t.app).$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*) AS count FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      return Number(row!.count);
    };

    let commit!: () => void;
    const committed = new Promise<void>((resolve) => (commit = resolve));
    let inserted!: () => void;
    const firstInserted = new Promise<void>((resolve) => (inserted = resolve));
    const firstClaim = db(t.app).$transaction(
      async (tx) => {
        await tx.bookingPassenger.create({
          data: { bookingId: booking.id, passengerId: first.id },
        });
        inserted();
        await committed;
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    await firstInserted;
    let settled = false;
    const secondClaim = db(t.app)
      .bookingPassenger.create({ data: { bookingId: booking.id, passengerId: second.id } })
      .then(
        () => 'created' as const,
        (error: unknown) => error,
      )
      .finally(() => {
        settled = true;
      });
    for (let attempt = 0; attempt < 400 && !settled && (await lockWaiters()) < 1; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(settled, 'the second claim must wait for the first, not decide alone').toBe(false);
    expect(await lockWaiters()).toBeGreaterThanOrEqual(1);
    commit();
    await firstClaim;
    const outcome = await secondClaim;
    expect(outcome).not.toBe('created');
    expect(String(outcome)).toMatch(/more passengers than seats/);
    expect(await db(t.app).bookingPassenger.count({ where: { bookingId: booking.id } })).toBe(2);
  });

  it('enforces document formats, uniqueness, positive size and supported MIME in PostgreSQL', async () => {
    const person = await passenger();
    const valid = await db(t.app).passengerDocument.create({ data: documentData(person.id) });
    expect(valid.id.split('-')[2]?.startsWith('7')).toBe(true);
    await expect(
      db(t.app).passengerDocument.create({
        data: { ...documentData(person.id), reference: valid.reference },
      }),
    ).rejects.toThrow();
    await expect(
      db(t.app).passengerDocument.create({
        data: { ...documentData(person.id), objectKey: valid.objectKey },
      }),
    ).rejects.toThrow();
    for (const change of [
      { reference: 'ETD-invalid' },
      { objectKey: '../passport.pdf' },
      { sha256: 'abc' },
      { sizeBytes: 0n },
      { mimeType: 'text/html' },
    ]) {
      await expect(
        db(t.app).passengerDocument.create({
          data: { ...documentData(person.id), ...change },
        }),
        Object.keys(change).join(','),
      ).rejects.toThrow();
    }
    const columns = await db(t.app).$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'passenger_document'
      ORDER BY column_name`;
    expect(columns.map((row) => row.column_name)).not.toEqual(
      expect.arrayContaining(['bytes', 'body', 'original_filename', 'document_number']),
    );
  });

  it('allows exactly one coherent QUARANTINED transition and keeps metadata historical', async () => {
    const person = await passenger();
    await expect(
      db(t.app).passengerDocument.create({
        data: {
          ...documentData(person.id),
          status: 'ACCEPTED',
          acceptedAt: new Date(),
        },
      }),
    ).rejects.toThrow(/must be created quarantined/);

    const accepted = await db(t.app).passengerDocument.create({ data: documentData(person.id) });
    // Every file-identity field is frozen from creation, while still QUARANTINED.
    const other = await passenger();
    for (const change of [
      { objectKey: generateDocumentObjectKey() },
      { sha256: 'cd'.repeat(32) },
      { sizeBytes: 11n },
      { mimeType: 'image/png' },
      { type: 'VISA' as const },
      { reference: generateDocumentReference() },
      { passengerId: other.id },
    ]) {
      await expect(
        db(t.app).passengerDocument.update({ where: { id: accepted.id }, data: change }),
        Object.keys(change).join(','),
      ).rejects.toThrow(/metadata are immutable/);
    }
    await expect(
      db(t.app).passengerDocument.update({
        where: { id: accepted.id },
        data: { status: 'ACCEPTED' },
      }),
    ).rejects.toThrow(/status_consistent|violates check constraint/);
    await db(t.app).passengerDocument.update({
      where: { id: accepted.id },
      data: { status: 'ACCEPTED', acceptedAt: new Date() },
    });
    await expect(
      db(t.app).passengerDocument.update({
        where: { id: accepted.id },
        data: {
          status: 'REJECTED',
          acceptedAt: null,
          rejectedAt: new Date(),
          failureCode: 'SCANNER_ERROR',
        },
      }),
    ).rejects.toThrow(/invalid passenger document status transition/);

    const rejected = await db(t.app).passengerDocument.create({ data: documentData(person.id) });
    await expect(
      db(t.app).passengerDocument.update({
        where: { id: rejected.id },
        data: { status: 'REJECTED', rejectedAt: new Date() },
      }),
    ).rejects.toThrow(/status_consistent|violates check constraint/);
    await db(t.app).passengerDocument.update({
      where: { id: rejected.id },
      data: {
        status: 'REJECTED',
        rejectedAt: new Date(),
        failureCode: 'SCANNER_ERROR',
      },
    });
    await expect(
      db(t.app).passengerDocument.update({
        where: { id: rejected.id },
        data: { sha256: 'cd'.repeat(32) },
      }),
    ).rejects.toThrow(/metadata are immutable/);
    await expect(
      db(t.app).passengerDocument.delete({ where: { id: rejected.id } }),
    ).rejects.toThrow(/cannot be deleted/);
    await expect(
      db(t.app).$executeRawUnsafe('TRUNCATE TABLE "passenger_document"'),
    ).rejects.toThrow(/cannot be truncated/);
  });
});
