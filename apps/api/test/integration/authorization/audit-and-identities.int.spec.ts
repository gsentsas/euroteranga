import { AuthIdentityStatus } from '@euroteranga/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../../src/authorization/audit.service.js';
import { client, createIdentity, db, loginCookie } from '../../support/auth-helpers.js';
import { adminApi, staffActor } from '../../support/admin-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

describe('audit trail, identity status and session revocation', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp(integrationEnv());
  });

  afterAll(async () => {
    await t.app.close();
  });

  describe('append-only audit (real PostgreSQL)', () => {
    it('accepts INSERT and rejects UPDATE, DELETE and TRUNCATE', async () => {
      const event = await db(t.app).auditEvent.create({
        data: { action: 'TEST_APPEND_ONLY', resourceType: 'test' },
      });
      await expect(
        db(t.app).auditEvent.update({ where: { id: event.id }, data: { action: 'TAMPERED' } }),
      ).rejects.toThrow(/append-only/);
      await expect(db(t.app).auditEvent.delete({ where: { id: event.id } })).rejects.toThrow(
        /append-only/,
      );
      await expect(db(t.app).$executeRawUnsafe('TRUNCATE audit_event')).rejects.toThrow(
        /append-only/,
      );
      expect(await db(t.app).auditEvent.findUnique({ where: { id: event.id } })).toMatchObject({
        action: 'TEST_APPEND_ONLY',
      });
    });

    it('redacts sensitive values before they reach the table', async () => {
      const audit = t.app.get(AuditService);
      const marker = 'zq9-sensitive-marker';
      const id = await db(t.app).$transaction((tx) =>
        audit.record(
          {
            action: 'TEST_REDACTION',
            resourceType: 'test',
            before: { password: `${marker}-password`, nested: { token: `${marker}-token` } },
            after: { cookie: `${marker}-cookie`, authorization: `Bearer ${marker}-bearer` },
            metadata: {
              secret: `${marker}-secret`,
              csrfToken: `${marker}-csrf`,
              note: `postgresql://user:${marker}-dsn@db/x`,
              visible: 'kept',
            },
          },
          tx,
        ),
      );
      const rows = await db(t.app).$queryRawUnsafe<{ row: string }[]>(
        'SELECT row_to_json(a)::text AS row FROM audit_event a WHERE id = $1::uuid',
        id,
      );
      expect(rows[0]?.row).toBeDefined();
      expect(rows[0]?.row).not.toContain(marker);
      expect(rows[0]?.row).toContain('kept');
    });

    it('records the HTTP request id and the actor of privileged actions', async () => {
      const admin = await staffActor(t.app, ['SUPER_ADMIN']);
      const target = await createIdentity(t.app, { realm: 'staff' });
      const response = await admin.http
        .post(
          `/v1/admin/identities/${target.id}/roles`,
          { roleKey: 'DISPATCHER' },
          admin.cookie,
          await admin.csrf(),
        )
        .set('X-Request-Id', 'audit-request-0001');
      expect(response.status).toBe(200);
      const event = await db(t.app).auditEvent.findFirstOrThrow({
        where: { action: 'ROLE_GRANTED', resourceId: target.id },
      });
      expect(event).toMatchObject({
        requestId: 'audit-request-0001',
        actorIdentityId: admin.id,
        actorRealm: 'STAFF',
        after: { roleKey: 'DISPATCHER' },
      });
    });

    it('exposes the audit trail to audit.read holders, newest first, paginated', async () => {
      const auditor = adminApi(await staffActor(t.app, ['AUDITOR']));
      const page = await auditor.get('/audit?limit=3');
      expect(page.status).toBe(200);
      expect(page.body.items.length).toBeLessThanOrEqual(3);
      expect(page.body.items[0]).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          action: expect.any(String),
          occurredAt: expect.any(String),
        }),
      );
      if (page.body.nextCursor) {
        const next = await auditor.get(`/audit?limit=3&cursor=${page.body.nextCursor}`);
        expect(next.body.items[0].id < page.body.items.at(-1).id).toBe(true);
      }
    });
  });

  describe('identity status', () => {
    it('suspension revokes sessions, bumps authVersion and is audited', async () => {
      const admin = adminApi(await staffActor(t.app, ['SUPER_ADMIN']));
      const crew = await createIdentity(t.app, { realm: 'crew' });
      const cookie = await loginCookie(t.app, 'crew', crew.email);
      const before = await db(t.app).authIdentity.findUniqueOrThrow({ where: { id: crew.id } });

      const response = await admin.post(`/identities/${crew.id}/status`, {
        status: 'SUSPENDED',
        reason: 'test',
      });
      expect(response.status).toBe(200);
      const after = await db(t.app).authIdentity.findUniqueOrThrow({ where: { id: crew.id } });
      expect(after.status).toBe(AuthIdentityStatus.SUSPENDED);
      expect(after.authVersion).toBe(before.authVersion + 1);
      expect((await client(t.app, 'crew').get('/v1/auth/crew/me', cookie)).status).toBe(401);
      expect(
        await db(t.app).auditEvent.count({
          where: { action: 'IDENTITY_STATUS_CHANGED', resourceId: crew.id },
        }),
      ).toBe(1);

      // Reactivation creates no session; the old cookie stays dead.
      const sessionsBefore = await db(t.app).authSession.count({ where: { identityId: crew.id } });
      expect((await admin.post(`/identities/${crew.id}/status`, { status: 'ACTIVE' })).status).toBe(
        200,
      );
      expect(await db(t.app).authSession.count({ where: { identityId: crew.id } })).toBe(
        sessionsBefore,
      );
      expect((await client(t.app, 'crew').get('/v1/auth/crew/me', cookie)).status).toBe(401);
    });

    it.each([
      [AuthIdentityStatus.PENDING_VERIFICATION, 'ACTIVE'],
      [AuthIdentityStatus.DISABLED, 'ACTIVE'],
      [AuthIdentityStatus.ACTIVE, 'ACTIVE'],
    ])('refuses %s → %s', async (from, to) => {
      const admin = adminApi(await staffActor(t.app, ['SUPER_ADMIN']));
      const target = await createIdentity(t.app, { realm: 'staff', status: from });
      const response = await admin.post(`/identities/${target.id}/status`, { status: to });
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('INVALID_STATUS_TRANSITION');
      expect(
        (await db(t.app).authIdentity.findUniqueOrThrow({ where: { id: target.id } })).status,
      ).toBe(from);
    });

    it('admin session revocation kills the old cookie', async () => {
      const admin = adminApi(await staffActor(t.app, ['DIRECTOR']));
      const staff = await staffActor(t.app, ['DISPATCHER']);
      expect((await staff.http.get('/v1/auth/staff/me', staff.cookie)).status).toBe(200);
      expect(
        (await admin.post(`/identities/${staff.id}/sessions/revoke-all`, { reason: 'test' }))
          .status,
      ).toBe(204);
      expect((await staff.http.get('/v1/auth/staff/me', staff.cookie)).status).toBe(401);
      expect(
        await db(t.app).auditEvent.count({
          where: { action: 'SESSIONS_REVOKED_BY_ADMIN', resourceId: staff.id },
        }),
      ).toBe(1);
    });
  });
});
