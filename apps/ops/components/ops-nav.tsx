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

  return (
    <nav className="et-nav" aria-label="Navigation principale">
      <ul>
        {visible.map((item) => (
          <li key={item.key}>
            <Link
              href={item.route ?? '/'}
              aria-current={item.key === selectedKey ? 'page' : undefined}
            >
              {item.label ?? item.name}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
