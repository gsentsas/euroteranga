import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import sharp from 'sharp';
import request from 'supertest';
import type { StaffActor } from './admin-helpers.js';

/**
 * A synthetic photograph: a plain colour with a small random patch, so that
 * every call (and every run against a reused database) gives other bytes.
 */
export async function syntheticPhoto(
  width = 1200,
  height = 800,
  format: 'jpeg' | 'png' | 'webp' = 'jpeg',
): Promise<Buffer> {
  const [r, g, b] = randomBytes(3);
  const patch = Math.min(32, width, height);
  const image = sharp({
    create: { width, height, channels: 3, background: { r: r!, g: g!, b: b! } },
  }).composite([
    {
      input: randomBytes(patch * patch * 3),
      raw: { width: patch, height: patch, channels: 3 },
      top: 0,
      left: 0,
    },
  ]);
  if (format === 'png') return image.png().toBuffer();
  if (format === 'webp') return image.webp().toBuffer();
  return image.jpeg().toBuffer();
}

export interface MediaUploadOptions {
  bytes: Buffer;
  contentType?: string;
  filename?: string;
  fields?: Record<string, string>;
  csrf?: string | null;
}

/** Multipart upload through the STAFF admin API (session, origin, CSRF). */
export async function uploadMedia(
  app: NestExpressApplication,
  actor: StaffActor,
  options: MediaUploadOptions,
) {
  const csrf = options.csrf === undefined ? await actor.csrf() : options.csrf;
  let call = request(app.getHttpServer())
    .post('/v1/admin/media')
    .set('Origin', actor.http.origin)
    .set('X-Forwarded-For', actor.http.ip)
    .set('Cookie', actor.cookie);
  if (csrf) call = call.set('X-CSRF-Token', csrf);
  for (const [name, value] of Object.entries(
    options.fields ?? { altText: 'Autocar sur la route' },
  )) {
    call = call.field(name, value);
  }
  return call.attach('file', options.bytes, {
    filename: options.filename ?? 'photo.jpg',
    contentType: options.contentType ?? 'image/jpeg',
  });
}

/** Every file stored under a public media root, with its content. */
export async function storedFiles(root: string): Promise<Array<{ path: string; data: Buffer }>> {
  const files: Array<{ path: string; data: Buffer }> = [];
  async function walk(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else files.push({ path, data: await readFile(path) });
    }
  }
  await walk(root);
  return files;
}
