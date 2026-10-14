import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApiEnv } from '@euroteranga/config';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestMalwareScanner } from '../../../src/passenger-documents/malware/malware-scanner.js';
import { adminApi, staffActor, type StaffActor } from '../../support/admin-helpers.js';
import { db } from '../../support/auth-helpers.js';
import { customerActor, type CustomerActor } from '../../support/booking-helpers.js';
import {
  confirmedBooking,
  createPassenger,
  SYNTHETIC_PDF,
  uploadDocument,
} from '../../support/passenger-document-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

describe('staff passenger-document reads', () => {
  let t: TestApp;
  let env: ApiEnv;
  let storageRoot: string;
  let customer: CustomerActor;
  let reader: StaffActor;
  let denied: StaffActor;
  let bookingReference: string;
  let passengerReference: string;
  let documentReference: string;

  beforeAll(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'et-passenger-admin-'));
    env = integrationEnv({ OBJECT_STORAGE_LOCAL_ROOT: storageRoot });
    t = await startTestApp(env);
    [customer, reader, denied] = await Promise.all([
      customerActor(t.app),
      staffActor(t.app, ['COMPLIANCE_AGENT']),
      staffActor(t.app, ['BOOKING_AGENT']),
    ]);
    const booking = await confirmedBooking(t.app, env, customer);
    bookingReference = booking.reference;
    const passenger = await createPassenger(customer, booking.reference, booking.fixture.countryId);
    if (passenger.status !== 201) throw new Error(`passenger fixture failed: ${passenger.text}`);
    passengerReference = passenger.body.reference as string;
    const document = await uploadDocument(t.app, customer, passengerReference, {
      type: 'NATIONAL_ID',
    });
    if (document.status !== 201) throw new Error(`document fixture failed: ${document.text}`);
    documentReference = document.body.reference as string;
  });

  afterAll(async () => {
    await t.app.close();
    await rm(storageRoot, { recursive: true, force: true });
  });

  it('lists and filters minimized metadata for passenger.document.read', async () => {
    const response = await adminApi(reader).get(
      `/passenger-documents?type=NATIONAL_ID&status=ACCEPTED&bookingReference=${bookingReference}&passengerReference=${passengerReference}`,
    );
    expect(response.status).toBe(200);
    expect(response.body.items).toEqual([
      expect.objectContaining({
        reference: documentReference,
        passenger: expect.objectContaining({ reference: passengerReference }),
        bookingReferences: [bookingReference],
        type: 'NATIONAL_ID',
        status: 'ACCEPTED',
      }),
    ]);
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toMatch(
      /objectKey|sha256|bucket|secret|scanner|failureCode|customerIdentityId|"id"/i,
    );
    expect((await adminApi(reader).get('/passenger-documents?status=APPROVED')).status).toBe(400);
  });

  it('audits sensitive metadata and exact accepted-content reads', async () => {
    const detail = await adminApi(reader).get(`/passenger-documents/${documentReference}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ reference: documentReference, status: 'ACCEPTED' });

    const download = await request(t.app.getHttpServer())
      .get(`/v1/admin/passenger-documents/${documentReference}/download`)
      .set('Origin', reader.http.origin)
      .set('X-Forwarded-For', reader.ip)
      .set('Cookie', reader.cookie);
    expect(download.status).toBe(200);
    expect(
      Buffer.isBuffer(download.body) ? download.body : Buffer.from(download.text, 'binary'),
    ).toEqual(SYNTHETIC_PDF);
    expect(download.headers).toMatchObject({
      'cache-control': 'private, no-store',
      'content-type': expect.stringMatching(/^application\/pdf/),
      'content-disposition': `attachment; filename="${documentReference}.pdf"`,
      'x-content-type-options': 'nosniff',
    });

    const document = await db(t.app).passengerDocument.findUniqueOrThrow({
      where: { reference: documentReference },
    });
    const audits = await db(t.app).auditEvent.findMany({
      where: {
        action: 'PASSENGER_DOCUMENT_ACCESSED',
        resourceId: document.id,
        actorIdentityId: reader.id,
      },
      orderBy: { id: 'asc' },
    });
    expect(audits.map((audit) => audit.metadata)).toEqual([
      expect.objectContaining({ access: 'METADATA', reference: documentReference }),
      expect.objectContaining({ access: 'CONTENT', reference: documentReference }),
    ]);
    expect(JSON.stringify(audits)).not.toMatch(/%PDF|objectKey|sha256|cookie|token|secret/i);
  });

  it('enforces server-side permission even when an OPS URL is called directly', async () => {
    for (const path of [
      '/passenger-documents',
      `/passenger-documents/${documentReference}`,
      `/passenger-documents/${documentReference}/download`,
    ]) {
      expect((await adminApi(denied).get(path)).status, path).toBe(403);
    }
    expect(
      (
        await request(t.app.getHttpServer())
          .get(`/v1/admin/passenger-documents/${documentReference}`)
          .set('Origin', reader.http.origin)
      ).status,
    ).toBe(401);
  });

  it('shows rejected technical metadata but never its bytes and exposes no approval workflow', async () => {
    const rejectedUpload = await uploadDocument(t.app, customer, passengerReference, {
      bytes: Buffer.concat([SYNTHETIC_PDF, TestMalwareScanner.marker]),
    });
    expect(rejectedUpload.status).toBe(422);
    const rejected = await db(t.app).passengerDocument.findFirstOrThrow({
      where: {
        passenger: { reference: passengerReference },
        status: 'REJECTED',
        failureCode: 'MALWARE_DETECTED',
      },
      orderBy: { id: 'desc' },
    });
    const detail = await adminApi(reader).get(`/passenger-documents/${rejected.reference}`);
    expect(detail.body).toMatchObject({
      reference: rejected.reference,
      status: 'REJECTED',
    });
    expect(detail.body).not.toHaveProperty('failureCode');
    expect(
      (await adminApi(reader).get(`/passenger-documents/${rejected.reference}/download`)).status,
    ).toBe(404);
    for (const action of ['approve', 'validate', 'mark-valid', 'compliance']) {
      expect(
        (
          await adminApi(reader).post(`/passenger-documents/${documentReference}/${action}`, {
            status: 'APPROVED',
          })
        ).status,
        action,
      ).toBe(404);
    }
  });
});
