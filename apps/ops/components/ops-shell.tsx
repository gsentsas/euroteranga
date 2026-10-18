'use client';

import { FoundationShell } from '@euroteranga/ui';
import { Authenticated } from '@refinedev/core';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { publicEnv } from '../lib/env';
import { OpsGlobalSearch } from './ops-global-search';
import { OpsNav } from './ops-nav';
import { AccessGate, AccessProvider } from './staff-access';

function OpsBrand() {
  return (
    <Link className="ops-brand" href="/" aria-label="EURO TERANGA Ops — accueil">
      <span className="ops-brand__mark" aria-hidden="true">
        ET
      </span>
      <span className="ops-brand__word">
        EURO <strong>TERANGA</strong>
      </span>
      <span className="ops-brand__product">OPS</span>
    </Link>
  );
}

/**
 * Authenticated operations workbench.
 *
 * UI visibility is still only a convenience: AccessProvider filters what is
 * shown, while every Core API endpoint re-checks the caller's permissions.
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
  const [navOpen, setNavOpen] = useState(false);
  const foundation = {
    product: 'Ops',
    title,
    environment: publicEnv.NEXT_PUBLIC_APP_ENV,
  };

  return (
    <Authenticated
      key={title}
      redirectOnFail="/connexion"
      loading={
        <FoundationShell {...foundation}>
          <p role="status">Vérification de la session…</p>
        </FoundationShell>
      }
    >
      <AccessProvider>
        <div className="ops-workbench">
          <a className="et-skip-link" href="#main">
            Aller au contenu
          </a>

          <header className="ops-topbar">
            <OpsBrand />
            <button
              type="button"
              className="ops-nav-toggle"
              aria-controls="ops-sidebar"
              aria-expanded={navOpen}
              onClick={() => setNavOpen((open) => !open)}
            >
              <span aria-hidden="true">☰</span>
              <span>Menu</span>
            </button>
            <OpsGlobalSearch />
            <div className="ops-topbar__meta">
              <span className="ops-live-indicator">
                <span aria-hidden="true" />
                Centre opérationnel
              </span>
              <span className="ops-environment">{publicEnv.NEXT_PUBLIC_APP_ENV}</span>
            </div>
          </header>

          <aside
            id="ops-sidebar"
            className={navOpen ? 'ops-sidebar ops-sidebar--open' : 'ops-sidebar'}
          >
            <div className="ops-sidebar__mobile-heading">
              <strong>Navigation</strong>
              <button type="button" aria-label="Fermer le menu" onClick={() => setNavOpen(false)}>
                ×
              </button>
            </div>
            <div className="ops-sidebar__heading">
              <span>Navigation</span>
              <strong>Opérations</strong>
            </div>
            <OpsNav onNavigate={() => setNavOpen(false)} />
            <div className="ops-sidebar__footer">
              <span>EURO TERANGA</span>
              <small>Back-office interne · accès contrôlé</small>
            </div>
          </aside>

          {navOpen ? (
            <button
              type="button"
              className="ops-sidebar-backdrop"
              aria-label="Fermer le menu"
              onClick={() => setNavOpen(false)}
            />
          ) : null}

          <main id="main" className="ops-main" tabIndex={-1}>
            <header className="ops-page-header">
              <div>
                <p className="ops-page-kicker">Centre des opérations</p>
                <h1>{title}</h1>
                {subtitle ? <p className="ops-page-subtitle">{subtitle}</p> : null}
              </div>
            </header>

            <div className="ops-page-content">
              <AccessGate>{children}</AccessGate>
            </div>
          </main>
        </div>
      </AccessProvider>
    </Authenticated>
  );
}
