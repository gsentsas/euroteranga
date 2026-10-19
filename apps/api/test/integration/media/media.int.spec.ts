import { createHash, randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { createDatabaseClient } from '@euroteranga/database';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminApi,
  createTestRole,
  staffActor,
  type StaffActor,
} from '../../support/admin-helpers.js';
import { createOpenApiDocument } from '../../../src/openapi.js';
import { db } from '../../support/auth-helpers.js';
import { storedFiles, syntheticPhoto, uploadMedia } from '../../support/media-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

const UNKNOWN_ID = '01900000-0000-7000-8000-000000000000';
const MAX_BYTES = 256 * 1024;
const MAX_PIXELS = 4_000_000;

interface MediaView {
  id: string;
  status: 'ACTIVE' | 'ARCHIVED';
  altText: string;
  caption: string | null;
  credit: string | null;
  focalX: number;
  focalY: number;
  width: number;
  height: number;
  renditions: Array<{ width: number; height: number; bytes: number; path: string }>;
  usages?: Array<{ kind: string; key: string; status: string }>;
}

interface EntryView {
  id: string;
  key: string;
  draft: { revision: number; updatedAt: string } | null;
  published: { revision: number } | null;
}

/**
 * MEDIA-1 public media library: ingestion (decode, re-encode, strip),
 * refusals, permissions, public delivery, CMS references and the
 * archive ↔ publication race.
 */
describe('public media library', () => {
  let t: TestApp;
  let root: string;
  let editor: StaffActor;
  let director: StaffActor;
  let dispatcher: StaffActor;
  let reader: StaffActor;
  let sequence = 0;

  beforeAll(async () => {
    root = `/tmp/euroteranga-integration-media-${process.pid}-${randomBytes(4).toString('hex')}`;
    t = await startTestApp(
      integrationEnv({
        PUBLIC_MEDIA_STORAGE: 'LOCAL',
        PUBLIC_MEDIA_LOCAL_ROOT: root,
        PUBLIC_MEDIA_MAX_BYTES: String(MAX_BYTES),
        PUBLIC_MEDIA_MAX_PIXELS: String(MAX_PIXELS),
      }),
    );
    const readOnly = await createTestRole(t.app, ['ops.access', 'media.read']);
    [editor, director, dispatcher, reader] = await Promise.all([
      staffActor(t.app, ['CONTENT_EDITOR']),
      staffActor(t.app, ['DIRECTOR']),
      staffActor(t.app, ['DISPATCHER']),
      staffActor(t.app, [readOnly]),
    ]);
  });

  afterAll(async () => {
    await t.app.close();
    await rm(root, { recursive: true, force: true });
  });

  const server = () => t.app.getHttpServer();
  const publicGet = (path: string) =>
    request(server()).get(`/v1${path}`).set('Origin', 'http://localhost:3000');

  async function upload(actor: StaffActor = editor, fields?: Record<string, string>) {
    const response = await uploadMedia(t.app, actor, {
      bytes: await syntheticPhoto(),
      ...(fields ? { fields } : {}),
    });
    if (response.status !== 201) throw new Error(`upload: ${response.status} ${response.text}`);
    return response.body as MediaView;
  }

  async function createPage(): Promise<EntryView> {
    const response = await adminApi(editor).post('/content/entries', {
      kind: 'PAGE',
      path: `/media-${Date.now().toString(36)}-${(sequence += 1)}`,
      title: 'Page illustrée',
      description: 'Une page de test qui utilise la médiathèque.',
    });
    if (response.status !== 201) throw new Error(`page: ${response.status} ${response.text}`);
    return response.body as EntryView;
  }

  const pageWith = (blocks: unknown[], socialMediaId?: string) => ({
    title: 'Page illustrée',
    seo: {
      description: 'Une page de test qui utilise la médiathèque.',
      indexable: false,
      ...(socialMediaId ? { socialMediaId } : {}),
    },
    blocks,
  });

  const saveDraft = (entry: EntryView, document: unknown, actor: StaffActor = editor) =>
    adminApi(actor).post(`/content/entries/${entry.id}/draft`, {
      document,
      expectedDraftUpdatedAt: entry.draft?.updatedAt ?? null,
    });

  const publish = (entry: EntryView) =>
    adminApi(editor).post(`/content/entries/${entry.id}/publish`, {
      expectedDraftUpdatedAt: entry.draft!.updatedAt,
    });

  describe('ingestion', () => {
    it('re-encodes a JPEG to WebP renditions without EXIF or GPS and keeps no original', async () => {
      const photo = await sharp(await syntheticPhoto(1200, 800, 'png'))
        .jpeg()
        .withExif({
          IFD0: { Artist: 'Photographe synthétique' },
          IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '14/1 41/1 0/1' },
        })
        .toBuffer();
      expect((await sharp(photo).metadata()).exif).toBeDefined();
      const before = (await storedFiles(root)).length;

      const response = await uploadMedia(t.app, editor, {
        bytes: photo,
        filename: '../../etc/passwd.jpg',
        fields: {
          altText: '  Autocar Euro Teranga au départ de Paris  ',
          caption: 'Départ du soir',
          credit: '',
        },
      });
      expect(response.status).toBe(201);
      const media = response.body as MediaView;
      expect(media).toMatchObject({
        status: 'ACTIVE',
        altText: 'Autocar Euro Teranga au départ de Paris',
        caption: 'Départ du soir',
        credit: null,
        focalX: 50,
        focalY: 50,
        width: 1200,
        height: 800,
      });
      expect(media.renditions.map((rendition) => rendition.width)).toEqual([480, 960, 1200]);
      // Neither the file name nor storage keys are exposed or kept.
      expect(response.text).not.toContain('passwd');
      expect(response.text).not.toContain('public-media/');

      const files = await storedFiles(root);
      expect(files.length - before).toBe(3);
      for (const file of files) {
        // Content-addressed WebP files only: the uploaded JPEG is not stored.
        expect(file.path).toMatch(/\/public-media\/[0-9a-f]{2}\/[0-9a-f]{64}$/);
        expect(createHash('sha256').update(file.data).digest('hex')).toBe(file.path.slice(-64));
        expect(file.data.subarray(8, 12).toString('ascii')).toBe('WEBP');
        expect(file.data.includes(photo.subarray(0, 64))).toBe(false);
      }

      const rendition = await publicGet(`/media/files/${media.id}/960.webp`)
        .buffer(true)
        .parse((res, done) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => done(null, Buffer.concat(chunks)));
        });
      expect(rendition.status).toBe(200);
      expect(rendition.headers).toMatchObject({
        'content-type': 'image/webp',
        'x-content-type-options': 'nosniff',
        'cross-origin-resource-policy': 'cross-origin',
        'cache-control': 'public, max-age=86400',
        'content-disposition': 'inline',
      });
      const meta = await sharp(rendition.body as Buffer).metadata();
      expect(meta).toMatchObject({ format: 'webp', width: 960, height: 640 });
      expect(meta.exif).toBeUndefined();
      expect(meta.xmp).toBeUndefined();

      const etag = rendition.headers.etag as string;
      expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
      const cached = await publicGet(`/media/files/${media.id}/960.webp`).set(
        'If-None-Match',
        etag,
      );
      expect(cached.status).toBe(304);

      const audit = await db(t.app).auditEvent.findFirst({
        where: { action: 'PUBLIC_MEDIA_UPLOADED', resourceId: media.id },
      });
      expect(audit?.actorIdentityId).toBe(editor.id);
    });

    it('accepts PNG and WebP, and refuses disguised, broken, animated, oversized or tiny files', async () => {
      const png = await uploadMedia(t.app, editor, {
        bytes: await syntheticPhoto(640, 480, 'png'),
        contentType: 'image/png',
      });
      expect(png.status).toBe(201);
      const webp = await uploadMedia(t.app, editor, {
        bytes: await syntheticPhoto(640, 480, 'webp'),
        contentType: 'image/webp',
      });
      expect(webp.status).toBe(201);

      const rows = await db(t.app).publicMediaAsset.count();
      const files = (await storedFiles(root)).length;
      const svg = Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><script>alert(1)</script></svg>',
      );
      const gif = await sharp({
        create: { width: 400, height: 400, channels: 3, background: '#ffcc00' },
      })
        .gif()
        .toBuffer();
      const jpeg = await syntheticPhoto(800, 600);
      const frames = await Promise.all(
        ['#123c78', '#ffcc00'].map((background) =>
          sharp({ create: { width: 300, height: 300, channels: 3, background } })
            .png()
            .toBuffer(),
        ),
      );
      const animated = await sharp(frames, { join: { animated: true } })
        .webp()
        .toBuffer();
      const bomb = await sharp({
        create: { width: 2500, height: 2500, channels: 3, background: '#000000' },
      })
        .png({ compressionLevel: 9 })
        .toBuffer();
      const noise = await sharp(randomBytes(600 * 600 * 3), {
        raw: { width: 600, height: 600, channels: 3 },
      })
        .jpeg({ quality: 100 })
        .toBuffer();
      expect(noise.length).toBeGreaterThan(MAX_BYTES);

      const cases: Array<[string, Buffer, string, number, string]> = [
        ['svg named png', svg, 'image/png', 415, 'MEDIA_FORMAT_UNSUPPORTED'],
        ['svg', svg, 'image/svg+xml', 415, 'MEDIA_FORMAT_UNSUPPORTED'],
        ['gif', gif, 'image/gif', 415, 'MEDIA_FORMAT_UNSUPPORTED'],
        ['gif named jpeg', gif, 'image/jpeg', 415, 'MEDIA_FORMAT_UNSUPPORTED'],
        [
          'pdf',
          Buffer.from('%PDF-1.7\n%%EOF\n'),
          'application/pdf',
          415,
          'MEDIA_FORMAT_UNSUPPORTED',
        ],
        [
          'signature then garbage',
          Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(4096, 7)]),
          'image/jpeg',
          422,
          'MEDIA_IMAGE_INVALID',
        ],
        [
          'truncated',
          jpeg.subarray(0, Math.floor(jpeg.length / 3)),
          'image/jpeg',
          422,
          'MEDIA_IMAGE_INVALID',
        ],
        ['animated', animated, 'image/webp', 422, 'MEDIA_IMAGE_ANIMATED'],
        ['bomb', bomb, 'image/png', 422, 'MEDIA_IMAGE_TOO_LARGE'],
        ['tiny', await syntheticPhoto(150, 600, 'png'), 'image/png', 422, 'MEDIA_IMAGE_TOO_SMALL'],
        ['empty', Buffer.alloc(0), 'image/jpeg', 400, 'MEDIA_UPLOAD_EMPTY'],
        ['oversized', noise, 'image/jpeg', 413, 'MEDIA_UPLOAD_TOO_LARGE'],
      ];
      for (const [label, bytes, contentType, status, code] of cases) {
        const response = await uploadMedia(t.app, editor, { bytes, contentType });
        expect({ label, status: response.status, code: response.body.code }).toEqual({
          label,
          status,
          code,
        });
      }

      // Shape of the form: one "file", the describing fields, nothing else.
      const shape = [];
      for (const fields of [
        { caption: 'Sans texte alternatif' },
        { altText: ' ' },
        { altText: 'x'.repeat(251) },
        { altText: 'Image', focalX: '101' },
        { altText: 'Image', role: 'admin' },
      ]) {
        shape.push(await uploadMedia(t.app, editor, { bytes: jpeg, fields }));
      }
      expect(shape.map((response) => [response.status, response.body.code])).toEqual([
        [400, 'VALIDATION_FAILED'],
        [400, 'VALIDATION_FAILED'],
        [400, 'VALIDATION_FAILED'],
        [400, 'VALIDATION_FAILED'],
        [400, 'MEDIA_UPLOAD_MALFORMED'],
      ]);
      const csrf = await editor.csrf();
      const twoFiles = await request(server())
        .post('/v1/admin/media')
        .set('Origin', editor.http.origin)
        .set('X-Forwarded-For', editor.http.ip)
        .set('Cookie', editor.cookie)
        .set('X-CSRF-Token', csrf)
        .field('altText', 'Deux fichiers')
        .attach('file', jpeg, { filename: 'a.jpg', contentType: 'image/jpeg' })
        .attach('file', jpeg, { filename: 'b.jpg', contentType: 'image/jpeg' });
      expect(twoFiles.body.code).toBe('MEDIA_UPLOAD_MALFORMED');
      const json = await adminApi(editor).post('/media', { altText: 'Pas de fichier' });
      expect(json.status).toBe(400);

      // Nothing refused was stored.
      expect(await db(t.app).publicMediaAsset.count()).toBe(rows);
      expect((await storedFiles(root)).length).toBe(files);
    });
  });

  describe('authorization', () => {
    it('keeps media apart from operations and requires media.manage and CSRF to change it', async () => {
      const media = await upload();
      expect((await adminApi(dispatcher).get('/media')).status).toBe(403);
      expect((await adminApi(dispatcher).get(`/media/${media.id}`)).status).toBe(403);
      const denied = await uploadMedia(t.app, dispatcher, { bytes: await syntheticPhoto() });
      expect(denied.status).toBe(403);

      expect((await adminApi(reader).get('/media')).status).toBe(200);
      expect((await adminApi(reader).get(`/media/${media.id}`)).status).toBe(200);
      expect((await uploadMedia(t.app, reader, { bytes: await syntheticPhoto() })).status).toBe(
        403,
      );
      expect((await adminApi(reader).post(`/media/${media.id}`, { altText: 'Non' })).status).toBe(
        403,
      );
      expect(
        (await adminApi(reader).post(`/media/${media.id}/archive`, { reason: 'Non autorisé' }))
          .status,
      ).toBe(403);

      const noCsrf = await uploadMedia(t.app, editor, {
        bytes: await syntheticPhoto(),
        csrf: null,
      });
      expect(noCsrf.status).toBe(403);
      expect(
        (await adminApi(editor).post(`/media/${media.id}`, { altText: 'Non' }, { csrf: null }))
          .status,
      ).toBe(403);
      expect(
        (
          await adminApi(editor).post(
            `/media/${media.id}/archive`,
            { reason: 'Sans CSRF' },
            { csrf: null },
          )
        ).status,
      ).toBe(403);
      expect((await request(server()).get('/v1/admin/media')).status).toBe(401);

      // Directors manage media too; admin views name the staff, public ones never do.
      expect((await upload(director)).status).toBe('ACTIVE');
      const detail = await adminApi(director).get(`/media/${media.id}`);
      expect(detail.body.createdBy).toMatchObject({ id: editor.id, email: editor.email });
      const listed = await publicGet(`/media?ids=${media.id}`);
      expect(listed.text).not.toContain(editor.email);
      expect(listed.text).not.toContain('createdBy');
    });
  });

  describe('library', () => {
    it('refuses the same active file twice, describes images and records replacements', async () => {
      const bytes = await syntheticPhoto();
      const first = await uploadMedia(t.app, editor, { bytes });
      expect(first.status).toBe(201);
      const again = await uploadMedia(t.app, director, { bytes });
      expect(again.status).toBe(409);
      expect(again.body).toMatchObject({
        code: 'MEDIA_DUPLICATE',
        details: { mediaId: first.body.id },
      });

      const id = first.body.id as string;
      const updated = await adminApi(editor).post(`/media/${id}`, {
        altText: 'Autocar à l’arrêt',
        caption: 'Gare routière',
        credit: 'Euro Teranga',
        focalX: 30,
        focalY: 70,
      });
      expect(updated.status).toBe(200);
      expect(updated.body).toMatchObject({
        altText: 'Autocar à l’arrêt',
        caption: 'Gare routière',
        credit: 'Euro Teranga',
        focalX: 30,
        focalY: 70,
      });
      const cleared = await adminApi(editor).post(`/media/${id}`, { caption: null, credit: '' });
      expect(cleared.body).toMatchObject({
        caption: null,
        credit: null,
        altText: 'Autocar à l’arrêt',
      });
      for (const body of [
        {},
        { altText: '' },
        { focalX: 101 },
        { focalY: -1 },
        { focalX: 12.5 },
        { width: 10 },
      ]) {
        expect(
          (await adminApi(editor).post(`/media/${id}`, body)).status,
          JSON.stringify(body),
        ).toBe(400);
      }
      const audit = await db(t.app).auditEvent.findMany({
        where: { action: 'PUBLIC_MEDIA_UPDATED', resourceId: id },
        orderBy: { occurredAt: 'asc' },
      });
      expect(audit).toHaveLength(2);
      expect(audit[0]!.before).toMatchObject({ altText: 'Autocar sur la route', focalX: 50 });
      expect(audit[0]!.after).toMatchObject({ altText: 'Autocar à l’arrêt', focalX: 30 });

      // A replacement is a new, separate image; the old one is untouched.
      const replacement = await uploadMedia(t.app, editor, {
        bytes: await syntheticPhoto(),
        fields: { altText: 'Autocar à l’arrêt', focalX: '30', focalY: '70', replaces: id },
      });
      expect(replacement.status).toBe(201);
      expect(replacement.body).toMatchObject({ focalX: 30, focalY: 70 });
      expect(replacement.body.id).not.toBe(id);
      const trace = await db(t.app).auditEvent.findFirst({
        where: { action: 'PUBLIC_MEDIA_UPLOADED', resourceId: replacement.body.id },
      });
      expect(trace?.metadata).toMatchObject({ replacesMediaId: id });
      expect((await adminApi(editor).get(`/media/${id}`)).body.status).toBe('ACTIVE');
      const unknown = await uploadMedia(t.app, editor, {
        bytes: await syntheticPhoto(),
        fields: { altText: 'Remplace rien', replaces: UNKNOWN_ID },
      });
      expect(unknown.status).toBe(400);

      // Newest first, keyset pagination.
      const page = await adminApi(editor).get('/media?limit=2');
      expect(page.body.storageEnabled).toBe(true);
      expect(page.body.items).toHaveLength(2);
      const next = await adminApi(editor).get(`/media?limit=2&cursor=${page.body.nextCursor}`);
      expect(next.body.items[0].id < page.body.items[1].id).toBe(true);
      expect((await adminApi(editor).get('/media?limit=500')).status).toBe(400);
      expect((await adminApi(editor).get(`/media/${UNKNOWN_ID}`)).status).toBe(404);
    });

    it('serves active images only, through bounded public reads', async () => {
      const media = await upload();
      const listed = await publicGet(`/media?ids=${media.id},${UNKNOWN_ID},${media.id}`);
      expect(listed.status).toBe(200);
      expect(listed.headers['cache-control']).toBe('public, max-age=60');
      expect(listed.body.items).toHaveLength(1);
      expect(listed.body.items[0]).toEqual({
        id: media.id,
        altText: media.altText,
        caption: null,
        credit: null,
        width: 1200,
        height: 800,
        focalX: 50,
        focalY: 50,
        renditions: media.renditions.map(({ width, height, path }) => ({ width, height, path })),
      });
      const tooMany = Array.from(
        { length: 51 },
        (_, index) => `01900000-0000-7000-8000-${String(index).padStart(12, '0')}`,
      );
      for (const query of ['', '?ids=', '?ids=nope', `?ids=${tooMany.join(',')}`, '?id=1']) {
        expect((await publicGet(`/media${query}`)).status, query).toBe(400);
      }
      for (const path of [
        `/media/files/${media.id}/961.webp`,
        `/media/files/${media.id}/960.png`,
        `/media/files/${media.id}/0960.webp`,
        `/media/files/${media.id}/..%2F..%2Fetc%2Fpasswd`,
        `/media/files/${UNKNOWN_ID}/960.webp`,
        '/media/files/not-a-uuid/960.webp',
      ]) {
        expect([400, 404], path).toContain((await publicGet(path)).status);
      }
    });
  });

  describe('contents', () => {
    it('lets pages use active images only, refuses archiving a used image and keeps history', async () => {
      const media = await upload();
      const other = await upload();
      const page = await createPage();

      const unknown = await saveDraft(
        page,
        pageWith([{ type: 'image', mediaId: UNKNOWN_ID }], UNKNOWN_ID),
      );
      expect(unknown.status).toBe(422);
      expect(unknown.body.code).toBe('CONTENT_DOCUMENT_INVALID');
      expect(unknown.body.details.issues.map((issue: { path: string }) => issue.path)).toEqual([
        'seo.socialMediaId',
        'blocks.0.mediaId',
      ]);

      // The social image is search metadata: seo.manage (DIRECTOR) sets it.
      const saved = await saveDraft(
        page,
        pageWith(
          [
            { type: 'hero', title: 'Paris ↔ Dakar', mediaId: media.id },
            { type: 'gallery', items: [{ mediaId: other.id }, { mediaId: media.id }] },
          ],
          other.id,
        ),
        director,
      );
      expect(saved.status).toBe(200);

      // A draft is enough to protect the image.
      const inUse = await adminApi(editor).post(`/media/${media.id}/archive`, {
        reason: 'Plus utilisée',
      });
      expect(inUse.status).toBe(409);
      expect(inUse.body).toMatchObject({
        code: 'MEDIA_IN_USE',
        details: {
          usages: [{ kind: 'PAGE', key: page.key, status: 'DRAFT', entryArchived: false }],
        },
      });
      const detail = await adminApi(editor).get(`/media/${media.id}`);
      expect(detail.body.usages).toEqual([
        { kind: 'PAGE', key: page.key, status: 'DRAFT', entryArchived: false },
      ]);

      const live = await publish(saved.body as EntryView);
      expect(live.status).toBe(200);
      const stillInUse = await adminApi(editor).post(`/media/${media.id}/archive`, {
        reason: 'Plus utilisée',
      });
      expect(stillInUse.body.details.usages).toEqual([
        { kind: 'PAGE', key: page.key, status: 'PUBLISHED', entryArchived: false },
      ]);

      // Version 2 no longer shows the first image: it can then be archived.
      const v2 = await saveDraft(
        live.body as EntryView,
        pageWith([{ type: 'image', mediaId: other.id }]),
        director,
      );
      expect((await publish(v2.body as EntryView)).status).toBe(200);
      const archived = await adminApi(editor).post(`/media/${media.id}/archive`, {
        reason: '  Remplacée par une photo récente  ',
      });
      expect(archived.status).toBe(200);
      expect(archived.body).toMatchObject({
        status: 'ARCHIVED',
        archiveReason: 'Remplacée par une photo récente',
      });
      const audit = await db(t.app).auditEvent.findFirst({
        where: { action: 'PUBLIC_MEDIA_ARCHIVED', resourceId: media.id },
      });
      expect(audit?.metadata).toMatchObject({ reason: 'Remplacée par une photo récente' });

      // Archived: no longer served, no longer usable, frozen for good.
      expect((await publicGet(`/media?ids=${media.id}`)).body.items).toEqual([]);
      expect((await publicGet(`/media/files/${media.id}/480.webp`)).status).toBe(404);
      const reuse = await saveDraft(
        (await adminApi(editor).get(`/content/entries/${page.id}`)).body as EntryView,
        pageWith([
          {
            type: 'textImage',
            title: 'Retour',
            body: [{ kind: 'paragraph', spans: [{ text: 'Une ancienne photo.' }] }],
            mediaId: media.id,
          },
        ]),
      );
      expect(reuse.status).toBe(422);
      expect(reuse.body.details.issues).toEqual([
        { path: 'blocks.0.mediaId', message: 'Image introuvable ou archivée dans la médiathèque.' },
      ]);
      // Revision 1 (the first publication) shows the archived image.
      const restore = await adminApi(editor).post(`/content/entries/${page.id}/restore`, {
        revision: 1,
      });
      expect(restore.status).toBe(422);
      expect(restore.body.code).toBe('CONTENT_DOCUMENT_INVALID');
      // History keeps the reference: nothing was rewritten.
      const history = await adminApi(editor).get(`/content/entries/${page.id}/revisions/1`);
      expect(JSON.stringify(history.body.document)).toContain(media.id);

      expect(
        (await adminApi(editor).post(`/media/${media.id}`, { altText: 'Non' })).body.code,
      ).toBe('MEDIA_ARCHIVED');
      expect(
        (await adminApi(editor).post(`/media/${media.id}/archive`, { reason: 'Encore' })).body.code,
      ).toBe('MEDIA_ARCHIVED');
      expect((await adminApi(editor).post(`/media/${media.id}/restore`, {})).status).toBe(404);
      expect((await adminApi(editor).get(`/media?status=ARCHIVED`)).body.items[0].id).toBe(
        media.id,
      );
    });

    it('checks images again at publication and restoration time', async () => {
      const media = await upload();
      const page = await createPage();
      const saved = await saveDraft(page, pageWith([{ type: 'image', mediaId: media.id }]));
      expect(saved.status).toBe(200);
      // An image archived outside the API (or before a model change) is
      // still caught when the draft is published.
      await db(t.app).$executeRaw`
        UPDATE "public_media_asset"
        SET "status" = 'ARCHIVED', "archived_at" = now(), "archive_reason" = 'Hors API'
        WHERE "id" = ${media.id}::uuid`;
      const published = await publish(saved.body as EntryView);
      expect(published.status).toBe(422);
      expect(published.body.details.issues).toEqual([
        { path: 'blocks.0.mediaId', message: 'Image introuvable ou archivée dans la médiathèque.' },
      ]);
      expect((await adminApi(editor).get(`/content/entries/${page.id}`)).body.published).toBeNull();
    });

    it('keeps an image of an archived page protected, since the page can be unarchived', async () => {
      const media = await upload();
      const page = await createPage();
      const saved = await saveDraft(page, pageWith([{ type: 'image', mediaId: media.id }]));
      expect((await publish(saved.body as EntryView)).status).toBe(200);
      const archivedPage = await adminApi(editor).post(`/content/entries/${page.id}/archive`, {
        reason: 'Page retirée du site',
      });
      expect(archivedPage.status).toBe(200);
      const refused = await adminApi(editor).post(`/media/${media.id}/archive`, {
        reason: 'Plus utilisée',
      });
      expect(refused.status).toBe(409);
      expect(refused.body.details.usages).toEqual([
        { kind: 'PAGE', key: page.key, status: 'PUBLISHED', entryArchived: true },
      ]);
    });

    it('lets an archived file come back only as a new image', async () => {
      const bytes = await syntheticPhoto();
      const first = await uploadMedia(t.app, editor, { bytes });
      const archived = await adminApi(editor).post(`/media/${first.body.id}/archive`, {
        reason: 'Archivée par erreur',
      });
      expect(archived.status).toBe(200);
      const again = await uploadMedia(t.app, editor, { bytes });
      expect(again.status).toBe(201);
      expect(again.body.id).not.toBe(first.body.id);
      // Same bytes, same renditions: the stored files are shared, not copied.
      const keys = await db(t.app).publicMediaRendition.findMany({
        where: { assetId: { in: [first.body.id, again.body.id] } },
        select: { storageKey: true },
      });
      expect(new Set(keys.map((key) => key.storageKey)).size).toBe(keys.length / 2);
      expect((await publicGet(`/media/files/${again.body.id}/480.webp`)).status).toBe(200);
      expect((await publicGet(`/media/files/${first.body.id}/480.webp`)).status).toBe(404);
    });
  });

  describe('archive and publication race', () => {
    /** Waits until a backend blocks on a row lock of the media table. */
    async function waitForLockWait(mode: 'FOR UPDATE' | 'FOR SHARE') {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const rows = await db(t.app).$queryRaw<Array<{ count: bigint }>>`
          SELECT count(*) AS "count" FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND strpos(query, 'FROM "public_media_asset"') > 0
            AND strpos(query, ${mode}) > 0`;
        if (Number(rows[0]?.count ?? 0) > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`no backend waited on a media row lock (${mode})`);
    }

    it('an archive waits for a save that holds the image, then sees it in use', async () => {
      const media = await upload();
      const page = await createPage();
      const other = createDatabaseClient({ databaseUrl: process.env.DATABASE_URL! });
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const holding = new Promise<void>((resolve) => (locked = resolve));
      try {
        // What a content save does: lock the active image, then write the draft.
        const save = other.$transaction(
          async (tx) => {
            await tx.$queryRaw`
              SELECT "id" FROM "public_media_asset"
              WHERE "id" = ${media.id}::uuid AND "status" = 'ACTIVE' FOR SHARE`;
            locked();
            await released;
            await tx.$executeRaw`
              UPDATE "content_revision"
              SET "document" = jsonb_set("document", '{seo,socialMediaId}', to_jsonb(${media.id}::text))
              WHERE "entry_id" = ${page.id}::uuid AND "status" = 'DRAFT'`;
          },
          { timeout: 20_000 },
        );
        await holding;
        const archive = adminApi(editor).post(`/media/${media.id}/archive`, {
          reason: 'Course avec une sauvegarde',
        });
        await waitForLockWait('FOR UPDATE');
        release();
        await save;
        const response = await archive;
        expect(response.status).toBe(409);
        expect(response.body.code).toBe('MEDIA_IN_USE');
      } finally {
        release();
        await other.$disconnect();
      }
    });

    it('a save waits for an archive in progress, then refuses the archived image', async () => {
      const media = await upload();
      const page = await createPage();
      const other = createDatabaseClient({ databaseUrl: process.env.DATABASE_URL! });
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const holding = new Promise<void>((resolve) => (locked = resolve));
      try {
        const archive = other.$transaction(
          async (tx) => {
            await tx.$queryRaw`
              SELECT "id" FROM "public_media_asset" WHERE "id" = ${media.id}::uuid FOR UPDATE`;
            await tx.$executeRaw`
              UPDATE "public_media_asset"
              SET "status" = 'ARCHIVED', "archived_at" = now(), "archive_reason" = 'Course'
              WHERE "id" = ${media.id}::uuid`;
            locked();
            await released;
          },
          { timeout: 20_000 },
        );
        await holding;
        const save = saveDraft(page, pageWith([{ type: 'image', mediaId: media.id }]));
        await waitForLockWait('FOR SHARE');
        release();
        await archive;
        const response = await save;
        expect(response.status).toBe(422);
        expect(response.body.details.issues[0].path).toBe('blocks.0.mediaId');
      } finally {
        release();
        await other.$disconnect();
      }
    });
  });

  describe('database invariants', () => {
    it('never deletes or rewrites an image, freezes archived ones and checks stored files', async () => {
      const media = await upload();
      const database = db(t.app);
      const refused = async (statement: Promise<unknown>) => {
        await expect(statement).rejects.toThrow();
      };
      await refused(
        database.$executeRaw`DELETE FROM "public_media_asset" WHERE "id" = ${media.id}::uuid`,
      );
      await refused(
        database.$executeRaw`UPDATE "public_media_asset" SET "width" = 10 WHERE "id" = ${media.id}::uuid`,
      );
      await refused(
        database.$executeRaw`UPDATE "public_media_asset" SET "source_sha256" = repeat('0', 64) WHERE "id" = ${media.id}::uuid`,
      );
      await refused(
        database.$executeRaw`UPDATE "public_media_asset" SET "alt_text" = '  ' WHERE "id" = ${media.id}::uuid`,
      );
      await refused(
        database.$executeRaw`UPDATE "public_media_asset" SET "focal_x" = 120 WHERE "id" = ${media.id}::uuid`,
      );
      await refused(
        database.$executeRaw`UPDATE "public_media_asset" SET "status" = 'ARCHIVED' WHERE "id" = ${media.id}::uuid`,
      );
      await refused(
        database.$executeRaw`UPDATE "public_media_rendition" SET "bytes" = 1 WHERE "asset_id" = ${media.id}::uuid`,
      );
      await refused(
        database.$executeRaw`DELETE FROM "public_media_rendition" WHERE "asset_id" = ${media.id}::uuid`,
      );
      await refused(
        database.$executeRaw`
          INSERT INTO "public_media_rendition"
            ("id", "asset_id", "width", "height", "format", "bytes", "sha256", "storage_key")
          VALUES (gen_random_uuid(), ${media.id}::uuid, 100, 100, 'webp', 10, repeat('a', 64),
                  '../../etc/passwd')`,
      );
      const source = await database.publicMediaAsset.findUniqueOrThrow({
        where: { id: media.id },
        select: { sourceSha256: true },
      });
      await refused(
        database.$executeRaw`
          INSERT INTO "public_media_asset"
            ("id", "alt_text", "source_format", "source_sha256", "source_bytes", "width", "height", "updated_at")
          VALUES (gen_random_uuid(), 'Copie', 'jpeg', ${source.sourceSha256}, 10, 300, 300, now())`,
      );

      await database.$executeRaw`
        UPDATE "public_media_asset"
        SET "status" = 'ARCHIVED', "archived_at" = now(), "archive_reason" = 'Test'
        WHERE "id" = ${media.id}::uuid`;
      await refused(
        database.$executeRaw`UPDATE "public_media_asset" SET "status" = 'ACTIVE', "archived_at" = NULL, "archive_reason" = NULL WHERE "id" = ${media.id}::uuid`,
      );
      await refused(
        database.$executeRaw`UPDATE "public_media_asset" SET "caption" = 'Après coup' WHERE "id" = ${media.id}::uuid`,
      );
    });
  });
});

describe('public media library, OpenAPI', () => {
  it('documents the media endpoints, the multipart upload and no restoration', async () => {
    const { app } = await startTestApp(integrationEnv());
    try {
      const document = createOpenApiDocument(app);
      const paths = Object.keys(document.paths);
      expect(paths).toEqual(
        expect.arrayContaining([
          '/v1/admin/media',
          '/v1/admin/media/{id}',
          '/v1/admin/media/{id}/archive',
          '/v1/media',
          '/v1/media/files/{id}/{file}',
        ]),
      );
      expect(paths.filter((path) => path.includes('/media') && path.endsWith('/restore'))).toEqual(
        [],
      );
      const upload = document.paths['/v1/admin/media']?.post;
      const form = upload?.requestBody as
        | { content: Record<string, { schema: { properties: Record<string, unknown> } }> }
        | undefined;
      expect(form?.content['multipart/form-data']?.schema.properties).toMatchObject({
        file: { type: 'string', format: 'binary' },
        altText: { type: 'string', maxLength: 250 },
      });
      expect(
        Object.keys(document.paths['/v1/media/files/{id}/{file}']?.get?.responses ?? {}),
      ).toEqual(expect.arrayContaining(['200', '304', '404']));
    } finally {
      await app.close();
    }
  });
});

describe('public media library, disabled storage', () => {
  let t: TestApp;
  let editor: StaffActor;

  beforeAll(async () => {
    t = await startTestApp(integrationEnv());
    editor = await staffActor(t.app, ['CONTENT_EDITOR']);
  });

  afterAll(async () => {
    await t.app.close();
  });

  it('lists the library but refuses uploads while storage is disabled', async () => {
    const list = await adminApi(editor).get('/media');
    expect(list.status).toBe(200);
    expect(list.body.storageEnabled).toBe(false);
    const response = await uploadMedia(t.app, editor, { bytes: await syntheticPhoto() });
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('MEDIA_STORAGE_DISABLED');
  });
});
