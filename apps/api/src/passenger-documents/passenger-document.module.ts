import type { ApiEnv } from '@euroteranga/config';
import { Module } from '@nestjs/common';
import { API_ENV } from '../config/config.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { AdminPassengerDocumentController } from './admin-passenger-document.controller.js';
import { CustomerPassengerDocumentController } from './customer-passenger-document.controller.js';
import { ClamAvMalwareScanner } from './malware/clamav-malware.scanner.js';
import {
  DisabledMalwareScanner,
  MALWARE_SCANNER,
  TestMalwareScanner,
  type MalwareScanner,
} from './malware/malware-scanner.js';
import {
  buildPassengerDocumentConfig,
  PASSENGER_DOCUMENT_CONFIG,
  type PassengerDocumentConfig,
} from './passenger-document.config.js';
import { PassengerDocumentService } from './passenger-document.service.js';
import { LocalObjectStorageProvider } from './storage/local-object-storage.provider.js';
import {
  DisabledObjectStorageProvider,
  OBJECT_STORAGE_PROVIDER,
  type ObjectStorageProvider,
} from './storage/object-storage.provider.js';
import { S3ObjectStorageProvider } from './storage/s3-object-storage.provider.js';

function objectStorage(config: PassengerDocumentConfig): ObjectStorageProvider {
  if (config.storage.provider === 'LOCAL') {
    return new LocalObjectStorageProvider(config.storage.root);
  }
  if (config.storage.provider === 'S3') {
    return new S3ObjectStorageProvider(config.storage);
  }
  return new DisabledObjectStorageProvider();
}

function malwareScanner(config: PassengerDocumentConfig): MalwareScanner {
  if (config.malware.scanner === 'CLAMAV') {
    return new ClamAvMalwareScanner(
      config.malware.host,
      config.malware.port,
      config.malware.timeoutMs,
    );
  }
  if (config.malware.scanner === 'TEST') return new TestMalwareScanner();
  return new DisabledMalwareScanner();
}

/** PR-11 passenger foundation and technically secure private files. */
@Module({
  imports: [DatabaseModule],
  controllers: [CustomerPassengerDocumentController, AdminPassengerDocumentController],
  providers: [
    {
      provide: PASSENGER_DOCUMENT_CONFIG,
      inject: [API_ENV],
      useFactory: (env: ApiEnv) => buildPassengerDocumentConfig(env),
    },
    {
      provide: OBJECT_STORAGE_PROVIDER,
      inject: [PASSENGER_DOCUMENT_CONFIG],
      useFactory: objectStorage,
    },
    {
      provide: MALWARE_SCANNER,
      inject: [PASSENGER_DOCUMENT_CONFIG],
      useFactory: malwareScanner,
    },
    PassengerDocumentService,
  ],
})
export class PassengerDocumentModule {}
