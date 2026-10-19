import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { z } from 'zod';

const uuid = z.uuid();
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? undefined : value))
    .optional();

/** Alternative text: what a screen reader says instead of the image. */
const altText = z.string().trim().min(1).max(250);
/** Focal point, in percent of the width or height. */
const focal = z.number().int().min(0).max(100);
/** Multipart fields are text: a focal coordinate is written in digits. */
const focalField = z
  .string()
  .regex(/^(?:100|[1-9]?[0-9])$/)
  .transform(Number)
  .optional();

export const mediaUploadFieldsSchema = z
  .object({
    altText,
    caption: optionalText(240),
    credit: optionalText(160),
    focalX: focalField,
    focalY: focalField,
    /** The image this upload replaces (recorded in the audit trail). */
    replaces: uuid.optional(),
  })
  .strict();
export type MediaUploadFields = z.infer<typeof mediaUploadFieldsSchema>;

/** Updated fields only; an empty caption or credit removes it. */
export const mediaUpdateSchema = z
  .object({
    altText: altText.optional(),
    caption: z.string().trim().max(240).nullable().optional(),
    credit: z.string().trim().max(160).nullable().optional(),
    focalX: focal.optional(),
    focalY: focal.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'nothing to update' });
export type MediaUpdate = z.infer<typeof mediaUpdateSchema>;

export const mediaArchiveSchema = z.object({ reason: z.string().trim().min(3).max(300) }).strict();

export const mediaListQuerySchema = z
  .object({
    status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(48),
    cursor: uuid.optional(),
  })
  .strict();

/** Public batch read: at most 50 distinct ids, comma-separated. */
export const publicMediaQuerySchema = z
  .object({
    ids: z
      .string()
      .max(50 * 37)
      .transform((value) => [...new Set(value.split(',').filter(Boolean))])
      .pipe(z.array(uuid).min(1).max(50)),
  })
  .strict();

export const renditionFileSchema = z
  .string()
  .regex(/^[1-9][0-9]{1,4}\.webp$/)
  .transform((value) => Number(value.slice(0, -'.webp'.length)));

// OpenAPI bodies. Runtime validation always uses the Zod schemas above.
export class MediaUpdateBody {
  @ApiPropertyOptional({ maxLength: 250 }) altText?: string;
  @ApiPropertyOptional({ maxLength: 240, nullable: true }) caption?: string | null;
  @ApiPropertyOptional({ maxLength: 160, nullable: true }) credit?: string | null;
  @ApiPropertyOptional({ minimum: 0, maximum: 100 }) focalX?: number;
  @ApiPropertyOptional({ minimum: 0, maximum: 100 }) focalY?: number;
}

export class MediaArchiveBody {
  @ApiProperty({ minLength: 3, maxLength: 300 }) reason!: string;
}
