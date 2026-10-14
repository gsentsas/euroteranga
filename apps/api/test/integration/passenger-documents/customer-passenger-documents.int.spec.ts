import { createHash } from 'node:crypto';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApiEnv } from '@euroteranga/config';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  MALWARE_SCANNER,
  MalwareScannerError,
  TestMalwareScanner,
  type MalwareScanner,
} from '../../../src/passenger-documents/malware/malware-scanner.js';
import {
  generateDocumentObjectKey,
  generateDocumentReference,
} from '../../../src/passenger-documents/passenger-document-rules.js';
import { client, db } from '../../support/auth-helpers.js';
import {
  bookableFixture,
  bookingApi,
  customerActor,
  holdBody,
  syntheticCountry,
  type CustomerActor,
} from '../../support/booking-helpers.js';
import {
  confirmedBooking,
  createPassenger,
  SYNTHETIC_PDF,
  uploadDocument,
} from '../../support/passenger-document-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

const PASSENGER = /^ETV-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/;
const DOCUMENT = /^ETD-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/;

async function binary(response: request.Response): Promise<Buffer> {
  if (Buffer.isBuffer(response.body)) return response.body;
  return Buffer.from(response.text, 'binary');
}

describe('customer passengers and private documents', () => {
  let t: TestApp;
  let env: ApiEnv;
  let storageRoot: string;
  let alice: CustomerActor;
  let bob: CustomerActor;
  let nationalityCountryId: string;
  let bookingReference: string;
  let passengerReference: string;
  let acceptedDocumentReference: string;

  beforeAll(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'et-passenger-http-'));
    env = integrationEnv({ OBJECT_STORAGE_LOCAL_ROOT: storageRoot });
    t = await startTestApp(env);
    [alice, bob] = await Promise.all([customerActor(t.app), customerActor(t.app)]);
    nationalityCountryId = await syntheticCountry(t.app);
    bookingReference = (await confirmedBooking(t.app, env, alice, ['1A', '1B', '2A'])).reference;
  });

  afterEach(() => vi.restoreAllMocks());

  afterAll(async () => {
    await t.app.close();
    await rm(storageRoot, { recursive: true, force: true });
  });

  it('keeps the CUSTOMER/booker distinct from normalized passengers on confirmed bookings', async () => {
    const countries = await bookingApi(alice).get('/passenger-countries');
    expect(countries.status).toBe(200);
    expect(countries.headers['cache-control']).toBe('no-store');
    expect(countries.body.items).toContainEqual(
      expect.objectContaining({ id: nationalityCountryId, name: 'Pays réservation' }),
    );

    const created = await createPassenger(alice, bookingReference, nationalityCountryId, {
      givenName: '  Awa   Marie ',
      familyName: ' Ndiaye ',
    });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({
      reference: expect.stringMatching(PASSENGER),
      givenName: 'Awa Marie',
      familyName: 'Ndiaye',
      dateOfBirth: '1990-05-12',
      nationality: expect.objectContaining({ name: 'Pays réservation' }),
      bookingReferences: [bookingReference],
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    passengerReference = created.body.reference as string;
    expect(created.body).not.toHaveProperty('id');
    expect(created.body).not.toHaveProperty('ownerCustomerIdentityId');

    const stored = await db(t.app).passenger.findUniqueOrThrow({
      where: { reference: passengerReference },
      include: { bookings: true },
    });
    expect(stored.ownerCustomerIdentityId).toBe(alice.id);
    expect(stored.id).not.toBe(alice.id);
    expect(stored.bookings).toHaveLength(1);
    expect(
      await db(t.app).auditEvent.count({
        where: {
          actorIdentityId: alice.id,
          action: { in: ['PASSENGER_CREATED', 'BOOKING_PASSENGER_ATTACHED'] },
          resourceId: { in: [stored.id, stored.bookings[0]!.bookingId] },
        },
      }),
    ).toBe(2);

    const list = await bookingApi(alice).get(`/bookings/${bookingReference}/passengers`);
    expect(list.body.items).toEqual([created.body]);
    expect((await bookingApi(bob).get(`/bookings/${bookingReference}/passengers`)).status).toBe(
      404,
    );
    expect((await bookingApi(bob).get(`/passengers/${passengerReference}`)).status).toBe(404);

    const heldFixture = await bookableFixture(t.app);
    const held = await bookingApi(alice).post('/bookings', holdBody(heldFixture, 1, 2, ['1A']));
    const heldPassenger = await createPassenger(
      alice,
      held.body.reference as string,
      nationalityCountryId,
    );
    expect(heldPassenger.status).toBe(409);
    expect(heldPassenger.body.code).toBe('PASSENGER_BOOKING_NOT_CONFIRMED');
  });

  it('never exceeds booked-seat capacity', async () => {
    expect((await createPassenger(alice, bookingReference, nationalityCountryId)).status).toBe(201);
    expect(
      (
        await createPassenger(alice, bookingReference, nationalityCountryId, {
          givenName: 'Fatou',
        })
      ).status,
    ).toBe(201);
    const over = await createPassenger(alice, bookingReference, nationalityCountryId, {
      givenName: 'Personne en trop',
    });
    expect(over.status).toBe(409);
    expect(over.body.code).toBe('PASSENGER_BOOKING_CAPACITY_REACHED');
    expect(
      await db(t.app).bookingPassenger.count({
        where: { booking: { reference: bookingReference } },
      }),
    ).toBe(3);
  });

  it('requires a valid CSRF token for multipart and accepts only after private scan', async () => {
    const missing = await uploadDocument(t.app, alice, passengerReference, { csrf: null });
    expect(missing.status).toBe(403);
    expect(missing.body.code).toBe('CSRF_TOKEN_INVALID');
    const invalid = await uploadDocument(t.app, alice, passengerReference, {
      csrf: 'synthetic-invalid-token',
    });
    expect(invalid.status).toBe(403);
    expect(invalid.body.code).toBe('CSRF_TOKEN_INVALID');
    expect(
      await db(t.app).passengerDocument.count({
        where: { passenger: { reference: passengerReference } },
      }),
    ).toBe(0);

    const uploaded = await uploadDocument(t.app, alice, passengerReference, {
      expiresAt: '2032-05-09',
    });
    expect(uploaded.status).toBe(201);
    expect(uploaded.headers['cache-control']).toBe('no-store');
    expect(uploaded.body).toMatchObject({
      reference: expect.stringMatching(DOCUMENT),
      passenger: { reference: passengerReference, givenName: 'Awa Marie', familyName: 'Ndiaye' },
      bookingReferences: [bookingReference],
      type: 'PASSPORT',
      mimeType: 'application/pdf',
      sizeBytes: SYNTHETIC_PDF.length,
      status: 'ACCEPTED',
      expiresAt: '2032-05-09',
      acceptedAt: expect.any(String),
      rejectedAt: null,
    });
    acceptedDocumentReference = uploaded.body.reference as string;
    const serialized = JSON.stringify(uploaded.body);
    expect(serialized).not.toMatch(
      /objectKey|sha256|bucket|scanner|failureCode|document\.pdf|customerIdentityId|"id"/i,
    );

    const stored = await db(t.app).passengerDocument.findUniqueOrThrow({
      where: { reference: acceptedDocumentReference },
    });
    expect(stored.sha256).toBe(createHash('sha256').update(SYNTHETIC_PDF).digest('hex'));
    expect(stored.objectKey).toMatch(/^passenger-documents\/[0-9a-f]{2}\/[0-9a-f]{64}$/);
    expect((await lstat(join(storageRoot, stored.objectKey))).isFile()).toBe(true);
    expect(
      await db(t.app).auditEvent.count({
        where: {
          resourceId: stored.id,
          action: { in: ['PASSENGER_DOCUMENT_UPLOADED', 'PASSENGER_DOCUMENT_ACCEPTED'] },
        },
      }),
    ).toBe(2);
  });

  it('streams exact accepted bytes only to the owner, with hardened headers and an audit', async () => {
    const owner = await request(t.app.getHttpServer())
      .get(`/v1/booking/documents/${acceptedDocumentReference}/download`)
      .set('Origin', alice.http.origin)
      .set('X-Forwarded-For', alice.http.ip)
      .set('Cookie', alice.cookie);
    expect(owner.status).toBe(200);
    expect(await binary(owner)).toEqual(SYNTHETIC_PDF);
    expect(owner.headers['content-type']).toMatch(/^application\/pdf/);
    expect(owner.headers['content-disposition']).toBe(
      `attachment; filename="${acceptedDocumentReference}.pdf"`,
    );
    expect(owner.headers['cache-control']).toBe('private, no-store');
    expect(owner.headers['x-content-type-options']).toBe('nosniff');

    const foreign = await bookingApi(bob).get(`/documents/${acceptedDocumentReference}/download`);
    const unknown = await bookingApi(bob).get('/documents/ETD-000000000000/download');
    expect(foreign.status).toBe(404);
    expect(foreign.body.code).toBe('PASSENGER_DOCUMENT_NOT_FOUND');
    expect({ ...foreign.body, requestId: undefined }).toEqual({
      ...unknown.body,
      requestId: undefined,
    });
    expect(
      (
        await client(t.app, 'customer').get(
          `/v1/booking/documents/${acceptedDocumentReference}/download`,
        )
      ).status,
    ).toBe(401);

    const row = await db(t.app).passengerDocument.findUniqueOrThrow({
      where: { reference: acceptedDocumentReference },
    });
    const access = await db(t.app).auditEvent.findFirstOrThrow({
      where: {
        action: 'PASSENGER_DOCUMENT_ACCESSED',
        resourceId: row.id,
        actorIdentityId: alice.id,
      },
      orderBy: { id: 'desc' },
    });
    expect(access.metadata).toMatchObject({
      access: 'CONTENT',
      reference: acceptedDocumentReference,
    });
    expect(JSON.stringify(access)).not.toMatch(/%PDF|objectKey|sha256|cookie|csrf|token|secret/i);
  });

  it('keeps QUARANTINED and REJECTED objects inaccessible', async () => {
    const passenger = await db(t.app).passenger.findUniqueOrThrow({
      where: { reference: passengerReference },
    });
    const base = {
      passengerId: passenger.id,
      type: 'OTHER' as const,
      sha256: 'ab'.repeat(32),
      mimeType: 'application/pdf',
      sizeBytes: 1n,
    };
    const quarantined = await db(t.app).passengerDocument.create({
      data: {
        ...base,
        reference: generateDocumentReference(),
        objectKey: generateDocumentObjectKey(),
      },
    });
    const rejected = await db(t.app).passengerDocument.create({
      data: {
        ...base,
        reference: generateDocumentReference(),
        objectKey: generateDocumentObjectKey(),
      },
    });
    await db(t.app).passengerDocument.update({
      where: { id: rejected.id },
      data: {
        status: 'REJECTED',
        rejectedAt: new Date(),
        failureCode: 'SCANNER_UNAVAILABLE',
      },
    });
    for (const reference of [quarantined.reference, rejected.reference]) {
      const response = await bookingApi(alice).get(`/documents/${reference}/download`);
      expect(response.status, reference).toBe(404);
      expect(response.body.code).toBe('PASSENGER_DOCUMENT_NOT_FOUND');
    }
  });

  it('rejects synthetic malware and scanner failures without leaving accessible objects', async () => {
    const malware = await uploadDocument(t.app, alice, passengerReference, {
      bytes: Buffer.concat([SYNTHETIC_PDF, TestMalwareScanner.marker]),
      filename: 'safe-looking.pdf',
    });
    expect(malware.status).toBe(422);
    expect(malware.body.code).toBe('PASSENGER_DOCUMENT_MALWARE_REJECTED');
    const malwareRow = await db(t.app).passengerDocument.findFirstOrThrow({
      where: { passenger: { reference: passengerReference }, failureCode: 'MALWARE_DETECTED' },
      orderBy: { id: 'desc' },
    });

    const scanner = t.app.get<MalwareScanner>(MALWARE_SCANNER);
    vi.spyOn(scanner, 'scan').mockRejectedValueOnce(new MalwareScannerError('TIMEOUT'));
    const timeout = await uploadDocument(t.app, alice, passengerReference);
    expect(timeout.status).toBe(503);
    expect(timeout.body.code).toBe('PASSENGER_DOCUMENT_SCAN_UNAVAILABLE');
    const timeoutRow = await db(t.app).passengerDocument.findFirstOrThrow({
      where: { passenger: { reference: passengerReference }, failureCode: 'SCANNER_TIMEOUT' },
      orderBy: { id: 'desc' },
    });
    vi.spyOn(scanner, 'scan').mockRejectedValueOnce(new MalwareScannerError('UNAVAILABLE'));
    const unavailable = await uploadDocument(t.app, alice, passengerReference);
    expect(unavailable.status).toBe(503);
    const unavailableRow = await db(t.app).passengerDocument.findFirstOrThrow({
      where: { passenger: { reference: passengerReference }, failureCode: 'SCANNER_UNAVAILABLE' },
      orderBy: { id: 'desc' },
    });
    const rejected = [malwareRow, timeoutRow, unavailableRow];
    expect(rejected).toHaveLength(3);
    for (const document of rejected) {
      await expect(lstat(join(storageRoot, document.objectKey))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(
        (await bookingApi(alice).get(`/documents/${document.reference}/download`)).status,
      ).toBe(404);
    }
  });

  it('rate-limits repeated uploads by an opaque identity bucket', async () => {
    const abuser = await customerActor(t.app);
    const booking = await confirmedBooking(t.app, env, abuser);
    const passenger = await createPassenger(abuser, booking.reference, booking.fixture.countryId);
    expect(passenger.status).toBe(201);
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      const rejected = await uploadDocument(t.app, abuser, passenger.body.reference as string, {
        bytes: Buffer.from('not a pdf', 'ascii'),
      });
      expect(rejected.status, `attempt ${attempt}`).toBe(415);
      expect(rejected.body.code).toBe('PASSENGER_DOCUMENT_MEDIA_UNSUPPORTED');
    }
    const limited = await uploadDocument(t.app, abuser, passenger.body.reference as string, {
      bytes: Buffer.from('not a pdf', 'ascii'),
    });
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('TOO_MANY_REQUESTS');
    expect(JSON.stringify(limited.body)).not.toContain(abuser.id);
    const buckets = await db(t.app).authRateLimitBucket.findMany({
      where: { action: 'passenger-document-upload:identity' },
      orderBy: { count: 'desc' },
      take: 1,
    });
    expect(buckets[0]).toMatchObject({ action: 'passenger-document-upload:identity', count: 21 });
    expect(JSON.stringify(buckets[0])).not.toContain(abuser.id);
  });

  it('never logs file bytes, credentials, cookies or client filenames', () => {
    const raw = t.logs.raw.join('\n');
    expect(raw).not.toContain(SYNTHETIC_PDF.toString('ascii'));
    expect(raw).not.toContain('safe-looking.pdf');
    expect(raw).not.toContain(TestMalwareScanner.marker.toString('ascii'));
    expect(raw).not.toMatch(
      /et_customer_session=|x-csrf-token|object_storage_secret|authorization:/i,
    );
  });
});
