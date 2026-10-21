'use client';

import type { MediaRendition, MediaUsage } from '@euroteranga/auth-client';
import { auth } from '../../lib/auth';

/** Formats the API accepts; the content itself is checked by the server. */
export const MEDIA_ACCEPT = 'image/jpeg,image/png,image/webp';
export const MEDIA_TYPES = new Set(MEDIA_ACCEPT.split(','));

export const ALT_TEXT_MAX = 250;
export const CAPTION_MAX = 240;
export const CREDIT_MAX = 160;
export const ARCHIVE_REASON_MIN = 3;
export const ARCHIVE_REASON_MAX = 300;

const dateFormat = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
export const formatDate = (value: string) => dateFormat.format(new Date(value));

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} Mo`;
}

/** The smallest rendition at least `width` pixels wide, else the largest. */
export function renditionFor(renditions: readonly MediaRendition[], width: number) {
  const sorted = [...renditions].sort((a, b) => a.width - b.width);
  return sorted.find((rendition) => rendition.width >= width) ?? sorted.at(-1) ?? null;
}

export function MediaThumb({
  renditions,
  alt,
  width,
  focalX = 50,
  focalY = 50,
  className,
}: {
  renditions: readonly MediaRendition[];
  alt: string;
  width: number;
  focalX?: number;
  focalY?: number;
  className?: string;
}) {
  const rendition = renditionFor(renditions, width);
  if (!rendition) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- WebP renditions of the API, no loader
    <img
      className={className}
      src={auth.media.url(rendition.path)}
      alt={alt}
      width={rendition.width}
      height={rendition.height}
      loading="lazy"
      decoding="async"
      style={{ objectPosition: `${focalX}% ${focalY}%` }}
    />
  );
}

const USAGE_STATUS: Record<MediaUsage['status'], string> = {
  DRAFT: 'brouillon',
  PUBLISHED: 'en ligne',
  PLANNED: 'planifié',
  ACTIVE: 'en service',
  OUT_OF_SERVICE: 'hors service',
  RETIRED: 'retiré',
};

const KIND: Record<MediaUsage['kind'], string> = {
  PAGE: 'Page',
  SITE_SETTINGS: 'Paramètres du site',
  NAVIGATION: 'Navigation',
  VEHICLE: 'Véhicule',
};

export function usageLabel(usage: MediaUsage): string {
  const state = usage.entryArchived
    ? `${USAGE_STATUS[usage.status]}, contenu archivé`
    : USAGE_STATUS[usage.status];
  return `${KIND[usage.kind] ?? usage.kind} ${usage.kind === 'PAGE' || usage.kind === 'VEHICLE' ? usage.key : ''} (${state})`.replace(
    /\s+/g,
    ' ',
  );
}
