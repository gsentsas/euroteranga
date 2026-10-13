'use client';

import { useEffect, useState } from 'react';
import { auth } from '../../lib/auth';
import { seatsLabel } from './seat-map-format';

export interface PublishedVersionOption {
  id: string;
  label: string;
}

/**
 * Currently PUBLISHED versions of active seat maps: the only ones that can be
 * newly assigned to a vehicle or a trip (seatmap.read is required).
 */
export function usePublishedSeatMapVersions(enabled: boolean): PublishedVersionOption[] {
  const [options, setOptions] = useState<PublishedVersionOption[]>([]);
  useEffect(() => {
    if (!enabled) return;
    void auth.admin.seatMaps.seatMaps({ active: true, limit: 100 }).then((result) => {
      if (!result.ok) return;
      setOptions(
        result.data.items.flatMap((map) =>
          map.versions
            .filter((version) => version.status === 'PUBLISHED')
            .map((version) => ({
              id: version.id,
              label: `${map.code} v${version.version} — ${seatsLabel(version.seatCount)}`,
            })),
        ),
      );
    });
  }, [enabled]);
  return options;
}
