import { siteUrlOf } from '@euroteranga/config';
import type { MetadataRoute } from 'next';
import { siteSeo } from '../lib/seo';

export const dynamic = 'force-dynamic';

/** Public, indexable pages only. Private applications are never listed. */
export const PUBLIC_PATHS = ['/'] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  const seo = siteSeo();
  return PUBLIC_PATHS.map((path) => ({
    url: siteUrlOf(seo, path),
    changeFrequency: 'weekly',
    priority: path === '/' ? 1 : 0.7,
  }));
}
