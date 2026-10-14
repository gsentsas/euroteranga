'use client';

import { useMenu } from '@refinedev/core';
import Link from 'next/link';
import { useAccess } from './staff-access';

/**
 * Navigation built from the Refine resource registry, filtered by the
 * permissions the API reported. Display only: each page and API call checks
 * permissions again.
 */
export function OpsNav() {
  const { menuItems, selectedKey } = useMenu();
  const state = useAccess();
  if (state.status !== 'ready') return null;
  const visible = menuItems.filter((item) => {
    const permission: unknown = item.meta?.permission;
    return typeof permission !== 'string' || state.access.permissions.includes(permission);
  });

  const link = (item: (typeof visible)[number]) => (
    <Link href={item.route ?? '/'} aria-current={item.key === selectedKey ? 'page' : undefined}>
      {item.label ?? item.name}
    </Link>
  );
  // Consecutive items sharing meta.group are shown under one labelled group.
  const entries: Array<{ group: string | null; items: typeof visible }> = [];
  for (const item of visible) {
    const group = typeof item.meta?.group === 'string' ? item.meta.group : null;
    const last = entries[entries.length - 1];
    if (group && last?.group === group) last.items.push(item);
    else entries.push({ group, items: [item] });
  }

  return (
    <nav className="et-nav" aria-label="Navigation principale">
      <ul>
        {entries.map((entry) =>
          entry.group ? (
            <li key={`group-${entry.group}`} className="et-nav-group">
              <span className="et-nav-group-label">{entry.group}</span>
              <ul aria-label={entry.group}>
                {entry.items.map((item) => (
                  <li key={item.key}>{link(item)}</li>
                ))}
              </ul>
            </li>
          ) : (
            <li key={entry.items[0]!.key}>{link(entry.items[0]!)}</li>
          ),
        )}
      </ul>
    </nav>
  );
}
