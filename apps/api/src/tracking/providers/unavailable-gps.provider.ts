import type { TrackingProviderStatus } from '@euroteranga/database';
import { Injectable } from '@nestjs/common';
import type { GpsProvider } from './gps-provider.js';

@Injectable()
export class UnavailableGpsProvider implements GpsProvider {
  readonly key = 'UNAVAILABLE';

  supports(): boolean {
    return false;
  }

  async status(): Promise<TrackingProviderStatus> {
    return 'UNAVAILABLE';
  }
}
