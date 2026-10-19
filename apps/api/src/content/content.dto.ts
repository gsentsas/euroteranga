import { CONTENT_KINDS, contentPathSchema } from '@euroteranga/content';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { z } from 'zod';

const uuid = z.uuid();
const instant = z.iso.datetime({ offset: true });
const note = z.string().trim().min(1).max(200);

/** The draft the caller based its decision on: its updatedAt, or null when none was shown. */
const expectedDraft = instant.nullable();

export const contentListQuerySchema = z
  .object({
    kind: z.enum(CONTENT_KINDS).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: uuid.optional(),
  })
  .strict();

export const contentCreateSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('PAGE'),
      path: contentPathSchema,
      title: z.string().trim().min(1).max(140),
      description: z.string().trim().min(1).max(170),
    })
    .strict(),
  z.object({ kind: z.literal('SITE_SETTINGS') }).strict(),
  z.object({ kind: z.literal('NAVIGATION') }).strict(),
]);

/** The document is validated against the content model of the entry's kind. */
export const contentDraftSchema = z
  .object({
    document: z.record(z.string(), z.unknown()),
    note: note.optional(),
    expectedDraftUpdatedAt: expectedDraft,
  })
  .strict();

export const contentPublishSchema = z.object({ expectedDraftUpdatedAt: instant }).strict();
export const contentDiscardSchema = z.object({ expectedDraftUpdatedAt: instant }).strict();
export const contentRestoreSchema = z
  .object({ revision: z.number().int().min(1), note: note.optional() })
  .strict();
export const contentArchiveSchema = z
  .object({ reason: z.string().trim().min(3).max(300) })
  .strict();

export const publicPageQuerySchema = z.object({ path: contentPathSchema }).strict();

// OpenAPI bodies. Runtime validation always uses the Zod schemas above.
export class ContentCreateBody {
  @ApiProperty({ enum: CONTENT_KINDS }) kind!: string;
  @ApiPropertyOptional({ example: '/paris-dakar', description: 'PAGE only.' }) path?: string;
  @ApiPropertyOptional({ maxLength: 140, description: 'PAGE only.' }) title?: string;
  @ApiPropertyOptional({ maxLength: 170, description: 'PAGE only.' }) description?: string;
}

export class ContentDraftBody {
  @ApiProperty({ type: 'object', additionalProperties: true }) document!: Record<string, unknown>;
  @ApiPropertyOptional({ maxLength: 200 }) note?: string;
  @ApiProperty({ nullable: true, format: 'date-time' }) expectedDraftUpdatedAt!: string | null;
}

export class ContentExpectedDraftBody {
  @ApiProperty({ format: 'date-time' }) expectedDraftUpdatedAt!: string;
}

export class ContentRestoreBody {
  @ApiProperty({ minimum: 1 }) revision!: number;
  @ApiPropertyOptional({ maxLength: 200 }) note?: string;
}

export class ContentArchiveBody {
  @ApiProperty({ minLength: 3, maxLength: 300 }) reason!: string;
}
