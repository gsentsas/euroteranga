import type { ApiEnv } from '@euroteranga/config';

export const PASSENGER_DOCUMENT_CONFIG = Symbol('PASSENGER_DOCUMENT_CONFIG');

export type PassengerDocumentStorageConfig =
  | { provider: 'DISABLED' }
  | { provider: 'LOCAL'; root: string }
  | {
      provider: 'S3';
      endpoint: string;
      region: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
      forcePathStyle: boolean;
    };

export type PassengerDocumentScannerConfig =
  | { scanner: 'DISABLED' }
  | { scanner: 'TEST' }
  | { scanner: 'CLAMAV'; host: string; port: number; timeoutMs: number };

export interface PassengerDocumentConfig {
  maxBytes: number;
  storage: PassengerDocumentStorageConfig;
  malware: PassengerDocumentScannerConfig;
}

/** The environment has already passed the cross-field schema refinements. */
export function buildPassengerDocumentConfig(env: ApiEnv): PassengerDocumentConfig {
  let storage: PassengerDocumentStorageConfig;
  if (env.OBJECT_STORAGE_PROVIDER === 'LOCAL') {
    storage = { provider: 'LOCAL', root: env.OBJECT_STORAGE_LOCAL_ROOT! };
  } else if (env.OBJECT_STORAGE_PROVIDER === 'S3') {
    storage = {
      provider: 'S3',
      endpoint: env.OBJECT_STORAGE_ENDPOINT!,
      region: env.OBJECT_STORAGE_REGION!,
      bucket: env.OBJECT_STORAGE_BUCKET!,
      accessKeyId: env.OBJECT_STORAGE_ACCESS_KEY!,
      secretAccessKey: env.OBJECT_STORAGE_SECRET_KEY!,
      forcePathStyle: env.OBJECT_STORAGE_FORCE_PATH_STYLE,
    };
  } else {
    storage = { provider: 'DISABLED' };
  }

  let malware: PassengerDocumentScannerConfig;
  if (env.MALWARE_SCANNER === 'CLAMAV') {
    malware = {
      scanner: 'CLAMAV',
      host: env.CLAMAV_HOST!,
      port: env.CLAMAV_PORT,
      timeoutMs: env.CLAMAV_TIMEOUT_MS,
    };
  } else if (env.MALWARE_SCANNER === 'TEST') {
    malware = { scanner: 'TEST' };
  } else {
    malware = { scanner: 'DISABLED' };
  }
  return { maxBytes: env.PASSENGER_DOCUMENT_MAX_BYTES, storage, malware };
}
