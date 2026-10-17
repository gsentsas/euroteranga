'use client';

import { useMenu } from '@refinedev/core';
import Link from 'next/link';
import { useAccess } from './staff-access';

const GROUPS: ReadonlyArray<{ key: string; label: string; resources: readonly string[] }> = [
  {
    key: 'pilotage',
    label: 'Pilotage',
    resources: ['foundation', 'network', 'fleet', 'trips', 'tracking', 'incidents'],
  },
  {
    key: 'commercial',
    label: 'Commercial & finance',
    resources: ['seat-maps', 'pricing', 'bookings', 'payments', 'finance', 'reporting'],
  },
  {
    key: 'exploitation',
    label: 'Exploitation',
    resources: ['baggage', 'check-in', 'manifests', 'regulatory-permits', 'departure'],
  },
  {
    key: 'compliance',
    label: 'Conformité',
    resources: ['passenger-documents', 'compliance-rules', 'compliance-reviews'],
  },
  {
    key: 'admin',
    label: 'Administration',
    resources: ['admin-identities', 'admin-roles', 'admin-audit'],
  },
];

function resourceGroup(name: string): (typeof GROUPS)[number] {
  return GROUPS.find((group) => group.resources.includes(name)) ?? GROUPS[0]!;
}

/**
 * Navigation built from the Refine resource registry and filtered with the
 * permissions returned by the Core API. This is display-only; the server
 * authorizes every underlying request independently.
 */
export function OpsNav() {
  const { menuItems, selectedKey } = useMenu();
  const state = useAccess();
  if (state.status !== 'ready') return null;

  const visible = menuItems.filter((item) => {
    const permission: unknown = item.meta?.permission;
    return typeof permission !== 'string' || state.access.permissions.includes(permission);
  });

  const grouped = GROUPS.map((group) => ({
    ...group,
    items: visible.filter((item) => resourceGroup(item.name).key === group.key),
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
              return (
                <li key={item.key}>
                  <Link
                    href={item.route ?? '/'}
                    className={active ? 'ops-nav__link ops-nav__link--active' : 'ops-nav__link'}
                    aria-current={active ? 'page' : undefined}
                  >
                    <span className="ops-nav__bullet" aria-hidden="true" />
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
