import { createHash } from 'node:crypto';
import {
  DEFAULT_NAVIGATION,
  DEFAULT_SITE_SETTINGS,
  SINGLETON_KEYS,
  documentSchemaOf,
  mediaReferencesOf,
  pageDocumentSchema,
  type ContentKind,
  type PageDocument,
} from '@euroteranga/content';
import { Prisma, type DatabaseTransaction } from '@euroteranga/database';
import { Injectable } from '@nestjs/common';
import type { z } from 'zod';
import { PublicApiError } from '../auth/http/public-api-error.js';
import type { AuthPrincipal } from '../auth/session/auth-principal.js';
import { AuditService } from '../authorization/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type {
  contentArchiveSchema,
  contentCreateSchema,
  contentDiscardSchema,
  contentDraftSchema,
  contentListQuerySchema,
  contentPublishSchema,
  contentRestoreSchema,
} from './content.dto.js';
import { ContentErrors, type ContentIssue } from './content.errors.js';

type ListQuery = z.infer<typeof contentListQuerySchema>;
type CreateInput = z.infer<typeof contentCreateSchema>;
type DraftInput = z.infer<typeof contentDraftSchema>;
type PublishInput = z.infer<typeof contentPublishSchema>;
type DiscardInput = z.infer<typeof contentDiscardSchema>;
type RestoreInput = z.infer<typeof contentRestoreSchema>;
type ArchiveInput = z.infer<typeof contentArchiveSchema>;

/** Who edits, and whether they may change the search metadata of a page. */
export interface ContentCaller {
  actor: AuthPrincipal;
  canManageSeo: boolean;
}

const RESOURCE = 'content_entry';
const HISTORY_SIZE = 30;
const SITEMAP_LIMIT = 1000;

const identity = { select: { id: true, email: true } } as const;
const revisionInclude = { author: identity, publishedBy: identity } as const;

type RevisionRow = Prisma.ContentRevisionGetPayload<{ include: typeof revisionInclude }>;

function revisionSummary(row: RevisionRow) {
  return {
    id: row.id,
    revision: row.revision,
    status: row.status,
    note: row.note,
    basedOnRevision: row.basedOnRevision,
    author: row.author,
    publishedAt: row.publishedAt,
    publishedBy: row.publishedBy,
    supersededAt: row.supersededAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function revisionView(row: RevisionRow) {
  return { ...revisionSummary(row), document: row.document };
}

/** Stable JSON (sorted keys): PostgreSQL jsonb does not keep key order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(document: unknown): string {
  return createHash('sha256').update(canonicalJson(document)).digest('hex');
}

/** Validates against the content model of the kind; returns the normalized document. */
function validate(kind: ContentKind, document: unknown): Record<string, unknown> {
  const result = documentSchemaOf(kind).safeParse(document);
  if (!result.success) {
    const issues: ContentIssue[] = result.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.') || '(document)',
      message: issue.message,
    }));
    throw ContentErrors.documentInvalid(issues);
  }
  return result.data as Record<string, unknown>;
}

/**
 * MEDIA-1: every image a page references must be an active media asset.
 * FOR SHARE serializes with an archive (FOR UPDATE), which in turn refuses
 * an image still referenced by a draft or live revision.
 */
async function assertMediaUsable(
  tx: DatabaseTransaction,
  kind: ContentKind,
  document: Record<string, unknown>,
): Promise<void> {
  if (kind !== 'PAGE') return;
  const references = mediaReferencesOf(document as PageDocument);
  if (references.length === 0) return;
  const ids = [...new Set(references.map((reference) => reference.mediaId))];
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"::text AS "id" FROM "public_media_asset"
    WHERE "id" = ANY(${ids}::uuid[]) AND "status" = 'ACTIVE'
    FOR SHARE`;
  const active = new Set(rows.map((row) => row.id));
  const missing = references.filter((reference) => !active.has(reference.mediaId));
  if (missing.length > 0) {
    throw ContentErrors.documentInvalid(
      missing.map((reference) => ({
        path: reference.path,
        message: 'Image introuvable ou archivée dans la médiathèque.',
      })),
    );
  }
}

/** Search metadata of a page document, normalized for comparison (null for singletons). */
function seoOf(kind: ContentKind, document: unknown): string | null {
  if (kind !== 'PAGE') return null;
  const parsed = pageDocumentSchema.safeParse(document);
  const seo = parsed.success
    ? parsed.data.seo
    : ((document as { seo?: unknown } | null)?.seo ?? null);
  return canonicalJson(seo);
}

function asJson(document: Record<string, unknown>): Prisma.InputJsonValue {
  return document as Prisma.InputJsonValue;
}

/**
 * A unique violation can only come from a concurrent creation of the same
 * path (entry mutations are serialized by the entry row lock).
 */
function translateDatabaseError(error: unknown): never {
  if (error instanceof PublicApiError) throw error;
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    throw ContentErrors.pathTaken();
  }
  throw error;
}

async function mutation<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    return translateDatabaseError(error);
  }
}

interface LockedEntry {
  id: string;
  kind: ContentKind;
  key: string;
  archivedAt: Date | null;
}

/** Every mutation of an entry starts by locking its row: one decision at a time. */
async function lockEntry(tx: DatabaseTransaction, id: string): Promise<LockedEntry> {
  const rows = await tx.$queryRaw<
    Array<{ id: string; kind: ContentKind; key: string; archived_at: Date | null }>
  >`SELECT "id", "kind", "key", "archived_at" FROM "content_entry" WHERE "id" = ${id}::uuid FOR UPDATE`;
  const row = rows[0];
  if (!row) throw ContentErrors.entryNotFound();
  return { id: row.id, kind: row.kind, key: row.key, archivedAt: row.archived_at };
}

async function currentRevisions(tx: DatabaseTransaction, entryId: string) {
  const rows = await tx.contentRevision.findMany({
    where: { entryId, status: { in: ['DRAFT', 'PUBLISHED'] } },
    include: revisionInclude,
  });
  return {
    draft: rows.find((row) => row.status === 'DRAFT') ?? null,
    published: rows.find((row) => row.status === 'PUBLISHED') ?? null,
  };
}

/** The entry row is already locked: its counter is the authority (numbers are never reused). */
async function nextRevision(tx: DatabaseTransaction, entryId: string): Promise<number> {
  const entry = await tx.contentEntry.findUniqueOrThrow({
    where: { id: entryId },
    select: { lastRevision: true },
  });
  return entry.lastRevision + 1;
}

/** The caller must have seen exactly the current draft (or no draft). */
function assertExpectedDraft(draft: { updatedAt: Date } | null, expected: string | null): void {
  if (expected === null) {
    if (draft) throw ContentErrors.draftConflict();
    return;
  }
  if (!draft || draft.updatedAt.getTime() !== new Date(expected).getTime()) {
    throw ContentErrors.draftConflict();
  }
}

/**
 * CMS-1 business authority for the public website content: pages, site
 * settings and navigation, with an editable draft, one published revision
 * and an immutable history. Every mutation locks the entry and writes its
 * audit event in the same transaction.
 */
@Injectable()
export class ContentService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  // -- reads (STAFF) --------------------------------------------------------

  async list(query: ListQuery) {
    const rows = await this.database.client.contentEntry.findMany({
      take: query.limit + 1,
      where: {
        ...(query.kind ? { kind: query.kind } : {}),
        ...(query.cursor ? { id: { lt: query.cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      include: {
        revisions: { where: { status: { in: ['DRAFT', 'PUBLISHED'] } }, include: revisionInclude },
      },
    });
    const items = rows.slice(0, query.limit).map((row) => {
      const draft = row.revisions.find((revision) => revision.status === 'DRAFT') ?? null;
      const published = row.revisions.find((revision) => revision.status === 'PUBLISHED') ?? null;
      const latest = (draft ?? published)?.document as { title?: unknown } | undefined;
      return {
        id: row.id,
        kind: row.kind,
        key: row.key,
        title: typeof latest?.title === 'string' ? latest.title : null,
        archivedAt: row.archivedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        draft: draft ? revisionSummary(draft) : null,
        published: published ? revisionSummary(published) : null,
      };
    });
    return {
      items,
      nextCursor: rows.length > query.limit ? (items.at(-1)?.id ?? null) : null,
    };
  }

  async entry(id: string) {
    const entry = await this.database.client.contentEntry.findUnique({ where: { id } });
    if (!entry) throw ContentErrors.entryNotFound();
    const revisions = await this.database.client.contentRevision.findMany({
      where: { entryId: id },
      orderBy: { revision: 'desc' },
      take: HISTORY_SIZE,
      include: revisionInclude,
    });
    const draft = revisions.find((revision) => revision.status === 'DRAFT');
    const published = revisions.find((revision) => revision.status === 'PUBLISHED');
    return {
      ...entry,
      draft: draft ? revisionView(draft) : null,
      published: published ? revisionView(published) : null,
      history: revisions.map(revisionSummary),
    };
  }

  async revision(id: string, revision: number) {
    const row = await this.database.client.contentRevision.findUnique({
      where: { entryId_revision: { entryId: id, revision } },
      include: revisionInclude,
    });
    if (!row) throw ContentErrors.revisionNotFound();
    return revisionView(row);
  }

  // -- mutations (STAFF) ----------------------------------------------------

  create(input: CreateInput, actor: AuthPrincipal) {
    return mutation(() =>
      this.database.client.$transaction(async (tx) => {
        const kind: ContentKind = input.kind;
        const key = input.kind === 'PAGE' ? input.path : SINGLETON_KEYS[input.kind];
        const existing = await tx.contentEntry.findUnique({ where: { kind_key: { kind, key } } });
        if (existing) {
          throw input.kind === 'PAGE' ? ContentErrors.pathTaken() : ContentErrors.singletonExists();
        }
        const document =
          input.kind === 'PAGE'
            ? validate('PAGE', {
                title: input.title,
                // A new page stays out of search engines until seo.manage opens it.
                seo: { description: input.description, indexable: false },
                blocks: [],
              })
            : validate(
                kind,
                input.kind === 'SITE_SETTINGS' ? DEFAULT_SITE_SETTINGS : DEFAULT_NAVIGATION,
              );
        const entry = await tx.contentEntry.create({ data: { kind, key } });
        const draft = await tx.contentRevision.create({
          data: {
            entryId: entry.id,
            revision: 1,
            document: asJson(document),
            authorIdentityId: actor.identityId,
          },
        });
        await this.audit.record(
          {
            actor,
            action: 'CONTENT_ENTRY_CREATED',
            resourceType: RESOURCE,
            resourceId: entry.id,
            after: { kind, key, revision: draft.revision, fingerprint: fingerprint(document) },
          },
          tx,
        );
        return entry.id;
      }),
    ).then((id) => this.entry(id));
  }

  saveDraft(id: string, input: DraftInput, caller: ContentCaller) {
    return mutation(() =>
      this.database.client.$transaction(async (tx) => {
        const entry = await lockEntry(tx, id);
        const { draft, published } = await currentRevisions(tx, id);
        assertExpectedDraft(draft, input.expectedDraftUpdatedAt);
        const document = validate(entry.kind, input.document);
        await assertMediaUsable(tx, entry.kind, document);
        const base = draft ?? published;
        if (
          base &&
          !caller.canManageSeo &&
          seoOf(entry.kind, base.document) !== seoOf(entry.kind, document)
        ) {
          throw ContentErrors.seoPermissionRequired();
        }

        const saved = draft
          ? await tx.contentRevision.update({
              where: { id: draft.id },
              data: {
                document: asJson(document),
                note: input.note ?? draft.note,
                authorIdentityId: caller.actor.identityId,
              },
            })
          : await tx.contentRevision.create({
              data: {
                entryId: id,
                revision: await nextRevision(tx, id),
                document: asJson(document),
                note: input.note ?? null,
                basedOnRevision: published?.revision ?? null,
                authorIdentityId: caller.actor.identityId,
              },
            });
        await tx.contentEntry.update({ where: { id }, data: { updatedAt: new Date() } });
        await this.audit.record(
          {
            actor: caller.actor,
            action: 'CONTENT_DRAFT_SAVED',
            resourceType: RESOURCE,
            resourceId: id,
            ...(draft
              ? { before: { revision: draft.revision, fingerprint: fingerprint(draft.document) } }
              : {}),
            after: { revision: saved.revision, fingerprint: fingerprint(document) },
            metadata: {
              kind: entry.kind,
              key: entry.key,
              ...(input.note ? { note: input.note } : {}),
            },
          },
          tx,
        );
      }),
    ).then(() => this.entry(id));
  }

  publish(id: string, input: PublishInput, actor: AuthPrincipal) {
    return mutation(() =>
      this.database.client.$transaction(async (tx) => {
        const entry = await lockEntry(tx, id);
        const { draft, published } = await currentRevisions(tx, id);
        if (!draft) throw ContentErrors.noDraft();
        assertExpectedDraft(draft, input.expectedDraftUpdatedAt);
        // The model may have evolved since the draft was saved: check it again.
        await assertMediaUsable(tx, entry.kind, validate(entry.kind, draft.document));
        if (published) {
          await tx.contentRevision.update({
            where: { id: published.id },
            data: { status: 'SUPERSEDED' },
          });
        }
        const live = await tx.contentRevision.update({
          where: { id: draft.id },
          data: { status: 'PUBLISHED', publishedByIdentityId: actor.identityId },
        });
        await tx.contentEntry.update({ where: { id }, data: { updatedAt: new Date() } });
        await this.audit.record(
          {
            actor,
            action: 'CONTENT_PUBLISHED',
            resourceType: RESOURCE,
            resourceId: id,
            before: published
              ? { revision: published.revision, fingerprint: fingerprint(published.document) }
              : null,
            after: { revision: live.revision, fingerprint: fingerprint(draft.document) },
            metadata: { kind: entry.kind, key: entry.key },
          },
          tx,
        );
      }),
    ).then(() => this.entry(id));
  }

  discardDraft(id: string, input: DiscardInput, actor: AuthPrincipal) {
    return mutation(() =>
      this.database.client.$transaction(async (tx) => {
        const entry = await lockEntry(tx, id);
        const { draft } = await currentRevisions(tx, id);
        if (!draft) throw ContentErrors.noDraft();
        assertExpectedDraft(draft, input.expectedDraftUpdatedAt);
        await tx.contentRevision.delete({ where: { id: draft.id } });
        await tx.contentEntry.update({ where: { id }, data: { updatedAt: new Date() } });
        await this.audit.record(
          {
            actor,
            action: 'CONTENT_DRAFT_DISCARDED',
            resourceType: RESOURCE,
            resourceId: id,
            before: { revision: draft.revision, fingerprint: fingerprint(draft.document) },
            metadata: { kind: entry.kind, key: entry.key },
          },
          tx,
        );
      }),
    ).then(() => this.entry(id));
  }

  /** Starts a new draft from an earlier revision; the history itself never changes. */
  restore(id: string, input: RestoreInput, caller: ContentCaller) {
    return mutation(() =>
      this.database.client.$transaction(async (tx) => {
        const entry = await lockEntry(tx, id);
        const { draft, published } = await currentRevisions(tx, id);
        if (draft) throw ContentErrors.draftExists();
        const source = await tx.contentRevision.findUnique({
          where: { entryId_revision: { entryId: id, revision: input.revision } },
        });
        if (!source) throw ContentErrors.revisionNotFound();
        const document = validate(entry.kind, source.document);
        await assertMediaUsable(tx, entry.kind, document);
        if (
          published &&
          !caller.canManageSeo &&
          seoOf(entry.kind, published.document) !== seoOf(entry.kind, document)
        ) {
          throw ContentErrors.seoPermissionRequired();
        }
        const restored = await tx.contentRevision.create({
          data: {
            entryId: id,
            revision: await nextRevision(tx, id),
            document: asJson(document),
            note: input.note ?? `Restauration de la révision ${input.revision}`,
            basedOnRevision: input.revision,
            authorIdentityId: caller.actor.identityId,
          },
        });
        await tx.contentEntry.update({ where: { id }, data: { updatedAt: new Date() } });
        await this.audit.record(
          {
            actor: caller.actor,
            action: 'CONTENT_RESTORED',
            resourceType: RESOURCE,
            resourceId: id,
            after: {
              revision: restored.revision,
              restoredFrom: input.revision,
              fingerprint: fingerprint(document),
            },
            metadata: { kind: entry.kind, key: entry.key },
          },
          tx,
        );
      }),
    ).then(() => this.entry(id));
  }

  archive(id: string, input: ArchiveInput, actor: AuthPrincipal) {
    return mutation(() =>
      this.database.client.$transaction(async (tx) => {
        const entry = await lockEntry(tx, id);
        if (entry.kind !== 'PAGE' || entry.key === '/') throw ContentErrors.archiveForbidden();
        if (entry.archivedAt) throw ContentErrors.alreadyArchived();
        const archivedAt = new Date();
        await tx.contentEntry.update({ where: { id }, data: { archivedAt } });
        await this.audit.record(
          {
            actor,
            action: 'CONTENT_ARCHIVED',
            resourceType: RESOURCE,
            resourceId: id,
            before: { archivedAt: null },
            after: { archivedAt },
            metadata: { key: entry.key, reason: input.reason },
          },
          tx,
        );
      }),
    ).then(() => this.entry(id));
  }

  unarchive(id: string, actor: AuthPrincipal) {
    return mutation(() =>
      this.database.client.$transaction(async (tx) => {
        const entry = await lockEntry(tx, id);
        if (!entry.archivedAt) throw ContentErrors.notArchived();
        await tx.contentEntry.update({ where: { id }, data: { archivedAt: null } });
        await this.audit.record(
          {
            actor,
            action: 'CONTENT_UNARCHIVED',
            resourceType: RESOURCE,
            resourceId: id,
            before: { archivedAt: entry.archivedAt },
            after: { archivedAt: null },
            metadata: { key: entry.key },
          },
          tx,
        );
      }),
    ).then(() => this.entry(id));
  }

  // -- public reads ---------------------------------------------------------

  /** The published document of a served page (not archived), or 404. */
  async publishedPage(path: string) {
    const revision = await this.database.client.contentRevision.findFirst({
      where: {
        status: 'PUBLISHED',
        entry: { kind: 'PAGE', key: path, archivedAt: null },
      },
      select: { revision: true, publishedAt: true, document: true },
    });
    if (!revision) throw ContentErrors.pageNotFound();
    return {
      path,
      revision: revision.revision,
      publishedAt: revision.publishedAt,
      document: revision.document,
    };
  }

  /** Published site settings and navigation; either is null until first published. */
  async publishedSite() {
    const rows = await this.database.client.contentRevision.findMany({
      where: { status: 'PUBLISHED', entry: { kind: { in: ['SITE_SETTINGS', 'NAVIGATION'] } } },
      select: { publishedAt: true, document: true, entry: { select: { kind: true } } },
    });
    const of = (kind: ContentKind) => rows.find((row) => row.entry.kind === kind) ?? null;
    const settings = of('SITE_SETTINGS');
    const navigation = of('NAVIGATION');
    return {
      settings: settings?.document ?? null,
      navigation: navigation?.document ?? null,
      updatedAt:
        [settings?.publishedAt, navigation?.publishedAt]
          .filter((value): value is Date => value instanceof Date)
          .sort((a, b) => b.getTime() - a.getTime())[0] ?? null,
    };
  }

  /** Served pages whose published revision is indexable, for the sitemap. */
  async sitemap() {
    const rows = await this.database.client.contentRevision.findMany({
      where: { status: 'PUBLISHED', entry: { kind: 'PAGE', archivedAt: null } },
      select: { publishedAt: true, document: true, entry: { select: { key: true } } },
      orderBy: { entry: { key: 'asc' } },
      take: SITEMAP_LIMIT,
    });
    return {
      items: rows
        .filter(
          (row) => (row.document as { seo?: { indexable?: unknown } }).seo?.indexable !== false,
        )
        .map((row) => ({ path: row.entry.key, updatedAt: row.publishedAt })),
    };
  }
}
