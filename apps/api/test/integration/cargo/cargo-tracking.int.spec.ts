import type { ApiEnv } from '@euroteranga/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isolatedDatabase, staffActor, type StaffActor } from '../../support/admin-helpers.js';
import { client, db } from '../../support/auth-helpers.js';
import { cargoCreateBody, cargoTripFixture, staffCargoApi } from '../../support/cargo-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

describe('CARGO-TRACK-1 QR scans and public freight tracking', () => {
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let t: TestApp;
  let env: ApiEnv;
  let manager: StaffActor;
  let reader: StaffActor;
  let denied: StaffActor;

  beforeAll(async () => {
    database = await isolatedDatabase();
    env = integrationEnv({ DATABASE_URL: database.url });
    t = await startTestApp(env);
    [manager, reader, denied] = await Promise.all([
      staffActor(t.app, ['OPS_MANAGER']),
      staffActor(t.app, ['CUSTOMER_SUPPORT']),
      staffActor(t.app, ['FINANCE']),
    ]);
  }, 60_000);

  afterAll(async () => {
    await t.app.close();
    await database.drop();
  });

  it('installs the public token table and immutable history guards', async () => {
    const tables = await db(t.app).$queryRaw<Array<{ name: string }>>`
      SELECT tablename AS name
      FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename = 'road_freight_public_token'
    `;
    expect(tables.map((row) => row.name)).toEqual(['road_freight_public_token']);

    const triggers = await db(t.app).$queryRaw<Array<{ name: string }>>`
      SELECT tgname AS name
      FROM pg_trigger
      WHERE NOT tgisinternal
        AND tgrelid = 'road_freight_public_token'::regclass
    `;
    expect(triggers.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        'road_freight_public_token_guard',
        'road_freight_public_token_no_truncate',
      ]),
    );
  });

  it('uses a versioned QR and reuses the serialized Cargo event engine', async () => {
    const created = await staffCargoApi(manager).create(cargoCreateBody());
    expect(created.status, created.text).toBe(201);
    const reference = created.body.reference as string;

    const qr = await staffCargoApi(manager).qr(reference);
    expect(qr.status, qr.text).toBe(200);
    expect(qr.body.reference).toBe(reference);
    expect(qr.body.svg).toContain('<svg');
    expect(qr.body.svg).not.toContain('Expéditeur Test');
    expect(qr.body.svg).not.toContain('Destinataire Test');

    const resolved = await staffCargoApi(reader).resolveQr(`ETC1:${reference}`);
    expect(resolved.status, resolved.text).toBe(201);
    expect(resolved.body.reference).toBe(reference);
    expect((await staffCargoApi(reader).resolveQr(reference)).status).toBe(404);
    expect((await staffCargoApi(reader).resolveQr(`ETC2:${reference}`)).status).toBe(404);

    const occurredAt = new Date().toISOString();
    const first = await staffCargoApi(manager).scan({
      qrPayload: `ETC1:${reference}`,
      type: 'BOOKED',
      occurredAt,
      clientEventId: 'cargo-scan-track-0001',
    });
    expect(first.status, first.text).toBe(201);
    expect(first.body.created).toBe(true);

    const replay = await staffCargoApi(manager).scan({
      qrPayload: `ETC1:${reference}`,
      type: 'BOOKED',
      occurredAt,
      clientEventId: 'cargo-scan-track-0001',
    });
    expect(replay.status, replay.text).toBe(201);
    expect(replay.body.created).toBe(false);

    const invalid = await staffCargoApi(manager).scan({
      qrPayload: `ETC1:${reference}`,
      type: 'BOOKED',
    });
    expect(invalid.status).toBe(409);
    expect(invalid.body.code).toBe('CARGO_INVALID_TRANSITION');

    expect(
      (await staffCargoApi(manager).scan({ qrPayload: reference, type: 'RECEIVED' })).status,
    ).toBe(404);
    expect(
      (
        await staffCargoApi(manager).scan(
          { qrPayload: `ETC1:${reference}`, type: 'RECEIVED' },
          { csrf: null },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await staffCargoApi(reader).scan({
          qrPayload: `ETC1:${reference}`,
          type: 'RECEIVED',
        })
      ).status,
    ).toBe(403);
    expect((await staffCargoApi(denied).qr(reference)).status).toBe(403);
  });

  it('issues an opaque capability and exposes only a PII-safe coarse projection', async () => {
    const fixture = await cargoTripFixture(t.app, manager);
    const created = await staffCargoApi(manager).create(
      cargoCreateBody({
        senderName: 'PRIVATE-SENDER-NAME',
        senderContact: 'PRIVATE-SENDER-CONTACT',
        recipientName: 'PRIVATE-RECIPIENT-NAME',
        recipientContact: 'PRIVATE-RECIPIENT-CONTACT',
        declaredContents: 'PRIVATE-DECLARED-CONTENTS',
        declaredValue: { amountMinor: '987654', currencyCode: 'EUR', currencyMinorUnit: 2 },
        packageCount: 4,
      }),
    );
    expect(created.status, created.text).toBe(201);
    const reference = created.body.reference as string;

    for (const type of ['BOOKED', 'RECEIVED', 'INSPECTED']) {
      expect((await staffCargoApi(manager).event(reference, { type })).status).toBe(201);
    }
    const assigned = await staffCargoApi(manager).assign(reference, {
      tripReference: fixture.tripReference,
      vehicleCode: fixture.vehicleCode,
    });
    expect(assigned.status, assigned.text).toBe(200);
    const loaded = await staffCargoApi(manager).event(reference, {
      type: 'LOADED',
      routeWaypointId: fixture.waypointIds[0],
    });
    expect(loaded.status, loaded.text).toBe(201);

    const issued = await staffCargoApi(manager).issueTrackingToken(reference);
    expect(issued.status, issued.text).toBe(201);
    const token = issued.body.token as string;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const stored = await db(t.app).roadFreightPublicToken.findUniqueOrThrow({
      where: { id: issued.body.id as string },
      select: { tokenHash: true },
    });
    expect(stored.tokenHash).toHaveLength(32);
    expect(Buffer.from(stored.tokenHash).toString('base64url')).not.toBe(token);

    const tokenList = await staffCargoApi(reader).trackingTokens(reference);
    expect(tokenList.status, tokenList.text).toBe(200);
    expect(JSON.stringify(tokenList.body)).not.toContain(token);
    expect(JSON.stringify(tokenList.body)).not.toContain('tokenHash');

    expect((await staffCargoApi(reader).issueTrackingToken(reference)).status).toBe(403);
    expect(
      (
        await staffCargoApi(manager).issueTrackingToken(
          reference,
          { expiresAt: new Date(Date.now() - 60_000).toISOString() },
        )
      ).body.code,
    ).toBe('CARGO_TRACKING_TOKEN_EXPIRY_INVALID');

    const publicHttp = client(t.app, 'staff');
    const publicPath = '/v1/cargo-tracking/' + encodeURIComponent(token);
    const publicResponse = await publicHttp.get(publicPath);
    expect(publicResponse.status, publicResponse.text).toBe(200);
    expect(publicResponse.body).toMatchObject({
      reference,
      direction: 'PAR_DKR',
      status: 'RECEIVED',
      packageCount: 4,
      trip: {
        status: 'SCHEDULED',
        route: expect.objectContaining({ code: expect.any(String), name: expect.any(String) }),
      },
      location: expect.objectContaining({
        kind: 'STOP',
        code: 'PAR',
        name: expect.any(String),
      }),
    });

    const publicJson = JSON.stringify(publicResponse.body);
    for (const secret of [
      'PRIVATE-SENDER-NAME',
      'PRIVATE-SENDER-CONTACT',
      'PRIVATE-RECIPIENT-NAME',
      'PRIVATE-RECIPIENT-CONTACT',
      'PRIVATE-DECLARED-CONTENTS',
      '987654',
      'EUR',
      manager.email,
    ]) {
      expect(publicJson).not.toContain(secret);
    }
    expect(publicJson).not.toContain('quote');
    expect(publicJson).not.toContain('latitude');
    expect(publicJson).not.toContain('longitude');
    expect((await publicHttp.get('/v1/cargo-tracking/not-a-token')).status).toBe(404);

    const tokenRow = await db(t.app).roadFreightPublicToken.findUniqueOrThrow({
      where: { id: issued.body.id as string },
    });
    await expect(
      db(t.app).roadFreightPublicToken.update({
        where: { id: tokenRow.id },
        data: { expiresAt: new Date(Date.now() + 86400000) },
      }),
    ).rejects.toThrow(/tracking token identity is immutable/);
    await expect(
      db(t.app).roadFreightPublicToken.delete({ where: { id: tokenRow.id } }),
    ).rejects.toThrow(/tracking tokens cannot be deleted/);
    await expect(
      db(t.app).$executeRawUnsafe('TRUNCATE road_freight_public_token'),
    ).rejects.toThrow(/token history cannot be truncated/);

    const revoked = await staffCargoApi(manager).revokeTrackingToken(
      reference,
      issued.body.id as string,
      { reason: 'Fin du partage public de test' },
    );
    expect(revoked.status, revoked.text).toBe(200);
    expect(revoked.body.revokedAt).toEqual(expect.any(String));
    expect((await publicHttp.get(publicPath)).status).toBe(404);

    const replayRevoke = await staffCargoApi(manager).revokeTrackingToken(
      reference,
      issued.body.id as string,
      { reason: 'Autre motif ignoré' },
    );
    expect(replayRevoke.status, replayRevoke.text).toBe(200);
    expect(replayRevoke.body.revocationReason).toBe('Fin du partage public de test');
  });
});
