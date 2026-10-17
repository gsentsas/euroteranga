import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApiEnv } from '@euroteranga/config';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminApi,
  isolatedDatabase,
  staffActor,
  type StaffActor,
} from '../../support/admin-helpers.js';
import { client, createIdentity, csrfToken, db, loginCookie } from '../../support/auth-helpers.js';
import {
  confirmedPassenger,
  customerBaggageApi,
  staffBaggageApi,
} from '../../support/baggage-helpers.js';
import {
  bookableFixture,
  customerActor,
  type BookableFixture,
  type CustomerActor,
} from '../../support/booking-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

interface CrewActor {
  id: string;
  cookie: string;
  csrf: string;
  http: ReturnType<typeof client>;
}

describe('PR-21 operational incidents', () => {
  const run = randomBytes(4).toString('hex').toUpperCase();
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let storageRoot: string;
  let env: ApiEnv;
  let t: TestApp;
  let ops: StaffActor;
  let reader: StaffActor;
  let denied: StaffActor;
  let customer: CustomerActor;
  let fixture: BookableFixture;

  beforeAll(async () => {
    database = await isolatedDatabase();
    storageRoot = await mkdtemp(join(tmpdir(), 'et-incident-evidence-'));
    env = integrationEnv({ DATABASE_URL: database.url, OBJECT_STORAGE_LOCAL_ROOT: storageRoot });
    t = await startTestApp(env);
    [ops, reader, denied, customer] = await Promise.all([
      staffActor(t.app, ['OPS_MANAGER']),
      staffActor(t.app, ['CUSTOMER_SUPPORT']),
      staffActor(t.app, ['BOOKING_AGENT']),
      customerActor(t.app),
    ]);
    fixture = await bookableFixture(t.app);
  }, 120_000);

  afterAll(async () => {
    await t?.app.close();
    await database?.drop();
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
  });

  function openBody(
    clientEventId: string,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      tripReference: fixture.tripReference,
      clientEventId,
      type: 'DELAY',
      severity: 'MEDIUM',
      description: 'Retard operationnel constate pendant le trajet de test.',
      openedAt: new Date().toISOString(),
      routeWaypointId: fixture.wp[2],
      locationLabel: 'Point operationnel de test',
      ...overrides,
    };
  }

  async function crewActor(): Promise<CrewActor> {
    const identity = await createIdentity(t.app, { realm: 'crew' });
    await db(t.app).authorizationRoleAssignment.create({
      data: {
        identityId: identity.id,
        roleKey: 'CREW',
        grantReason: 'pr21 incident test',
      },
    });
    const cookie = await loginCookie(t.app, 'crew', identity.email);
    return {
      id: identity.id,
      cookie,
      csrf: await csrfToken(t.app, 'crew', cookie),
      http: client(t.app, 'crew'),
    };
  }

  it('separates read/manage RBAC and keeps audit free of report free-text', async () => {
    expect((await adminApi(denied).get('/incidents')).status).toBe(403);
    expect((await adminApi(reader).get('/incidents')).status).toBe(200);

    const deniedCreate = await adminApi(reader).post(
      '/incidents',
      openBody('evt-' + run + '-rbac'),
    );
    expect(deniedCreate.status).toBe(403);

    const created = await adminApi(ops).post('/incidents', openBody('evt-' + run + '-audit'));
    expect(created.status, created.text).toBe(201);
    expect(created.body.incident).toMatchObject({
      status: 'OPEN',
      source: 'STAFF',
      type: 'DELAY',
      severity: 'MEDIUM',
      trip: { reference: fixture.tripReference },
    });

    const audit = await db(t.app).auditEvent.findFirstOrThrow({
      where: {
        action: 'INCIDENT_OPENED',
        resourceId: created.body.incident.id as string,
      },
      orderBy: { occurredAt: 'desc' },
    });
    expect(JSON.stringify(audit.after)).not.toContain(
      'Retard operationnel constate pendant le trajet de test.',
    );
  });

  it('is exactly idempotent on trip + clientEventId and conflicts on changed payload', async () => {
    const clientEventId = 'evt-' + run + '-idem';
    const payload = openBody(clientEventId, {
      type: 'SECURITY',
      severity: 'HIGH',
      description: 'Incident de securite operationnelle signale sur le trajet.',
    });

    const first = await adminApi(ops).post('/incidents', payload);
    expect(first.status, first.text).toBe(201);
    expect(first.body.created).toBe(true);

    const replay = await adminApi(ops).post('/incidents', payload);
    expect(replay.status, replay.text).toBe(201);
    expect(replay.body.created).toBe(false);
    expect(replay.body.incident.id).toBe(first.body.incident.id);

    const conflict = await adminApi(ops).post('/incidents', {
      ...payload,
      severity: 'CRITICAL',
    });
    expect(conflict.status, conflict.text).toBe(409);
    expect(conflict.body.code).toBe('INCIDENT_CLIENT_EVENT_ID_REUSED');

    expect(
      await db(t.app).incident.count({
        where: { tripId: fixture.tripId, clientEventId },
      }),
    ).toBe(1);
  });

  it('enforces the canonical workflow and critical breakdown milestones', async () => {
    const created = await adminApi(ops).post(
      '/incidents',
      openBody('evt-' + run + '-critical', {
        type: 'BREAKDOWN',
        severity: 'CRITICAL',
        description: 'Panne moteur critique immobilisant le vehicule pendant le trajet.',
      }),
    );
    expect(created.status, created.text).toBe(201);
    const reference = created.body.incident.reference as string;

    const transition = async (status: string, expectedStatus?: string) =>
      adminApi(ops).post('/incidents/' + reference + '/transition', {
        status,
        ...(expectedStatus ? { expectedStatus } : {}),
      });
    const action = async (id: string, type: string, content: string) =>
      adminApi(ops).post('/incidents/' + reference + '/actions', {
        clientActionId: id,
        type,
        content,
      });

    expect((await transition('ASSESSING', 'OPEN')).status).toBe(201);
    expect((await transition('ACTION_REQUIRED', 'ASSESSING')).status).toBe(201);

    const noPlan = await transition('MITIGATING', 'ACTION_REQUIRED');
    expect(noPlan.status, noPlan.text).toBe(409);
    expect(noPlan.body.code).toBe('INCIDENT_CRITICAL_MILESTONE_REQUIRED');

    const planPayload = {
      clientActionId: 'act-' + run + '-plan',
      type: 'ACTION_PLAN',
      content: 'Immobiliser le vehicule et organiser la solution de continuite.',
    };
    const plan = await adminApi(ops).post('/incidents/' + reference + '/actions', planPayload);
    expect(plan.status, plan.text).toBe(201);
    expect(plan.body.created).toBe(true);
    const planReplay = await adminApi(ops).post(
      '/incidents/' + reference + '/actions',
      planPayload,
    );
    expect(planReplay.status, planReplay.text).toBe(201);
    expect(planReplay.body.created).toBe(false);

    expect((await transition('MITIGATING', 'ACTION_REQUIRED')).status).toBe(201);

    const noPassengerNotice = await transition('RESOLVED', 'MITIGATING');
    expect(noPassengerNotice.status).toBe(409);
    expect(noPassengerNotice.body.code).toBe('INCIDENT_CRITICAL_MILESTONE_REQUIRED');

    expect(
      (
        await action(
          'act-' + run + '-notice',
          'PASSENGERS_INFORMED',
          'Les passagers ont recu une information operationnelle sur la continuite.',
        )
      ).status,
    ).toBe(201);

    const resolved = await transition('RESOLVED', 'MITIGATING');
    expect(resolved.status, resolved.text).toBe(201);
    expect(resolved.body).toMatchObject({ status: 'RESOLVED' });
    expect(resolved.body.resolvedAt).toBeTruthy();

    const noPostmortem = await transition('CLOSED', 'RESOLVED');
    expect(noPostmortem.status).toBe(409);
    expect(noPostmortem.body.code).toBe('INCIDENT_CRITICAL_MILESTONE_REQUIRED');

    expect(
      (
        await action(
          'act-' + run + '-post',
          'POSTMORTEM',
          'Analyse operationnelle terminee et mesures preventives documentees.',
        )
      ).status,
    ).toBe(201);

    const closed = await transition('CLOSED', 'RESOLVED');
    expect(closed.status, closed.text).toBe(201);
    expect(closed.body).toMatchObject({ status: 'CLOSED' });
    expect(closed.body.closedAt).toBeTruthy();

    const afterClose = await action(
      'act-' + run + '-late',
      'NOTE',
      'Cette action ne doit pas etre acceptee apres cloture.',
    );
    expect(afterClose.status).toBe(409);
    expect(afterClose.body.code).toBe('INCIDENT_CLOSED');

    await expect(
      db(t.app).incident.update({
        where: { reference },
        data: { description: 'Mutation interdite des faits initiaux.' },
      }),
    ).rejects.toThrow(/initial facts are immutable/i);

    const firstAction = await db(t.app).incidentAction.findFirstOrThrow({
      where: { incident: { reference } },
      orderBy: { sequence: 'asc' },
    });
    await expect(
      db(t.app).incidentAction.delete({ where: { id: firstAction.id } }),
    ).rejects.toThrow(/append-only/i);
    await expect(db(t.app).incident.delete({ where: { reference } })).rejects.toThrow(
      /cannot be deleted/i,
    );
  });

  it('records Crew incident provenance through the shared offline sync contract', async () => {
    const crew = await crewActor();
    const deviceId = 'crew-' + run.toLowerCase() + '-incident';
    const enroll = await crew.http.post(
      '/v1/crew/devices/enroll',
      { deviceId, label: 'PR21' },
      crew.cookie,
      crew.csrf,
    );
    expect(enroll.status, enroll.text).toBe(201);

    const assignment = await db(t.app).crewTripAssignment.create({
      data: {
        tripId: fixture.tripId,
        crewIdentityId: crew.id,
        assignedByIdentityId: ops.id,
      },
    });

    const clientEventId = 'evt-' + run + '-crew';
    const syncBody = {
      deviceId,
      events: [
        {
          clientEventId,
          type: 'INCIDENT_REPORTED',
          occurredAt: new Date().toISOString(),
          payload: {
            incidentType: 'WEATHER',
            severity: 'HIGH',
            description: 'Conditions meteo degradant fortement la progression du trajet.',
            routeWaypointId: fixture.wp[2],
            locationLabel: 'Secteur meteo test',
          },
        },
      ],
    };

    const sync = await crew.http.post(
      '/v1/crew/trips/' + encodeURIComponent(fixture.tripReference) + '/events/sync',
      syncBody,
      crew.cookie,
      crew.csrf,
    );
    expect(sync.status, sync.text).toBe(201);
    expect(sync.body.results[0]).toMatchObject({
      clientEventId,
      status: 'ACKNOWLEDGED',
      created: true,
    });
    expect(sync.body.results[0].incidentReference).toMatch(/^ETI-/);

    const persisted = await db(t.app).incident.findFirstOrThrow({
      where: { tripId: fixture.tripId, clientEventId },
    });
    const device = await db(t.app).crewDevice.findUniqueOrThrow({ where: { deviceId } });
    expect(persisted).toMatchObject({
      source: 'CREW',
      openedByIdentityId: crew.id,
      crewAssignmentId: assignment.id,
      crewDeviceId: device.id,
    });

    const replay = await crew.http.post(
      '/v1/crew/trips/' + encodeURIComponent(fixture.tripReference) + '/events/sync',
      syncBody,
      crew.cookie,
      crew.csrf,
    );
    expect(replay.status, replay.text).toBe(201);
    expect(replay.body.results[0]).toMatchObject({
      status: 'ACKNOWLEDGED',
      created: false,
    });

    const conflict = await crew.http.post(
      '/v1/crew/trips/' + encodeURIComponent(fixture.tripReference) + '/events/sync',
      {
        ...syncBody,
        events: [
          {
            ...syncBody.events[0],
            payload: { ...syncBody.events[0]!.payload, severity: 'CRITICAL' },
          },
        ],
      },
      crew.cookie,
      crew.csrf,
    );
    expect(conflict.status, conflict.text).toBe(201);
    expect(conflict.body.results[0]).toMatchObject({
      status: 'CONFLICT',
      errorCode: 'INCIDENT_CLIENT_EVENT_ID_REUSED',
    });
  });

  it('stores scanned incident evidence privately and authorizes the exact download', async () => {
    const created = await adminApi(ops).post(
      '/incidents',
      openBody('evt-' + run + '-attachment', {
        type: 'ACCIDENT',
        severity: 'HIGH',
        description: 'Accident opérationnel nécessitant une preuve privée contrôlée.',
      }),
    );
    expect(created.status, created.text).toBe(201);
    const reference = created.body.incident.reference as string;
    const body = Buffer.from('%PDF-1.7\nincident-evidence\n%%EOF\n', 'utf8');
    const csrf = await ops.csrf();

    const uploaded = await request(t.app.getHttpServer())
      .post('/v1/admin/incidents/' + reference + '/attachments')
      .set('Origin', ops.http.origin)
      .set('X-Forwarded-For', ops.ip)
      .set('Cookie', ops.cookie)
      .set('X-CSRF-Token', csrf)
      .attach('file', body, { filename: 'preuve.pdf', contentType: 'application/pdf' });
    expect(uploaded.status, uploaded.text).toBe(201);
    expect(uploaded.body).toMatchObject({
      mimeType: 'application/pdf',
      sizeBytes: body.length,
    });
    expect(uploaded.body.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(uploaded.body)).not.toMatch(/objectKey|bucket|path|scanner/i);

    const attachmentId = uploaded.body.id as string;
    const stored = await db(t.app).incidentAttachment.findUniqueOrThrow({
      where: { id: attachmentId },
    });
    expect(stored.objectKey).toMatch(/^incident-attachments\/[0-9a-f]{2}\/[0-9a-f]{64}$/u);
    expect(stored.sha256).toBe(uploaded.body.sha256);

    const downloaded = await request(t.app.getHttpServer())
      .get('/v1/admin/incidents/' + reference + '/attachments/' + attachmentId + '/download')
      .set('Origin', ops.http.origin)
      .set('X-Forwarded-For', ops.ip)
      .set('Cookie', ops.cookie);
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers['cache-control']).toBe('private, no-store');
    expect(downloaded.headers['x-content-type-options']).toBe('nosniff');
    expect(downloaded.headers['content-type']).toMatch(/^application\/pdf/u);
    expect(Buffer.compare(downloaded.body as Buffer, body)).toBe(0);

    const uploadAudit = await db(t.app).auditEvent.findFirstOrThrow({
      where: {
        action: 'INCIDENT_ATTACHMENT_UPLOADED',
        resourceType: 'incident_attachment',
        resourceId: attachmentId,
      },
    });
    const accessAudit = await db(t.app).auditEvent.findFirstOrThrow({
      where: {
        action: 'INCIDENT_ATTACHMENT_ACCESSED',
        resourceType: 'incident',
        resourceId: created.body.incident.id as string,
      },
    });
    expect(JSON.stringify([uploadAudit, accessAudit])).not.toMatch(/%PDF|incident-attachments\//u);

    await expect(
      db(t.app).incidentAttachment.update({
        where: { id: attachmentId },
        data: { mimeType: 'image/png' },
      }),
    ).rejects.toThrow(/immutable/i);
  });

  it('links BAGGAGE incidents only to a same-trip bag currently MISSING or DAMAGED', async () => {
    const subject = await confirmedPassenger(t.app, env, customer);
    const registered = await customerBaggageApi(customer).register(
      subject.bookingReference,
      subject.passengerReference,
      { type: 'BOX' },
    );
    expect(registered.status, registered.text).toBe(201);
    const baggageReference = registered.body.reference as string;

    const notExceptional = await adminApi(ops).post('/incidents', {
      tripReference: subject.fixture.tripReference,
      clientEventId: 'evt-' + run + '-bag-early',
      type: 'BAGGAGE',
      severity: 'MEDIUM',
      description: 'Signalement bagage avant apparition d une exception operationnelle.',
      openedAt: new Date().toISOString(),
      baggageReference,
    });
    expect(notExceptional.status).toBe(422);
    expect(notExceptional.body.code).toBe('INCIDENT_BAGGAGE_INVALID');

    const missing = await staffBaggageApi(ops).event(baggageReference, { type: 'MISSING' });
    expect(missing.status, missing.text).toBe(201);

    const wrongTrip = await adminApi(ops).post('/incidents', {
      tripReference: fixture.tripReference,
      clientEventId: 'evt-' + run + '-bag-wrong',
      type: 'BAGGAGE',
      severity: 'HIGH',
      description: 'Le bagage manque mais il ne correspond pas au voyage indique.',
      openedAt: new Date().toISOString(),
      baggageReference,
    });
    expect(wrongTrip.status).toBe(422);
    expect(wrongTrip.body.code).toBe('INCIDENT_BAGGAGE_INVALID');

    const linked = await adminApi(ops).post('/incidents', {
      tripReference: subject.fixture.tripReference,
      clientEventId: 'evt-' + run + '-bag-ok',
      type: 'BAGGAGE',
      severity: 'HIGH',
      description: 'Bagage manquant confirme et rattache au voyage concerne.',
      openedAt: new Date().toISOString(),
      baggageReference,
    });
    expect(linked.status, linked.text).toBe(201);
    expect(linked.body.incident.baggage).toMatchObject({
      reference: baggageReference,
      exceptionStatus: 'MISSING',
    });
  });
});
