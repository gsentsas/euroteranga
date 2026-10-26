'use client';

import { useSearchParams } from 'next/navigation';

/** Deep link from the trip cockpit into an existing OPS page, pre-filled with the trip. */
export function tripPageHref(path: string, reference: string): string {
  return `${path}?voyage=${encodeURIComponent(reference)}`;
}

/** The `?voyage=<reference>` of such a link, normalized like the reference fields. */
export function useTripReferenceParam(): string {
  return (useSearchParams().get('voyage') ?? '').trim().toUpperCase();
}
