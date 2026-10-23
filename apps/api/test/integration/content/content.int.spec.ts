import { createDatabaseClient } from '@euroteranga/database';
import { DEFAULT_HOME_PAGE, PAGE_TEMPLATES } from '@euroteranga/content';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminApi,
  isolatedDatabase,
  staffActor,
  type StaffActor,
} from '../../support/admin-helpers.js';
import { db } from '../../support/auth-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

const UNKNOWN_ID = '01900000-0000-7000-8000-000000000000';

interface EntryView {
  id: string;
  kind: string;
  key: string;
  archivedAt: string | null;
  draft: { revision: number; updatedAt: string; document: Record<string, unknown> } | null;
  published: { revision: number; document: Record<string, unknown> } | null;
  history: Array<{ revision: number; status: string; basedOnRevision: number | null }>;
}

/**
 * CMS-1 content administration and public reads, on their own database (one
 * test installs a failing audit trigger). Pages, site settings and
 * navigation are written through the API only.
 */
describe('content management (isolated database)', () => {
  let t: TestApp;
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let director: StaffActor;
  let editor: StaffActor;
  let dispatcher: StaffActor;
  let sequence = 0;

  beforeAll(async () => {
    database = await isolatedDatabase();
    t = await startTestApp(integrationEnv({ DATABASE_URL: database.url }));
    [director, editor, dispatcher] = await Promise.all([
      staffActor(t.app, ['DIRECTOR']),
      staffActor(t.app, ['CONTENT_EDITOR']),
      staffActor(t.app, ['DISPATCHER']),
    ]);
  });

  afterAll(async () => {
    await t.app.close();
    await database.drop();
  });

  const publicApi = () => ({
    get: (path: string) =>
      request(t.app.getHttpServer())
        .get(`/v1/content${path}`)
        .set('Origin', 'http://localhost:3000'),
  });
  const uniquePath = () => `/page-${Date.now().toString(36)}-${(sequence += 1)}`;

  async function createPage(actor: StaffActor = editor, path = uniquePath()) {
    const response = await adminApi(actor).post('/content/entries', {
      kind: 'PAGE',
      path,
      title: 'Page de test',
      description: 'Description de test de la page.',
    });
    if (response.status !== 201) throw new Error(`page: ${response.status} ${response.text}`);
    return response.body as EntryView;
  }

  const pageDocument = (overrides: Record<string, unknown> = {}) => ({
    title: 'Page de test',
    seo: { description: 'Description de test de la page.', indexable: false },
    blocks: [{ type: 'banner', text: 'Bienvenue' }],
    ...overrides,
  });

  async function saveDraft(actor: StaffActor, entry: EntryView, document: unknown) {
    return adminApi(actor).post(`/content/entries/${entry.id}/draft`, {
      document,
      expectedDraftUpdatedAt: entry.draft?.updatedAt ?? null,
    });
  }

  async function publish(actor: StaffActor, entry: EntryView) {
    return adminApi(actor).post(`/content/entries/${entry.id}/publish`, {
      expectedDraftUpdatedAt: entry.draft!.updatedAt,
    });
  }

  describe('authorization', () => {
    it('separates content from operations and requires CSRF on every mutation', async () => {
      expect((await adminApi(dispatcher).get('/content/entries')).status).toBe(403);
      expect(
        (
          await adminApi(dispatcher).post('/content/entries', {
            kind: 'PAGE',
            path: uniquePath(),
            title: 'Interdit',
            description: 'Interdit.',
          })
        ).status,
      ).toBe(403);
      const page = await createPage();
      const api = adminApi(editor);
      for (const [path, body] of [
        ['/content/entries', { kind: 'PAGE', path: uniquePath(), title: 'X', description: 'X.' }],
        [
          `/content/entries/${page.id}/draft`,
          { document: pageDocument(), expectedDraftUpdatedAt: null },
        ],
        [`/content/entries/${page.id}/publish`, { expectedDraftUpdatedAt: page.draft!.updatedAt }],
        [`/content/entries/${page.id}/archive`, { reason: 'Sans CSRF' }],
      ] as const) {
        expect((await api.post(path, body, { csrf: null })).status, path).toBe(403);
      }
      expect(await db(t.app).contentRevision.count({ where: { entryId: page.id } })).toBe(1);
    });
  });

  describe('pages', () => {
    it('creates a page as a non-indexable draft and refuses duplicate or reserved paths', async () => {
      const path = uniquePath();
      const page = await createPage(editor, path);
      expect(page).toMatchObject({ kind: 'PAGE', key: path, published: null });
      expect(page.draft).toMatchObject({ revision: 1 });
      expect(page.draft!.document).toMatchObject({
        title: 'Page de test',
        seo: { indexable: false },
        blocks: [],
      });

      const duplicate = await adminApi(editor).post('/content/entries', {
        kind: 'PAGE',
        path,
        title: 'Doublon',
        description: 'Doublon.',
      });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.code).toBe('CONTENT_PATH_TAKEN');
      for (const reserved of ['/sitemap', '/apercu', '/Majuscule', '/a_b', 'relatif']) {
        const response = await adminApi(editor).post('/content/entries', {
          kind: 'PAGE',
          path: reserved,
          title: 'Réservé',
          description: 'Réservé.',
        });
        expect(response.status, reserved).toBe(400);
      }
    });

    it('validates documents against the content model and reports precise issues', async () => {
      const page = await createPage();
      const invalid = await saveDraft(editor, page, {
        ...pageDocument(),
        blocks: [
          { type: 'html', html: '<script>alert(1)</script>' },
          {
            type: 'cta',
            title: 'Partir',
            button: { label: 'Go', target: { kind: 'url', url: 'javascript:alert(1)' } },
          },
        ],
      });
      expect(invalid.status).toBe(422);
      expect(invalid.body.code).toBe('CONTENT_DOCUMENT_INVALID');
      expect(invalid.body.details.issues.length).toBeGreaterThan(0);
      expect(JSON.stringify(invalid.body.details.issues)).toContain('blocks.0');
      const unchanged = await adminApi(editor).get(`/content/entries/${page.id}`);
      expect(unchanged.body.draft.document.blocks).toEqual([]);
    });

    it('keeps drafts private until published, then serves the live revision publicly', async () => {
      const page = await createPage();
      expect((await publicApi().get(`/pages?path=${page.key}`)).status).toBe(404);

      const saved = await saveDraft(editor, page, pageDocument());
      expect(saved.status, saved.text).toBe(200);
      const published = await publish(editor, saved.body);
      expect(published.status).toBe(200);
      expect(published.body.published).toMatchObject({ revision: 1 });
      expect(published.body.draft).toBeNull();

      const live = await publicApi().get(`/pages?path=${page.key}`);
      expect(live.status).toBe(200);
      expect(live.headers['cache-control']).toBe('public, max-age=60');
      expect(live.body).toMatchObject({ path: page.key, revision: 1 });
      expect(live.body.document.blocks).toEqual([
        { type: 'banner', text: 'Bienvenue', tone: 'info' },
      ]);

      // A new draft never changes what the public sees.
      const draft = await saveDraft(
        editor,
        published.body,
        pageDocument({ blocks: [{ type: 'banner', text: 'Brouillon' }] }),
      );
      expect(draft.body.draft).toMatchObject({ revision: 2 });
      expect((await publicApi().get(`/pages?path=${page.key}`)).body.revision).toBe(1);

      const second = await publish(editor, draft.body);
      expect(second.body.published.revision).toBe(2);
      expect(
        second.body.history.map((h: { revision: number; status: string }) => [
          h.revision,
          h.status,
        ]),
      ).toEqual([
        [2, 'PUBLISHED'],
        [1, 'SUPERSEDED'],
      ]);
      expect((await publicApi().get(`/pages?path=${page.key}`)).body.document.blocks[0].text).toBe(
        'Brouillon',
      );
    });

    it('refuses a stale draft decision (optimistic concurrency)', async () => {
      const page = await createPage();
      const stale = await adminApi(editor).post(`/content/entries/${page.id}/draft`, {
        document: pageDocument(),
        expectedDraftUpdatedAt: null,
      });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('CONTENT_DRAFT_CONFLICT');
      const first = await saveDraft(editor, page, pageDocument());
      expect(first.status).toBe(200);
      const outdated = await saveDraft(editor, page, pageDocument());
      expect(outdated.status).toBe(409);
      const publishStale = await adminApi(editor).post(`/content/entries/${page.id}/publish`, {
        expectedDraftUpdatedAt: page.draft!.updatedAt,
      });
      expect(publishStale.body.code).toBe('CONTENT_DRAFT_CONFLICT');
    });

    it('requires seo.manage to change search metadata, not to edit the content', async () => {
      const page = await createPage();
      const content = await saveDraft(
        editor,
        page,
        pageDocument({ blocks: [{ type: 'banner', text: 'Texte' }] }),
      );
      expect(content.status).toBe(200);

      const seo = await saveDraft(
        editor,
        content.body,
        pageDocument({
          seo: { description: 'Description de test de la page.', indexable: true },
        }),
      );
      expect(seo.status).toBe(403);
      expect(seo.body.code).toBe('CONTENT_SEO_PERMISSION_REQUIRED');
      const after = await adminApi(editor).get(`/content/entries/${page.id}`);
      expect(after.body.draft.document.seo.indexable).toBe(false);

      const opened = await saveDraft(
        director,
        after.body,
        pageDocument({
          seo: { description: 'Une meilleure description.', indexable: true },
        }),
      );
      expect(opened.status).toBe(200);
      expect(opened.body.draft.document.seo).toMatchObject({ indexable: true });
    });

    it('discards a draft, restores an earlier revision as a new draft and keeps history', async () => {
      const page = await createPage();
      const v1 = await publish(
        editor,
        (
          await saveDraft(
            editor,
            page,
            pageDocument({ blocks: [{ type: 'banner', text: 'Version 1' }] }),
          )
        ).body,
      );
      const v2 = await publish(
        editor,
        (
          await saveDraft(
            editor,
            v1.body,
            pageDocument({ blocks: [{ type: 'banner', text: 'Version 2' }] }),
          )
        ).body,
      );

      const draft = await saveDraft(
        editor,
        v2.body,
        pageDocument({ blocks: [{ type: 'banner', text: 'Abandon' }] }),
      );
      const busy = await adminApi(editor).post(`/content/entries/${page.id}/restore`, {
        revision: 1,
      });
      expect(busy.body.code).toBe('CONTENT_DRAFT_EXISTS');
      const discarded = await adminApi(editor).post(`/content/entries/${page.id}/discard-draft`, {
        expectedDraftUpdatedAt: draft.body.draft.updatedAt,
      });
      expect(discarded.status).toBe(200);
      expect(discarded.body.draft).toBeNull();

      const restored = await adminApi(editor).post(`/content/entries/${page.id}/restore`, {
        revision: 1,
      });
      expect(restored.status).toBe(200);
      expect(restored.body.draft).toMatchObject({ revision: 4, basedOnRevision: 1 });
      expect(restored.body.draft.document.blocks[0].text).toBe('Version 1');
      expect((await publicApi().get(`/pages?path=${page.key}`)).body.document.blocks[0].text).toBe(
        'Version 2',
      );

      const old = await adminApi(editor).get(`/content/entries/${page.id}/revisions/1`);
      expect(old.body).toMatchObject({ revision: 1, status: 'SUPERSEDED' });
      expect((await adminApi(editor).get(`/content/entries/${page.id}/revisions/99`)).status).toBe(
        404,
      );
    });

    it('archives a page out of the public site and refuses to archive the home page', async () => {
      const page = await createPage();
      await publish(editor, (await saveDraft(editor, page, pageDocument())).body);
      const archived = await adminApi(editor).post(`/content/entries/${page.id}/archive`, {
        reason: 'Page retirée',
      });
      expect(archived.status).toBe(200);
      expect((await publicApi().get(`/pages?path=${page.key}`)).status).toBe(404);
      expect(
        (await adminApi(editor).post(`/content/entries/${page.id}/archive`, { reason: 'Encore' }))
          .body.code,
      ).toBe('CONTENT_ALREADY_ARCHIVED');
      expect(
        (await adminApi(editor).post(`/content/entries/${page.id}/unarchive`, {})).status,
      ).toBe(200);
      expect((await publicApi().get(`/pages?path=${page.key}`)).status).toBe(200);

      const home = await createPage(director, '/');
      const refused = await adminApi(director).post(`/content/entries/${home.id}/archive`, {
        reason: 'Interdit',
      });
      expect(refused.status).toBe(422);
      expect(refused.body.code).toBe('CONTENT_ARCHIVE_FORBIDDEN');
    });

    it('accepts the default home page and lists only served, indexable pages in the sitemap', async () => {
      const home = await adminApi(director).get('/content/entries?kind=PAGE');
      const entry = (home.body.items as EntryView[]).find((item) => item.key === '/')!;
      const detail = (await adminApi(director).get(`/content/entries/${entry.id}`))
        .body as EntryView;
      const saved = await saveDraft(director, detail, DEFAULT_HOME_PAGE);
      expect(saved.status, saved.text).toBe(200);
      expect((await publish(director, saved.body)).status).toBe(200);

      const hidden = await createPage();
      await publish(editor, (await saveDraft(editor, hidden, pageDocument())).body);
      const sitemap = await publicApi().get('/sitemap');
      const paths = (sitemap.body.items as Array<{ path: string }>).map((item) => item.path);
      expect(paths).toContain('/');
      expect(paths).not.toContain(hidden.key);
    });
  });

  describe('site settings and navigation', () => {
    it('creates singletons from the default content, once, and serves them once published', async () => {
      expect((await publicApi().get('/site')).body).toEqual({
        settings: null,
        navigation: null,
        updatedAt: null,
      });
      const settings = await adminApi(director).post('/content/entries', { kind: 'SITE_SETTINGS' });
      expect(settings.status).toBe(201);
      expect(settings.body).toMatchObject({ key: 'site' });
      expect(settings.body.draft.document.legal.companyName).toBeNull();
      const again = await adminApi(director).post('/content/entries', { kind: 'SITE_SETTINGS' });
      expect(again.body.code).toBe('CONTENT_SINGLETON_EXISTS');
      const navigation = await adminApi(director).post('/content/entries', { kind: 'NAVIGATION' });

      const freight = await createPage(editor, '/fret');
      const freightDraft = await saveDraft(editor, freight, pageDocument());
      const blockedFreight = await publish(editor, freightDraft.body);
      expect(blockedFreight.status).toBe(422);
      expect(blockedFreight.body.code).toBe('CONTENT_PUBLIC_CONTACT_REQUIRED');

      const settingsWithContact = await saveDraft(director, settings.body, {
        ...settings.body.draft.document,
        contact: {
          ...settings.body.draft.document.contact,
          email: 'contact@example.test',
        },
      });
      expect(settingsWithContact.status, settingsWithContact.text).toBe(200);

      const publishedContactSettings = await publish(director, settingsWithContact.body);
      expect((await publish(editor, freightDraft.body)).status).toBe(200);

      const ownerPages = await Promise.all(
        [
          ['contact', 'contact'],
          ['legal-notice', 'legal'],
          ['privacy', 'privacy'],
        ].map(async ([templateId, kind]) => {
          const template = PAGE_TEMPLATES.find((candidate) => candidate.id === templateId)!;
          const page = await createPage(editor, template.path);
          const saved = await saveDraft(editor, page, template.document);
          expect(saved.status, saved.text).toBe(200);
          const blocked = await publish(editor, saved.body);
          expect(blocked.status).toBe(422);
          expect(blocked.body).toMatchObject({
            code: 'CONTENT_OWNER_INFO_REQUIRED',
            details: { kind },
          });
          expect(blocked.body.details.missing.length).toBeGreaterThan(0);
          return saved.body as EntryView;
        }),
      );

      const settingsComplete = await saveDraft(director, publishedContactSettings.body, {
        ...publishedContactSettings.body.published.document,
        contact: {
          email: 'contact@example.test',
          phone: '+33100000000',
          address: null,
          hours: 'Lun-Ven 09:00-18:00',
        },
        legal: {
          companyName: 'Société synthétique E2E',
          legalForm: 'Forme synthétique',
          registeredAddress: '1 rue de Test, 00000 Test',
          shareCapital: 'Capital synthétique',
          registrationNumber: 'REG-E2E-001',
          vatNumber: 'VAT-E2E-001',
          publicationDirector: 'Direction synthétique',
          hostName: 'Hébergeur synthétique',
          hostAddress: '2 rue de Test, 00000 Test',
          hostContact: 'host@example.test',
        },
        privacy: {
          dataController: 'Responsable synthétique E2E',
          privacyContact: 'privacy@example.test',
          purposesAndLegalBases: 'Finalités et bases légales synthétiques pour le test.',
          retentionPeriods: 'Durées de conservation synthétiques pour le test.',
          processors: 'Sous-traitants synthétiques pour le test.',
          transfersOutsideEu: 'Politique de transferts synthétique pour le test.',
        },
        social: [{ network: 'facebook', url: 'https://example.test/euro-teranga' }],
      });
      expect(settingsComplete.status, settingsComplete.text).toBe(200);
      expect((await publish(director, settingsComplete.body)).status).toBe(200);

      for (const page of ownerPages) {
        expect((await publish(editor, page)).status).toBe(200);
        expect((await publicApi().get(`/pages?path=${page.key}`)).status).toBe(200);
      }

      await publish(director, navigation.body);
      const site = await publicApi().get('/site');
      expect(site.body.settings).toMatchObject({ brandName: 'EURO TERANGA' });
      expect(site.body.navigation.headerCta).toMatchObject({ label: 'Réserver' });
      expect(site.body.updatedAt).not.toBeNull();

      const archive = await adminApi(director).post(
        `/content/entries/${settings.body.id}/archive`,
        {
          reason: 'Interdit',
        },
      );
      expect(archive.body.code).toBe('CONTENT_ARCHIVE_FORBIDDEN');
    });
  });

  describe('audit and database guarantees', () => {
    it('audits every mutation in its transaction, with fingerprints and no document copy', async () => {
      const page = await createPage();
      const saved = await saveDraft(editor, page, pageDocument());
      await publish(editor, saved.body);
      const events = await db(t.app).auditEvent.findMany({
        where: { resourceType: 'content_entry', resourceId: page.id },
        orderBy: { occurredAt: 'asc' },
      });
      expect(events.map((event) => event.action)).toEqual([
        'CONTENT_ENTRY_CREATED',
        'CONTENT_DRAFT_SAVED',
        'CONTENT_PUBLISHED',
      ]);
      for (const event of events) {
        expect(event.actorIdentityId).toBe(editor.id);
        expect(JSON.stringify(event.after)).toMatch(/"fingerprint":"[0-9a-f]{64}"/);
        expect(JSON.stringify(event.after)).not.toContain('Bienvenue');
      }
    });

    it('rolls a publication back when its audit event cannot be written', async () => {
      const page = await createPage();
      const saved = await saveDraft(editor, page, pageDocument());
      await db(t.app).$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION test_fail_content_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.action = 'CONTENT_PUBLISHED' THEN RAISE EXCEPTION 'audit unavailable'; END IF;
          RETURN NEW;
        END $$`);
      await db(t.app).$executeRawUnsafe(
        'CREATE TRIGGER test_fail_content_audit BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION test_fail_content_audit()',
      );
      try {
        const failed = await publish(editor, saved.body);
        expect(failed.status).toBe(500);
      } finally {
        await db(t.app).$executeRawUnsafe('DROP TRIGGER test_fail_content_audit ON audit_event');
        await db(t.app).$executeRawUnsafe('DROP FUNCTION test_fail_content_audit()');
      }
      const after = await adminApi(editor).get(`/content/entries/${page.id}`);
      expect(after.body.published).toBeNull();
      expect(after.body.draft).toMatchObject({ revision: 1 });
    });

    it('two concurrent publications of the same draft: exactly one applies', async () => {
      const page = await createPage();
      const saved = await saveDraft(editor, page, pageDocument());
      const gate = createDatabaseClient({ databaseUrl: database.url });
      let pending: Array<Promise<{ status: number }>> = [];
      try {
        await gate.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT "id" FROM "content_entry" WHERE "id" = ${page.id}::uuid FOR UPDATE`;
            pending = [publish(editor, saved.body), publish(director, saved.body)];
            const deadline = Date.now() + 15_000;
            for (;;) {
              // Both publications wait on the entry row lock held here.
              const rows = await tx.$queryRaw<Array<{ waiting: bigint }>>`
                SELECT count(*) AS waiting FROM pg_stat_activity
                WHERE datname = current_database() AND wait_event_type = 'Lock'
                  AND cardinality(pg_blocking_pids(pid)) > 0
              `;
              if (Number(rows[0]?.waiting ?? 0) >= 2) break;
              if (Date.now() > deadline) throw new Error('publications never queued on the entry');
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
          },
          { timeout: 30_000 },
        );
      } finally {
        await gate.$disconnect();
      }
      const statuses = (await Promise.all(pending)).map((response) => response.status).sort();
      expect(statuses).toEqual([200, 409]);
      expect(
        await db(t.app).contentRevision.count({ where: { entryId: page.id, status: 'PUBLISHED' } }),
      ).toBe(1);
    });

    it('PostgreSQL keeps published history immutable and entries undeletable', async () => {
      const page = await createPage();
      const live = await publish(editor, (await saveDraft(editor, page, pageDocument())).body);
      const revision = await db(t.app).contentRevision.findFirstOrThrow({
        where: { entryId: page.id, status: 'PUBLISHED' },
      });
      expect(live.body.published.revision).toBe(revision.revision);
      await expect(
        db(t.app).contentRevision.update({
          where: { id: revision.id },
          data: { document: { title: 'Réécrit' } },
        }),
      ).rejects.toThrow(/immutable/);
      await expect(
        db(t.app).contentRevision.delete({ where: { id: revision.id } }),
      ).rejects.toThrow(/cannot be deleted/);
      await expect(db(t.app).contentEntry.delete({ where: { id: page.id } })).rejects.toThrow(
        /cannot be deleted/,
      );
      await expect(
        db(t.app).contentEntry.update({ where: { id: page.id }, data: { key: '/autre' } }),
      ).rejects.toThrow(/immutable/);
      await expect(
        db(t.app).contentRevision.create({
          data: { entryId: page.id, revision: 1, document: {} },
        }),
      ).rejects.toThrow(/only increase/);
      await expect(
        db(t.app).contentRevision.create({
          data: { entryId: page.id, revision: 9, document: {} },
        }),
      ).rejects.toThrow(/one at a time/);
      await expect(
        db(t.app).contentRevision.create({
          data: { entryId: page.id, revision: 5, document: {}, status: 'PUBLISHED' },
        }),
      ).rejects.toThrow(/created as DRAFT/);
      await expect(
        db(t.app).contentEntry.create({ data: { kind: 'SITE_SETTINGS', key: 'autre' } }),
      ).rejects.toThrow();
      await expect(db(t.app).$executeRawUnsafe('TRUNCATE content_revision')).rejects.toThrow(
        /truncated/,
      );
      // One draft per entry, even around the API.
      await db(t.app).contentRevision.create({
        data: { entryId: page.id, revision: 2, document: {} },
      });
      await expect(
        db(t.app).contentRevision.create({ data: { entryId: page.id, revision: 3, document: {} } }),
      ).rejects.toThrow();
      await expect(
        db(t.app).contentEntry.update({ where: { id: page.id }, data: { lastRevision: 0 } }),
      ).rejects.toThrow(/never reused/);
    });

    it('returns 404 for unknown entries and revisions', async () => {
      expect((await adminApi(editor).get(`/content/entries/${UNKNOWN_ID}`)).status).toBe(404);
      expect(
        (
          await adminApi(editor).post(`/content/entries/${UNKNOWN_ID}/publish`, {
            expectedDraftUpdatedAt: new Date().toISOString(),
          })
        ).status,
      ).toBe(404);
    });
  });
});
