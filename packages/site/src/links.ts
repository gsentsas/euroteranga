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

/**
 * Header/footer navigation is shared by every public page. Anchor targets in
 * that global navigation belong to the home page, so inner pages must return
 * to `/` before applying the fragment. Block-level anchors keep using
 * resolveHref() and remain local to their page.
 */
export function resolveGlobalNavigationHref(target: LinkTarget, apps: AppLinks): string {
  return target.kind === 'anchor' ? `/#${target.id}` : resolveHref(target, apps);
}
