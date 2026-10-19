import type { ApiEnv } from '@euroteranga/config';
import { Module } from '@nestjs/common';
import { API_ENV } from '../config/config.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { LocalObjectStorageProvider } from '../passenger-documents/storage/local-object-storage.provider.js';
import {
  assertPublicMediaObjectKey,
  DisabledObjectStorageProvider,
  type ObjectStorageProvider,
} from '../passenger-documents/storage/object-storage.provider.js';
import { AdminMediaController } from './admin-media.controller.js';
import {
  buildPublicMediaConfig,
  PUBLIC_MEDIA_CONFIG,
  PUBLIC_MEDIA_STORAGE,
  type PublicMediaConfig,
} from './media.config.js';
import { MediaService } from './media.service.js';
import { PublicMediaController } from './public-media.controller.js';

/** Its own store, which only accepts `public-media/…` keys (never private ones). */
function publicMediaStorage(config: PublicMediaConfig): ObjectStorageProvider {
  if (config.storage.provider === 'LOCAL') {
    return new LocalObjectStorageProvider(config.storage.root, assertPublicMediaObjectKey);
  }
  return new DisabledObjectStorageProvider();
}

/** MEDIA-1 public media library of the website. */
@Module({
  imports: [DatabaseModule],
  controllers: [AdminMediaController, PublicMediaController],
  providers: [
    {
      provide: PUBLIC_MEDIA_CONFIG,
      inject: [API_ENV],
      useFactory: (env: ApiEnv) => buildPublicMediaConfig(env),
    },
    {
      provide: PUBLIC_MEDIA_STORAGE,
      inject: [PUBLIC_MEDIA_CONFIG],
      useFactory: publicMediaStorage,
    },
    MediaService,
  ],
  exports: [MediaService],
})
export class MediaModule {}
