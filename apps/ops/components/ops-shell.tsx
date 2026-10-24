'use client';

import { FoundationShell } from '@euroteranga/ui';
import { Authenticated, useGetIdentity, useLogout } from '@refinedev/core';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { publicEnv } from '../lib/env';
import { OpsGlobalSearch } from './ops-global-search';
import { OpsIcon, OpsWingMark } from './ops-icons';
import { OpsNav } from './ops-nav';
import { opsGroupLabel, opsResourceForPath } from './ops-navigation';
import { OpsPageHeader } from './ops-ui';
import { AccessGate, AccessProvider, useAccess } from './staff-access';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function OpsBrand() {
  return (
    <Link className="ops-brand" href="/" aria-label="EURO TERANGA Ops — accueil">
      <span className="ops-brand__mark" aria-hidden="true">
        <OpsWingMark />
      </span>
      <span className="ops-brand__word">EURO TERANGA</span>
      <span className="ops-brand__product">OPS</span>
    </Link>
  );
}

function OpsTopbarActions() {
  const pathname = usePathname();
  const access = useAccess();
  const { data: identity } = useGetIdentity<{ id: string; email: string }>();
  const { mutate: logout, isPending } = useLogout();
  const accountId = useId();
  const [accountOpen, setAccountOpen] = useState(false);
  const accountButtonRef = useRef<HTMLButtonElement>(null);
  const roles = access.status === 'ready' ? access.access.roles : [];
  const permissions = access.status === 'ready' ? access.access.permissions : [];
  const email = identity?.email ?? 'Compte en cours de chargement';
  const initials = identity?.email.slice(0, 2).toLocaleUpperCase('fr-FR') ?? 'ET';

  useEffect(() => {
    setAccountOpen(false);
  }, [pathname]);

  return (
    <div className="ops-topbar__actions">
      <Link className="ops-command-centre" href="/" aria-label="Centre opérationnel">
        <OpsIcon name="building" />
        <span>Centre opérationnel</span>
      </Link>
      <span className="ops-environment">
        <span aria-hidden="true" />
        {publicEnv.NEXT_PUBLIC_APP_ENV}
      </span>
      {permissions.includes('incident.read') ? (
        <Link
          className="ops-icon-button ops-icon-button--dark"
          href="/incidents"
          aria-label="Consulter les incidents"
        >
          <OpsIcon name="bell" />
        </Link>
      ) : null}
      <div
        className="ops-account"
        data-open={accountOpen || undefined}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          setAccountOpen(false);
          accountButtonRef.current?.focus();
        }}
      >
        <button
          ref={accountButtonRef}
          type="button"
          className="ops-account__trigger"
          aria-label="Ouvrir le menu du compte"
          aria-expanded={accountOpen}
          aria-controls={accountOpen ? accountId : undefined}
          onClick={() => setAccountOpen((open) => !open)}
        >
          <span className="ops-account__avatar" aria-hidden="true">
            {initials}
          </span>
          <span className="ops-account__identity">
            <strong>{email}</strong>
            <small>{roles.length ? roles.join(', ') : 'Personnel OPS'}</small>
          </span>
          <OpsIcon name="chevron" />
        </button>
        {accountOpen ? (
          <div id={accountId} className="ops-account__menu">
            <div>
              <strong>{email}</strong>
              <span>{roles.length ? roles.join(', ') : 'Personnel OPS'}</span>
            </div>
            <button type="button" disabled={isPending} onClick={() => logout()}>
              Se déconnecter
            </button>
          </div>
        ) : null}
      </div>
    </div>
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
  const pathname = usePathname();
  const [navOpen, setNavOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const resource = opsResourceForPath(pathname);
  const foundation = {
    product: 'Ops',
    title,
    environment: publicEnv.NEXT_PUBLIC_APP_ENV,
  };

  useEffect(() => {
    if (!navOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setNavOpen(false);
        return;
      }
      if (event.key !== 'Tab' || !sidebarRef.current) return;
      const focusable = [...sidebarRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (!focusable.length) return;
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      window.requestAnimationFrame(() => menuButtonRef.current?.focus());
    };
  }, [navOpen]);

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
              ref={menuButtonRef}
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
            <OpsTopbarActions />
          </header>

          <aside
            ref={sidebarRef}
            id="ops-sidebar"
            className={navOpen ? 'ops-sidebar ops-sidebar--open' : 'ops-sidebar'}
            aria-label="Menu principal"
          >
            <div className="ops-sidebar__mobile-heading">
              <OpsBrand />
              <button
                ref={closeButtonRef}
                type="button"
                aria-label="Fermer le menu"
                onClick={() => setNavOpen(false)}
              >
                <OpsIcon name="close" />
              </button>
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
            <OpsPageHeader
              title={title}
              icon={resource.icon}
              group={opsGroupLabel(resource.group)}
              {...(subtitle ? { subtitle } : {})}
            />

            <div className="ops-page-content">
              <AccessGate>{children}</AccessGate>
            </div>
          </main>
        </div>
      </AccessProvider>
    </Authenticated>
  );
}
