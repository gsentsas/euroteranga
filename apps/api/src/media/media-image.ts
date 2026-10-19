import { createHash } from 'node:crypto';
import sharp, { type Metadata, type OutputInfo } from 'sharp';

/**
 * MEDIA-1 image processing. An upload is decoded and re-encoded, never
 * stored as received:
 *
 * - only JPEG, PNG and WebP are accepted, recognised by their magic bytes
 *   *before* any decoding (libvips can also decode SVG, HEIF, GIF, TIFF…,
 *   which are never handed to it) and confirmed by the decoder;
 * - decoding is bounded in pixels (decompression bombs) and refuses
 *   animated or multi-page images;
 * - the EXIF orientation is applied, then every rendition is a fresh WebP
 *   without any metadata (EXIF, GPS, XMP, ICC comments are dropped).
 */

// One-off conversions: no libvips operation cache to keep, and a small
// thread pool, so two concurrent uploads stay within the API memory budget
// (systemd MemoryMax) together with PUBLIC_MEDIA_MAX_PIXELS.
sharp.cache(false);
sharp.concurrency(2);

export type SourceFormat = 'jpeg' | 'png' | 'webp';

export type ImageFailure =
  | 'UNSUPPORTED_FORMAT'
  | 'INVALID_IMAGE'
  | 'TOO_MANY_PIXELS'
  /** A side over MAX_IMAGE_SIDE, even within the pixel limit. */
  | 'TOO_LONG_SIDE'
  | 'TOO_SMALL'
  | 'ANIMATED';

export class ImageProcessingError extends Error {
  constructor(readonly code: ImageFailure) {
    super(`image ${code.toLowerCase()}`);
    this.name = 'ImageProcessingError';
  }
}

/** Widths of the responsive renditions (never larger than the source). */
export const RENDITION_WIDTHS = [480, 960, 1600, 2400] as const;

/** Smallest accepted side: below this a public image is not usable. */
export const MIN_IMAGE_SIDE = 200;

/** Largest accepted side, as the public_media_asset CHECK constraint. */
export const MAX_IMAGE_SIDE = 20_000;

const WEBP_QUALITY = 80;

export interface Rendition {
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  data: Buffer;
}

export interface ProcessedImage {
  sourceFormat: SourceFormat;
  width: number;
  height: number;
  renditions: Rendition[];
}

const MAGIC: ReadonlyArray<{ format: SourceFormat; test: (head: Buffer) => boolean }> = [
  {
    format: 'jpeg',
    test: (head) => head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff,
  },
  {
    format: 'png',
    test: (head) =>
      head.length >= 8 &&
      head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    format: 'webp',
    test: (head) =>
      head.length >= 12 &&
      head.toString('ascii', 0, 4) === 'RIFF' &&
      head.toString('ascii', 8, 12) === 'WEBP',
  },
];

export const SOURCE_MIME_TYPES: Record<SourceFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

/** The format announced by the first bytes, or null for anything else. */
export function detectSourceFormat(head: Buffer): SourceFormat | null {
  return MAGIC.find((candidate) => candidate.test(head))?.format ?? null;
}

/**
 * Rendition widths for a source of this (oriented) width, smallest first:
 * every step narrower than the source, plus the source width itself capped
 * at the largest step. 300 → [300]; 1000 → [480, 960, 1000];
 * 3000 → [480, 960, 1600, 2400].
 */
export function renditionWidths(sourceWidth: number): number[] {
  const largest = RENDITION_WIDTHS[RENDITION_WIDTHS.length - 1]!;
  const widths = new Set<number>(RENDITION_WIDTHS.filter((width) => width < sourceWidth));
  widths.add(Math.min(sourceWidth, largest));
  return [...widths].sort((a, b) => a - b);
}

export async function processImage(
  input: Buffer,
  limits: { maxPixels: number },
): Promise<ProcessedImage> {
  const sourceFormat = detectSourceFormat(input.subarray(0, 16));
  if (!sourceFormat) throw new ImageProcessingError('UNSUPPORTED_FORMAT');

  const decoder = () =>
    sharp(input, {
      limitInputPixels: limits.maxPixels,
      failOn: 'error',
      // One frame only: an animated image is refused below, never flattened.
      pages: 1,
    });

  let metadata: Metadata;
  try {
    metadata = await decoder().metadata();
  } catch (error) {
    throw toImageError(error);
  }
  if (metadata.format !== sourceFormat) throw new ImageProcessingError('UNSUPPORTED_FORMAT');
  if ((metadata.pages ?? 1) > 1) throw new ImageProcessingError('ANIMATED');
  const rawWidth = metadata.width;
  const rawHeight = metadata.height;
  if (!rawWidth || !rawHeight) throw new ImageProcessingError('INVALID_IMAGE');
  // Before any rendition is encoded or stored: the database refuses longer sides.
  if (rawWidth > MAX_IMAGE_SIDE || rawHeight > MAX_IMAGE_SIDE) {
    throw new ImageProcessingError('TOO_LONG_SIDE');
  }
  if (rawWidth * rawHeight > limits.maxPixels) throw new ImageProcessingError('TOO_MANY_PIXELS');
  // EXIF orientations 5 to 8 swap the sides once applied.
  const swapped = (metadata.orientation ?? 1) >= 5;
  const width = swapped ? rawHeight : rawWidth;
  const height = swapped ? rawWidth : rawHeight;
  if (width < MIN_IMAGE_SIDE || height < MIN_IMAGE_SIDE)
    throw new ImageProcessingError('TOO_SMALL');

  const renditions: Rendition[] = [];
  for (const target of renditionWidths(width)) {
    let output: { data: Buffer; info: OutputInfo };
    try {
      output = await decoder()
        .rotate()
        .resize({ width: target, withoutEnlargement: true })
        // No withMetadata()/keepMetadata(): EXIF, GPS, XMP and ICC are dropped.
        .webp({ quality: WEBP_QUALITY, effort: 4 })
        .toBuffer({ resolveWithObject: true });
    } catch (error) {
      throw toImageError(error);
    }
    renditions.push({
      width: output.info.width,
      height: output.info.height,
      bytes: output.data.length,
      sha256: createHash('sha256').update(output.data).digest('hex'),
      data: output.data,
    });
  }
  return { sourceFormat, width, height, renditions };
}

function toImageError(error: unknown): ImageProcessingError {
  if (error instanceof ImageProcessingError) return error;
  const message = error instanceof Error ? error.message : '';
  if (/pixel limit/i.test(message)) return new ImageProcessingError('TOO_MANY_PIXELS');
  return new ImageProcessingError('INVALID_IMAGE');
}
