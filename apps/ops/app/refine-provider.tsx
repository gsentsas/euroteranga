'use client';

import { Refine } from '@refinedev/core';
import routerProvider from '@refinedev/nextjs-router/app';
import { Suspense, type ReactNode } from 'react';
import { authProvider } from '../lib/auth-provider';

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
        resources={[
          { name: 'foundation', list: '/', meta: { label: 'Foundation' } },
          {
            name: 'network',
            list: '/network',
            meta: { label: 'Réseau', permission: 'network.read' },
          },
          {
            name: 'fleet',
            list: '/fleet',
            meta: { label: 'Flotte', permission: 'fleet.read' },
          },
          {
            name: 'trips',
            list: '/trips',
            meta: { label: 'Voyages', permission: 'trip.read' },
          },
          {
            name: 'seat-maps',
            list: '/seat-maps',
            meta: { label: 'Plans de sièges', permission: 'seatmap.read' },
          },
          {
            name: 'pricing',
            list: '/pricing',
            meta: { label: 'Tarification', permission: 'pricing.read' },
          },
          {
            name: 'bookings',
            list: '/bookings',
            meta: { label: 'Réservations', permission: 'booking.read' },
          },
          {
            name: 'payments',
            list: '/payments',
            meta: { label: 'Paiements', permission: 'payment.read' },
          },
          {
            name: 'baggage',
            list: '/baggage',
            meta: { label: 'Bagages', permission: 'baggage.read' },
          },
          {
            name: 'check-in',
            list: '/check-in',
            meta: { label: 'Check-in / Embarquement', permission: 'checkin.read' },
          },
          {
            name: 'manifests',
            list: '/manifests',
            meta: { label: 'Manifestes passagers', permission: 'manifest.read' },
          },
          {
            name: 'regulatory-permits',
            list: '/regulatory-permits',
            meta: { label: 'Autorisations réglementaires', permission: 'permit.read' },
          },
          {
            name: 'departure',
            list: '/departure',
            meta: { label: 'Départ / Dispatch', permission: 'departure.read' },
          },
          // Compliance group: PR-11 technical files and PR-12 rules/reviews.
          // PR-16 permits and PR-17 dispatch remain separate operational domains.
          {
            name: 'passenger-documents',
            list: '/passenger-documents',
            meta: {
              label: 'Documents passagers',
              permission: 'passenger.document.read',
              group: 'Conformité',
            },
          },
          {
            name: 'compliance-rules',
            list: '/compliance/rules',
            meta: {
              label: 'Règles réglementaires',
              permission: 'compliance.rule.read',
              group: 'Conformité',
            },
          },
          {
            name: 'compliance-reviews',
            list: '/compliance/reviews',
            meta: { label: 'Revues passagers', permission: 'compliance.read', group: 'Conformité' },
          },
          // `permission` only filters the navigation; the API authorizes every call.
          {
            name: 'admin-identities',
            list: '/admin/utilisateurs',
            meta: { label: 'Utilisateurs', permission: 'identity.read' },
          },
          {
            name: 'admin-roles',
            list: '/admin/roles',
            meta: { label: 'Rôles', permission: 'role.read' },
          },
          {
            name: 'admin-audit',
            list: '/admin/audit',
            meta: { label: 'Journal d’audit', permission: 'audit.read' },
          },
        ]}
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
