'use client';

import { Refine } from '@refinedev/core';
import routerProvider from '@refinedev/nextjs-router/app';
import { Suspense, type ReactNode } from 'react';
import { authProvider } from '../lib/auth-provider';
import { OPS_RESOURCES } from '../components/ops-navigation';

/**
 * Refine is used as a UI framework only (navigation, and later tables, forms
 * and filters). It holds no business authority: there is no data provider
 * yet, and future ones will call the Core API, never the database. The auth
 * provider asks the API for the STAFF session.
 *
 * The Suspense boundary is required because the Next.js router provider reads
 * useSearchParams(), which would otherwise opt every page out of prerendering.
 */
export function RefineProvider({ children }: { children: ReactNode }) {
  return (
    <Suspense>
      <Refine
        routerProvider={routerProvider}
        authProvider={authProvider}
        resources={OPS_RESOURCES.map((resource) => ({
          name: resource.name,
          list: resource.list,
          meta: {
            label: resource.label,
            group: resource.group,
            ...(resource.permission ? { permission: resource.permission } : {}),
          },
        }))}
        options={{
          // Refine reports usage telemetry unless explicitly disabled.
          disableTelemetry: true,
          syncWithLocation: false,
        }}
      >
        {children}
      </Refine>
    </Suspense>
  );
}
