import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  detectSourceFormat,
  ImageProcessingError,
  processImage,
  renditionWidths,
} from '../../../src/media/media-image.js';

const LIMITS = { maxPixels: 40_000_000 };

function solid(width: number, height: number, channels: 3 | 4 = 3) {
  return sharp({
    create: {
      width,
      height,
      channels,
      background: channels === 4 ? { r: 10, g: 40, b: 120, alpha: 0.5 } : '#123c78',
    },
  });
}

async function failure(input: Buffer, limits = LIMITS): Promise<string> {
  try {
    await processImage(input, limits);
    return 'accepted';
  } catch (error) {
    expect(error).toBeInstanceOf(ImageProcessingError);
    return (error as ImageProcessingError).code;
  }
}

describe('public media image processing (MEDIA-1)', () => {
  it('recognises only JPEG, PNG and WebP from their first bytes', async () => {
    expect(detectSourceFormat(await solid(10, 10).jpeg().toBuffer())).toBe('jpeg');
    expect(detectSourceFormat(await solid(10, 10).png().toBuffer())).toBe('png');
    expect(detectSourceFormat(await solid(10, 10).webp().toBuffer())).toBe('webp');
    expect(detectSourceFormat(await solid(10, 10).gif().toBuffer())).toBeNull();
    expect(detectSourceFormat(await solid(10, 10).tiff().toBuffer())).toBeNull();
    expect(detectSourceFormat(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    // ISO-BMFF (HEIF/AVIF) starts with a box size then "ftyp".
    expect(detectSourceFormat(Buffer.from('\0\0\0\x1cftypheic', 'binary'))).toBeNull();
    expect(detectSourceFormat(Buffer.alloc(0))).toBeNull();
  });

  it('plans responsive widths without ever enlarging', () => {
    expect(renditionWidths(300)).toEqual([300]);
    expect(renditionWidths(480)).toEqual([480]);
    expect(renditionWidths(1000)).toEqual([480, 960, 1000]);
    expect(renditionWidths(1600)).toEqual([480, 960, 1600]);
    expect(renditionWidths(3000)).toEqual([480, 960, 1600, 2400]);
  });

  it('re-encodes to WebP renditions without EXIF or GPS, applying the orientation', async () => {
    const photo = await solid(1200, 800)
      .jpeg()
      .withExif({
        IFD0: { Artist: 'Photographe synthétique', Copyright: 'Synthétique' },
        IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '14/1 41/1 0/1' },
      })
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const before = await sharp(photo).metadata();
    expect(before.exif).toBeDefined();
    expect(before.orientation).toBe(6);

    const processed = await processImage(photo, LIMITS);
    expect(processed.sourceFormat).toBe('jpeg');
    // Orientation 6 rotates by 90°: the oriented image is portrait.
    expect({ width: processed.width, height: processed.height }).toEqual({
      width: 800,
      height: 1200,
    });
    expect(processed.renditions.map((rendition) => rendition.width)).toEqual([480, 800]);
    for (const rendition of processed.renditions) {
      const meta = await sharp(rendition.data).metadata();
      expect(meta.format).toBe('webp');
      expect(meta.exif).toBeUndefined();
      expect(meta.xmp).toBeUndefined();
      expect(meta.orientation).toBeUndefined();
      expect(meta.height).toBe(rendition.height);
      expect(rendition.height).toBeGreaterThan(rendition.width);
      expect(rendition.bytes).toBe(rendition.data.length);
      expect(rendition.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('accepts a side of exactly 20 000 px (the database limit)', async () => {
    const processed = await processImage(
      await solid(20_000, 200).png({ compressionLevel: 9 }).toBuffer(),
      LIMITS,
    );
    expect(processed.width).toBe(20_000);
    expect(processed.renditions.at(-1)?.width).toBe(2_400);
  });

  it('keeps transparency of PNG and WebP sources', async () => {
    const png = await processImage(await solid(640, 480, 4).png().toBuffer(), LIMITS);
    expect(png.sourceFormat).toBe('png');
    expect((await sharp(png.renditions[0]!.data).metadata()).hasAlpha).toBe(true);
    const webp = await processImage(await solid(640, 480).webp().toBuffer(), LIMITS);
    expect(webp.sourceFormat).toBe('webp');
  });

  it('refuses other formats, broken files, tiny, animated and oversized images', async () => {
    expect(await failure(await solid(400, 400).gif().toBuffer())).toBe('UNSUPPORTED_FORMAT');
    expect(
      await failure(
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><script>alert(1)</script></svg>',
        ),
      ),
    ).toBe('UNSUPPORTED_FORMAT');
    // A JPEG signature followed by garbage.
    expect(
      await failure(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2048, 7)])),
    ).toBe('INVALID_IMAGE');
    const truncated = await solid(800, 600).jpeg().toBuffer();
    expect(await failure(truncated.subarray(0, Math.floor(truncated.length / 3)))).toBe(
      'INVALID_IMAGE',
    );
    expect(await failure(await solid(150, 600).png().toBuffer())).toBe('TOO_SMALL');

    // Two distinct frames (identical frames are merged by the encoder).
    const first = await solid(300, 300).png().toBuffer();
    const second = await sharp({
      create: { width: 300, height: 300, channels: 3, background: '#ffcc00' },
    })
      .png()
      .toBuffer();
    const animated = await sharp([first, second], { join: { animated: true } })
      .webp()
      .toBuffer();
    expect((await sharp(animated).metadata()).pages).toBe(2);
    expect(await failure(animated)).toBe('ANIMATED');

    // A side longer than the database accepts, well within the pixel limit.
    const panorama = await solid(20_001, 300).png({ compressionLevel: 9 }).toBuffer();
    expect(await failure(panorama)).toBe('TOO_LONG_SIDE');
    const tall = await solid(300, 20_001).png({ compressionLevel: 9 }).toBuffer();
    expect(await failure(tall)).toBe('TOO_LONG_SIDE');

    // A tiny file announcing many pixels (decompression bomb).
    const bomb = await solid(5000, 5000).png({ compressionLevel: 9 }).toBuffer();
    expect(bomb.length).toBeLessThan(1_000_000);
    expect(await failure(bomb, { maxPixels: 10_000_000 })).toBe('TOO_MANY_PIXELS');
  });
});
