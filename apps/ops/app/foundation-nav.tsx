'use client';

import { useMenu } from '@refinedev/core';
import Link from 'next/link';

/** Navigation built from the Refine resource registry. */
export function FoundationNav() {
  const { menuItems, selectedKey } = useMenu();

  return (
    <nav className="et-nav" aria-label="Navigation principale">
      <ul>
        {menuItems.map((item) => (
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
