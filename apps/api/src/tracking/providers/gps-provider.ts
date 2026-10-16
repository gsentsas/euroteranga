import type { TrackingProviderStatus } from '@euroteranga/database';

export interface GpsProviderPosition {
  providerObservationId: string;
  observedAt: Date;
  latitude: number;
  longitude: number;
  accuracyMeters?: number;
  speedKph?: number;
  headingDegrees?: number;
}

export interface GpsProvider {
  readonly key: string;
  supports(providerKey: string): boolean;
  status(externalDeviceId: string): Promise<TrackingProviderStatus>;
}

export const GPS_PROVIDER = Symbol('GPS_PROVIDER');
