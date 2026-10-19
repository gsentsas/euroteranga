import { publicRobots } from '@euroteranga/config';
import type { MetadataRoute } from 'next';
import { siteSeo } from '../lib/seo';

export const dynamic = 'force-dynamic';

/** Disallows everything unless indexing is explicitly enabled in production. */
export default function robots(): MetadataRoute.Robots {
  return publicRobots(siteSeo());
}
