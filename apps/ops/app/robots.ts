import { privateRobots } from '@euroteranga/config';
import type { MetadataRoute } from 'next';

/** Private application: never crawled nor indexed, whatever the environment. */
export default function robots(): MetadataRoute.Robots {
  return privateRobots();
}
