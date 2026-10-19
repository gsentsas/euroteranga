import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, open, rm } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  assertPrivateObjectKey,
  ObjectStorageError,
  type ObjectStorageProvider,
  type StoredObject,
} from './object-storage.provider.js';

/**
 * Local filesystem adapter. For passenger documents it is a private
 * development/CI adapter refused by configuration in staging and production;
 * MEDIA-1 also uses it, with its own root and key space, for public website
 * images. It never writes below a web root, and creates directories/files
 * with owner-only permissions. Business code only sees ObjectStorageProvider.
 */
export class LocalObjectStorageProvider implements ObjectStorageProvider {
  private readonly root: string;

  /**
   * `assertKey` restricts the keys this instance accepts: the private
   * document namespaces by default, the public media namespace for MEDIA-1,
   * so neither store can ever read or write the other's objects.
   */
  constructor(
    root: string,
    private readonly assertKey: (key: string) => void = assertPrivateObjectKey,
  ) {
    this.root = resolve(root);
    // Defense in depth behind configuration: never chmod or populate "/".
    if (this.root === sep) throw new Error('local object storage needs a dedicated root');
  }

  async put(input: {
    key: string;
    body: NodeJS.ReadableStream;
    sizeBytes: number;
    mimeType: string;
  }): Promise<void> {
    const path = this.path(input.key);
    await this.prepareRoot();
    await this.prepareKeyDirectories(path);
    let handle;
    try {
      handle = await open(path, 'wx', 0o600);
      await pipeline(input.body, handle.createWriteStream());
      const stat = await lstat(path);
      if (!stat.isFile() || stat.size !== input.sizeBytes) {
        await rm(path, { force: true });
        throw new ObjectStorageError('UNAVAILABLE');
      }
      await chmod(path, 0o600);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new ObjectStorageError('CONFLICT');
      }
      if (error instanceof ObjectStorageError) throw error;
      await rm(path, { force: true }).catch(() => undefined);
      throw new ObjectStorageError('UNAVAILABLE');
    }
  }

  async get(key: string): Promise<StoredObject> {
    const path = this.path(key);
    try {
      await this.assertKeyDirectories(path);
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new ObjectStorageError('NOT_FOUND');
      return { body: createReadStream(path), sizeBytes: stat.size };
    } catch (error) {
      if (error instanceof ObjectStorageError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ObjectStorageError('NOT_FOUND');
      }
      throw new ObjectStorageError('UNAVAILABLE');
    }
  }

  async head(key: string): Promise<{ sizeBytes: number }> {
    const stored = await this.get(key);
    stored.body.destroy();
    return { sizeBytes: stored.sizeBytes };
  }

  async delete(key: string): Promise<void> {
    const path = this.path(key);
    try {
      try {
        await this.assertKeyDirectories(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      await rm(path, { force: true });
    } catch {
      throw new ObjectStorageError('UNAVAILABLE');
    }
  }

  private async prepareRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.assertPrivateDirectory(this.root);
    await chmod(this.root, 0o700);
  }

  /** Create each fixed key component only after proving its parent is not a symlink. */
  private async prepareKeyDirectories(path: string): Promise<void> {
    const namespace = dirname(dirname(path));
    await this.ensurePrivateDirectory(namespace);
    await this.ensurePrivateDirectory(dirname(path));
  }

  private async ensurePrivateDirectory(path: string): Promise<void> {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    await this.assertPrivateDirectory(path);
    await chmod(path, 0o700);
  }

  private async assertKeyDirectories(path: string): Promise<void> {
    await this.assertPrivateDirectory(this.root);
    await this.assertPrivateDirectory(dirname(dirname(path)));
    await this.assertPrivateDirectory(dirname(path));
  }

  private async assertPrivateDirectory(path: string): Promise<void> {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ObjectStorageError('UNAVAILABLE');
  }

  private path(key: string): string {
    this.assertKey(key);
    const path = resolve(this.root, key);
    if (!path.startsWith(`${this.root}${sep}`)) throw new ObjectStorageError('INVALID_KEY');
    return path;
  }
}
