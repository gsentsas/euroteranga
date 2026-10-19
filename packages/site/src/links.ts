import type { LinkTarget } from '@euroteranga/content';

/** Public URLs of the other applications, resolved by the website. */
export interface AppLinks {
  booking: string;
  client: string;
  tracking: string;
}

export function resolveHref(target: LinkTarget, apps: AppLinks): string {
  switch (target.kind) {
    case 'page':
      return target.path;
    case 'app':
      return apps[target.app];
    case 'url':
      return target.url;
    case 'anchor':
      return `#${target.id}`;
  }
}
