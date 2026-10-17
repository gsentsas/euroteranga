'use client';

import { useGetIdentity, useLogout } from '@refinedev/core';
import Link from 'next/link';
import { useAccess } from './staff-access';

const shortcuts = [
  {
    href: '/trips',
    label: 'Voyages',
    description: 'Planifier et suivre les rotations.',
    permission: 'trip.read',
  },
  {
    href: '/departure',
    label: 'Départ / Dispatch',
    description: 'Contrôler la readiness avant départ.',
    permission: 'departure.read',
  },
  {
    href: '/bookings',
    label: 'Réservations',
    description: 'Consulter les dossiers voyageurs.',
    permission: 'booking.read',
  },
  {
    href: '/incidents',
    label: 'Incidents',
    description: 'Suivre les anomalies opérationnelles.',
    permission: 'incident.read',
  },
] as const;

/** Shown inside OpsShell for a STAFF session holding ops.access. */
export function StaffHome() {
  const { data: identity } = useGetIdentity<{ id: string; email: string }>();
  const { mutate: logout, isPending } = useLogout();
  const state = useAccess();
  const roles = state.status === 'ready' ? state.access.roles : [];
  const permissions = state.status === 'ready' ? state.access.permissions : [];

  return (
    <div className="ops-dashboard">
      <section className="ops-dashboard__welcome" aria-labelledby="staff-session-title">
        <div>
          <p className="ops-dashboard__eyebrow">Session active</p>
          <h2 id="staff-session-title">Poste de travail opérationnel</h2>
          <p>
            Connecté en tant que{' '}
            <strong data-testid="session-email">{identity?.email ?? '…'}</strong>. Utilisez
            uniquement les espaces autorisés pour vos fonctions.
          </p>
        </div>
        <button
          type="button"
          className="et-button et-button--secondary"
          disabled={isPending}
          onClick={() => logout()}
        >
          Se déconnecter
        </button>
      </section>

      <section className="ops-dashboard__stats" aria-label="Contexte de session">
        <article>
          <span>Rôle(s)</span>
          <strong data-testid="session-roles">{roles.length ? roles.join(', ') : 'aucun'}</strong>
        </article>
        <article>
          <span>Permissions actives</span>
          <strong>{permissions.length}</strong>
        </article>
        <article>
          <span>Accès</span>
          <strong>Contrôlé par l’API</strong>
        </article>
      </section>

      <section aria-labelledby="ops-shortcuts-title">
        <div className="ops-section-heading">
          <div>
            <p className="ops-dashboard__eyebrow">Accès rapide</p>
            <h2 id="ops-shortcuts-title">Priorités opérationnelles</h2>
          </div>
        </div>
        <div className="ops-dashboard__shortcuts">
          {shortcuts
            .filter((shortcut) => permissions.includes(shortcut.permission))
            .map((shortcut) => (
              <Link href={shortcut.href} className="ops-shortcut-card" key={shortcut.href}>
                <span className="ops-shortcut-card__arrow" aria-hidden="true">
                  →
                </span>
                <strong>{shortcut.label}</strong>
                <span>{shortcut.description}</span>
              </Link>
            ))}
        </div>
      </section>

      <section className="ops-dashboard__note">
        <strong>Principe de sécurité</strong>
        <p>
          La navigation adapte ce qui est affiché à vos permissions, mais chaque action sensible est
          de nouveau autorisée côté Core API.
        </p>
      </section>
    </div>
  );
}
