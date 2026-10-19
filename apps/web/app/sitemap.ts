import { siteUrlOf } from '@euroteranga/config';
import type { MetadataRoute } from 'next';
import { loadSitemapPaths } from '../lib/content';
import { siteSeo } from '../lib/seo';

export const dynamic = 'force-dynamic';

/** Served, indexable CMS pages only. Private applications are never listed. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const seo = siteSeo();
  const paths = await loadSitemapPaths();
  return paths.map((item) => ({
    url: siteUrlOf(seo, item.path),
    ...(item.updatedAt ? { lastModified: new Date(item.updatedAt) } : {}),
    changeFrequency: 'weekly' as const,
    priority: item.path === '/' ? 1 : 0.7,
  }));
}
