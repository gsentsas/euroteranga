import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { Prisma, type DatabaseTransaction } from '@euroteranga/database';
import { Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AuthErrors } from '../auth/http/public-api-error.js';
import { RATE_LIMITS } from '../auth/rate-limit/rate-limit.rules.js';
import { RateLimitService } from '../auth/rate-limit/rate-limit.service.js';
import type { AuthPrincipal } from '../auth/session/auth-principal.js';
import { AuditService } from '../authorization/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import {
  ObjectStorageError,
  type ObjectStorageProvider,
  type StoredObject,
} from '../passenger-documents/storage/object-storage.provider.js';
import { ImageProcessingError, processImage } from './media-image.js';
import { MediaUploadError, parseMediaUpload } from './media-upload.js';
import type { MediaUpdate } from './media.dto.js';
import {
  PUBLIC_MEDIA_CONFIG,
  PUBLIC_MEDIA_STORAGE,
  type PublicMediaConfig,
} from './media.config.js';
import { MediaErrors, type MediaUsage } from './media.errors.js';
import { renditionPath } from './media-path.js';
import { publicMediaView } from './public-media-view.js';

const RESOURCE = 'public_media_asset';

/** Decoding is CPU and memory heavy: at most this many images at once. */
const MAX_CONCURRENT_PROCESSING = 2;

const assetInclude = {
  renditions: { orderBy: { width: 'asc' } },
  createdBy: { select: { id: true, email: true } },
  updatedBy: { select: { id: true, email: true } },
  archivedBy: { select: { id: true, email: true } },
} satisfies Prisma.PublicMediaAssetInclude;

type AssetRow = Prisma.PublicMediaAssetGetPayload<{ include: typeof assetInclude }>;

export function renditionStorageKey(sha256: string): string {
  return `public-media/${sha256.slice(0, 2)}/${sha256}`;
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function asPublicImageError(error: ImageProcessingError): never {
  if (error.code === 'UNSUPPORTED_FORMAT') throw MediaErrors.unsupported();
  if (error.code === 'TOO_MANY_PIXELS' || error.code === 'TOO_LONG_SIDE') {
    throw MediaErrors.tooManyPixels();
  }
  if (error.code === 'TOO_SMALL') throw MediaErrors.tooSmall();
  if (error.code === 'ANIMATED') throw MediaErrors.animated();
  throw MediaErrors.invalidImage();
}

function asPublicUploadError(error: MediaUploadError, maxBytes: number): never {
  if (error.code === 'TOO_LARGE') throw MediaErrors.tooLarge(maxBytes);
  if (error.code === 'EMPTY') throw MediaErrors.empty();
  if (error.code === 'ABORTED') throw MediaErrors.aborted();
  if (error.code === 'TIMEOUT') throw MediaErrors.timeout();
  if (error.code === 'UNSUPPORTED_MEDIA') throw MediaErrors.unsupported();
  if (error.code === 'INVALID_FIELDS') throw AuthErrors.validation(error.fields);
  throw MediaErrors.malformed();
}

/**
 * Contents (drafts and live revisions) that reference a media asset. Ids
 * are UUIDs, so a textual search of the JSON document is exact. Archived
 * entries count too: unarchiving one puts its live revision back online.
 */
export async function mediaUsages(
  tx: DatabaseTransaction | DatabaseService['client'],
  assetId: string,
): Promise<MediaUsage[]> {
  return tx.$queryRaw<MediaUsage[]>`
    SELECT usage."kind", usage."key", usage."status", usage."entryArchived"
    FROM (
      SELECT e."kind"::text AS "kind", e."key", r."status"::text AS "status",
        (e."archived_at" IS NOT NULL) AS "entryArchived"
      FROM "content_revision" r
      JOIN "content_entry" e ON e."id" = r."entry_id"
      WHERE r."status" IN ('DRAFT', 'PUBLISHED')
        AND strpos(r."document"::text, ${assetId}) > 0
      UNION ALL
      SELECT 'VEHICLE' AS "kind", v."code" AS "key", v."status"::text AS "status",
        false AS "entryArchived"
      FROM "vehicle" v
      WHERE v."primary_media_id" = ${assetId}::uuid
         OR EXISTS (
           SELECT 1 FROM "vehicle_media" vm
           WHERE vm."vehicle_id" = v."id" AND vm."media_id" = ${assetId}::uuid
         )
    ) usage
    ORDER BY usage."kind", usage."key", usage."status"
    LIMIT 50`;
}

async function lockAsset(tx: DatabaseTransaction, id: string) {
  const rows = await tx.$queryRaw<Array<{ id: string; status: 'ACTIVE' | 'ARCHIVED' }>>`
    SELECT "id", "status"::text AS "status" FROM "public_media_asset"
    WHERE "id" = ${id}::uuid FOR UPDATE`;
  const row = rows[0];
  if (!row) throw MediaErrors.notFound();
  return row;
}

/**
 * MEDIA-1 public media library. Storage calls happen outside PostgreSQL
 * transactions; renditions are content-addressed, so a retried upload
 * reuses an already stored file instead of failing.
 */
@Injectable()
export class MediaService {
  private processing = 0;

  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly rateLimits: RateLimitService,
    @Inject(PUBLIC_MEDIA_CONFIG) private readonly config: PublicMediaConfig,
    @Inject(PUBLIC_MEDIA_STORAGE) private readonly storage: ObjectStorageProvider,
  ) {}

  get enabled(): boolean {
    return this.config.storage.provider !== 'DISABLED';
  }

  private view(asset: AssetRow, usages?: MediaUsage[]) {
    return {
      id: asset.id,
      status: asset.status,
      altText: asset.altText,
      caption: asset.caption,
      credit: asset.credit,
      sourceFormat: asset.sourceFormat,
      sourceBytes: asset.sourceBytes,
      width: asset.width,
      height: asset.height,
      focalX: asset.focalX,
      focalY: asset.focalY,
      renditions: asset.renditions.map((rendition) => ({
        width: rendition.width,
        height: rendition.height,
        bytes: rendition.bytes,
        path: renditionPath(asset.id, rendition.width),
      })),
      createdAt: asset.createdAt.toISOString(),
      updatedAt: asset.updatedAt.toISOString(),
      createdBy: asset.createdBy,
      updatedBy: asset.updatedBy,
      archivedAt: asset.archivedAt?.toISOString() ?? null,
      archivedBy: asset.archivedBy,
      archiveReason: asset.archiveReason,
      ...(usages ? { usages } : {}),
    };
  }

  // -- reads (STAFF) --------------------------------------------------------

  async list(query: {
    status?: 'ACTIVE' | 'ARCHIVED' | undefined;
    limit: number;
    cursor?: string | undefined;
  }) {
    const rows = await this.database.client.publicMediaAsset.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.cursor ? { id: { lt: query.cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      take: query.limit + 1,
      include: assetInclude,
    });
    const page = rows.slice(0, query.limit);
    return {
      storageEnabled: this.enabled,
      items: page.map((asset) => this.view(asset)),
      nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async detail(id: string) {
    const asset = await this.database.client.publicMediaAsset.findUnique({
      where: { id },
      include: assetInclude,
    });
    if (!asset) throw MediaErrors.notFound();
    // The stored (canonical) id: the route may spell it in capitals.
    return this.view(asset, await mediaUsages(this.database.client, asset.id));
  }

  // -- mutations (STAFF) ----------------------------------------------------

  async upload(request: Request, actor: AuthPrincipal) {
    if (!this.enabled) throw MediaErrors.storageDisabled();
    await this.rateLimits.consume(RATE_LIMITS.publicMediaUploadIdentity, actor.identityId);
    if (this.processing >= MAX_CONCURRENT_PROCESSING) throw MediaErrors.busy();
    this.processing += 1;
    try {
      let parsed;
      try {
        parsed = await parseMediaUpload(request, this.config.maxBytes);
      } catch (error) {
        if (error instanceof MediaUploadError) asPublicUploadError(error, this.config.maxBytes);
        throw error;
      }
      const fields = parsed.fields;
      const sourceSha256 = sha256(parsed.data);
      await this.refuseDuplicate(sourceSha256);
      if (fields.replaces) {
        const replaced = await this.database.client.publicMediaAsset.findUnique({
          where: { id: fields.replaces },
          select: { id: true },
        });
        if (!replaced) throw AuthErrors.validation(['replaces']);
      }

      let image;
      try {
        image = await processImage(parsed.data, { maxPixels: this.config.maxPixels });
      } catch (error) {
        if (error instanceof ImageProcessingError) asPublicImageError(error);
        throw error;
      }

      for (const rendition of image.renditions) {
        try {
          await this.storage.put({
            key: renditionStorageKey(rendition.sha256),
            body: Readable.from(rendition.data),
            sizeBytes: rendition.bytes,
            mimeType: 'image/webp',
          });
        } catch (error) {
          // Content-addressed: an existing object should hold these bytes.
          if (error instanceof ObjectStorageError && error.code === 'CONFLICT') {
            await this.assertStored(renditionStorageKey(rendition.sha256), rendition.sha256);
            continue;
          }
          throw MediaErrors.unavailable();
        }
      }

      let id: string;
      try {
        id = await this.database.client.$transaction(async (tx) => {
          const asset = await tx.publicMediaAsset.create({
            data: {
              altText: fields.altText,
              caption: fields.caption ?? null,
              credit: fields.credit ?? null,
              sourceFormat: image.sourceFormat,
              sourceSha256,
              sourceBytes: parsed.data.length,
              width: image.width,
              height: image.height,
              focalX: fields.focalX ?? 50,
              focalY: fields.focalY ?? 50,
              createdByIdentityId: actor.identityId,
              updatedByIdentityId: actor.identityId,
              renditions: {
                create: image.renditions.map((rendition) => ({
                  width: rendition.width,
                  height: rendition.height,
                  format: 'webp',
                  bytes: rendition.bytes,
                  sha256: rendition.sha256,
                  storageKey: renditionStorageKey(rendition.sha256),
                })),
              },
            },
          });
          await this.audit.record(
            {
              actor,
              action: 'PUBLIC_MEDIA_UPLOADED',
              resourceType: RESOURCE,
              resourceId: asset.id,
              after: {
                sourceFormat: image.sourceFormat,
                sourceSha256,
                width: image.width,
                height: image.height,
                renditions: image.renditions.map((rendition) => rendition.width),
              },
              ...(fields.replaces ? { metadata: { replacesMediaId: fields.replaces } } : {}),
            },
            tx,
          );
          return asset.id;
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          await this.refuseDuplicate(sourceSha256);
        }
        throw error;
      }
      return this.detail(id);
    } finally {
      this.processing -= 1;
    }
  }

  /** An already stored object is reused only when its bytes really match. */
  private async assertStored(key: string, expectedSha256: string): Promise<void> {
    try {
      const stored = await this.storage.get(key);
      const hash = createHash('sha256');
      for await (const chunk of stored.body) hash.update(chunk as Buffer);
      if (hash.digest('hex') === expectedSha256) return;
    } catch {
      // Reported below.
    }
    throw MediaErrors.unavailable();
  }

  /** Among active images only: an archived file may come back as a new asset. */
  private async refuseDuplicate(sourceSha256: string): Promise<void> {
    const existing = await this.database.client.publicMediaAsset.findFirst({
      where: { sourceSha256, status: 'ACTIVE' },
      select: { id: true },
    });
    if (existing) throw MediaErrors.duplicate(existing.id);
  }

  /** Describing fields only: the image itself never changes. */
  async update(id: string, input: MediaUpdate, actor: AuthPrincipal) {
    const described = { altText: true, caption: true, credit: true, focalX: true, focalY: true };
    await this.database.client.$transaction(async (tx) => {
      const locked = await lockAsset(tx, id);
      if (locked.status === 'ARCHIVED') throw MediaErrors.archived();
      const before = await tx.publicMediaAsset.findUniqueOrThrow({
        where: { id },
        select: described,
      });
      const data = {
        ...(input.altText !== undefined ? { altText: input.altText } : {}),
        ...(input.caption !== undefined ? { caption: input.caption || null } : {}),
        ...(input.credit !== undefined ? { credit: input.credit || null } : {}),
        ...(input.focalX !== undefined ? { focalX: input.focalX } : {}),
        ...(input.focalY !== undefined ? { focalY: input.focalY } : {}),
      };
      const after = await tx.publicMediaAsset.update({
        where: { id },
        data: { ...data, updatedByIdentityId: actor.identityId },
        select: described,
      });
      await this.audit.record(
        {
          actor,
          action: 'PUBLIC_MEDIA_UPDATED',
          resourceType: RESOURCE,
          resourceId: id,
          before,
          after,
        },
        tx,
      );
    });
    return this.detail(id);
  }

  /**
   * Terminal. Refused while a draft or live revision references the image.
   * The row lock serializes with content saves and publications, which lock
   * the media they reference (FOR SHARE) before checking that it is active.
   * Older revisions keep their reference: restoring one is refused until
   * the image is replaced.
   */
  async archive(id: string, reason: string, actor: AuthPrincipal) {
    await this.database.client.$transaction(async (tx) => {
      const locked = await lockAsset(tx, id);
      if (locked.status === 'ARCHIVED') throw MediaErrors.archived();
      // Documents hold canonical ids: look them up with the stored spelling.
      const usages = await mediaUsages(tx, locked.id);
      if (usages.length > 0) throw MediaErrors.inUse(usages);
      await tx.publicMediaAsset.update({
        where: { id },
        data: {
          status: 'ARCHIVED',
          archivedAt: new Date(),
          archivedByIdentityId: actor.identityId,
          archiveReason: reason,
          updatedByIdentityId: actor.identityId,
        },
      });
      await this.audit.record(
        {
          actor,
          action: 'PUBLIC_MEDIA_ARCHIVED',
          resourceType: RESOURCE,
          resourceId: id,
          before: { status: 'ACTIVE' },
          after: { status: 'ARCHIVED' },
          metadata: { reason },
        },
        tx,
      );
    });
    return this.detail(id);
  }

  // -- public reads (no session) --------------------------------------------

  /** Active images only; unknown or archived ids are simply absent. */
  async publicMany(ids: readonly string[]) {
    const rows = await this.database.client.publicMediaAsset.findMany({
      where: { id: { in: [...ids] }, status: 'ACTIVE' },
      include: { renditions: { orderBy: { width: 'asc' } } },
    });
    return {
      items: rows.flatMap((asset) => {
        const view = publicMediaView(asset);
        return view ? [view] : [];
      }),
    };
  }

  /** The rendition of an active image, without opening its file yet. */
  async publicRendition(id: string, width: number) {
    const rendition = await this.database.client.publicMediaRendition.findFirst({
      where: { assetId: id, width, asset: { status: 'ACTIVE' } },
      select: { storageKey: true, sha256: true },
    });
    if (!rendition) throw MediaErrors.notFound();
    return rendition;
  }

  async openRendition(storageKey: string): Promise<StoredObject> {
    try {
      return await this.storage.get(storageKey);
    } catch (error) {
      if (error instanceof ObjectStorageError && error.code === 'NOT_FOUND') {
        throw MediaErrors.notFound();
      }
      throw MediaErrors.unavailable();
    }
  }
}
