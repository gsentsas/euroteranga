'use client';

import { FoundationShell } from '@euroteranga/ui';
import { Authenticated } from '@refinedev/core';
import type { ReactNode } from 'react';
import { publicEnv } from '../lib/env';
import { OpsNav } from './ops-nav';
import { AccessGate, AccessProvider } from './staff-access';

/**
 * Frame of every signed-in OPS page: a valid STAFF session (checked by the
 * API), then `ops.access` (also from the API), then the page itself.
 */
export function OpsShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  const shell = { product: 'Ops', title, environment: publicEnv.NEXT_PUBLIC_APP_ENV };
  return (
    <Authenticated
      key={title}
      redirectOnFail="/connexion"
      loading={
        <FoundationShell {...shell}>
          <p role="status">Vérification de la session…</p>
        </FoundationShell>
      }
    >
      <AccessProvider>
        <FoundationShell {...shell} {...(subtitle ? { subtitle } : {})} navigation={<OpsNav />}>
          <AccessGate>{children}</AccessGate>
        </FoundationShell>
      </AccessProvider>
    </Authenticated>
  );
}
