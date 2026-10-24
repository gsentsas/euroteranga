'use client';

import { useMenu } from '@refinedev/core';
import Link from 'next/link';
import { OpsIcon } from './ops-icons';
import { OPS_NAV_GROUPS, opsResource } from './ops-navigation';
import { useAccess } from './staff-access';

/**
 * Navigation built from the Refine resource registry and filtered with the
 * permissions returned by the Core API. This is display-only; the server
 * authorizes every underlying request independently.
 */
export function OpsNav({ onNavigate }: { onNavigate?: () => void } = {}) {
  const { menuItems, selectedKey } = useMenu();
  const state = useAccess();
  if (state.status !== 'ready') return null;

  const visible = menuItems.filter((item) => {
    const permission: unknown = item.meta?.permission;
    return typeof permission !== 'string' || state.access.permissions.includes(permission);
  });

  const grouped = OPS_NAV_GROUPS.map((group) => ({
    ...group,
    items: visible.filter((item) => opsResource(item.name)?.group === group.key),
  })).filter((group) => group.items.length > 0);

  return (
    <nav className="ops-nav" aria-label="Navigation principale">
      {grouped.map((group) => (
        <section
          className="ops-nav__group"
          key={group.key}
          aria-labelledby={`ops-nav-${group.key}`}
        >
          <h2 id={`ops-nav-${group.key}`}>{group.label}</h2>
          <ul aria-label={group.label}>
            {group.items.map((item) => {
              const active = item.key === selectedKey;
              const resource = opsResource(item.name);
              return (
                <li key={item.key}>
                  <Link
                    href={item.route ?? '/'}
                    className={active ? 'ops-nav__link ops-nav__link--active' : 'ops-nav__link'}
                    aria-current={active ? 'page' : undefined}
                    onClick={() => onNavigate?.()}
                  >
                    <span className="ops-nav__icon" aria-hidden="true">
                      <OpsIcon name={resource?.icon ?? 'dashboard'} />
                    </span>
                    <span>{item.label ?? item.name}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </nav>
  );
}
