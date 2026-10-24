'use client';

import { useGetIdentity, useLogout } from '@refinedev/core';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { auth } from '../lib/auth';
import type { OpsIconName } from './ops-icons';
import { OpsKpiCard } from './ops-ui';
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

type DashboardMetric = {
  key: string;
  label: string;
  value: string;
  detail: string;
  href: string;
  permission: string;
  tone?: 'default' | 'warning' | 'danger';
};

const METRIC_ICONS: Record<string, OpsIconName> = {
  trips: 'route',
  incidents: 'alert',
  payments: 'payment',
  checkin: 'check',
};

function pageCount(items: readonly unknown[], nextCursor: string | null): string {
  return `${items.length}${nextCursor ? '+' : ''}`;
}

/** Shown inside OpsShell for a STAFF session holding ops.access. */
export function StaffHome() {
  const { data: identity } = useGetIdentity<{ id: string; email: string }>();
  const { mutate: logout, isPending } = useLogout();
  const state = useAccess();
  const roles = state.status === 'ready' ? state.access.roles : [];
  const permissions = state.status === 'ready' ? state.access.permissions : [];
  const [metrics, setMetrics] = useState<Record<string, DashboardMetric>>({});
  const [pulseLoading, setPulseLoading] = useState(false);

  const can = useMemo(() => new Set(permissions), [permissions]);

  useEffect(() => {
    if (state.status !== 'ready') return;

    let cancelled = false;
    const jobs: Array<Promise<DashboardMetric | null>> = [];

    if (can.has('trip.read')) {
      jobs.push(
        auth.admin.trips.trips({ limit: 100 }).then((result) => {
          if (!result.ok) return null;
          const active = result.data.items.filter((trip) =>
            ['SCHEDULED', 'IN_PROGRESS'].includes(trip.status),
          );
          return {
            key: 'trips',
            label: 'Voyages actifs',
            value: pageCount(active, result.data.nextCursor),
            detail: 'Planifiés ou en cours',
            href: '/trips',
            permission: 'trip.read',
          } satisfies DashboardMetric;
        }),
      );
    }

    if (can.has('incident.read')) {
      jobs.push(
        auth.admin.incidents.list({ limit: 100 }).then((result) => {
          if (!result.ok) return null;
          const open = result.data.items.filter(
            (incident) => !['RESOLVED', 'CLOSED'].includes(incident.status),
          );
          const critical = open.filter((incident) =>
            ['HIGH', 'CRITICAL'].includes(incident.severity),
          ).length;
          return {
            key: 'incidents',
            label: 'Incidents ouverts',
            value: pageCount(open, result.data.nextCursor),
            detail: critical ? `${critical} haute priorité` : 'Aucune haute priorité',
            href: '/incidents',
            permission: 'incident.read',
            tone: critical ? 'danger' : 'default',
          } satisfies DashboardMetric;
        }),
      );
    }

    if (can.has('payment.read')) {
      jobs.push(
        auth.admin.payments.listPayments({ status: 'PENDING', limit: 100 }).then((result) => {
          if (!result.ok) return null;
          return {
            key: 'payments',
            label: 'Paiements à vérifier',
            value: pageCount(result.data.items, result.data.nextCursor),
            detail: 'Tentatives encore en attente',
            href: '/payments',
            permission: 'payment.read',
            tone: result.data.items.length ? 'warning' : 'default',
          } satisfies DashboardMetric;
        }),
      );
    }

    if (can.has('checkin.read')) {
      jobs.push(
        auth.admin.checkIn.list({ checkInStatus: 'NOT_CHECKED_IN', limit: 100 }).then((result) => {
          if (!result.ok) return null;
          const blocked = result.data.items.filter((item) => !item.readiness.eligible).length;
          return {
            key: 'checkin',
            label: 'Check-in restant',
            value: pageCount(result.data.items, result.data.nextCursor),
            detail: blocked ? `${blocked} dossier(s) bloqué(s)` : 'Aucun blocage dans la liste',
            href: '/check-in',
            permission: 'checkin.read',
            tone: blocked ? 'warning' : 'default',
          } satisfies DashboardMetric;
        }),
      );
    }

    if (!jobs.length) {
      setMetrics({});
      return;
    }

    setPulseLoading(true);
    void Promise.all(jobs)
      .then((items) => {
        if (cancelled) return;
        setMetrics(
          Object.fromEntries(
            items
              .filter((item): item is DashboardMetric => item !== null)
              .map((item) => [item.key, item]),
          ),
        );
      })
      .finally(() => {
        if (!cancelled) setPulseLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [can, state.status]);

  const visibleMetrics = Object.values(metrics).filter((metric) => can.has(metric.permission));

  return (
    <div className="ops-dashboard">
      <section className="ops-dashboard__welcome" aria-labelledby="staff-session-title">
        <div>
          <p className="ops-dashboard__eyebrow">Session active</p>
          <h2 id="staff-session-title">Poste de travail opérationnel</h2>
          <p>
            Connecté en tant que{' '}
            <strong data-testid="session-email">{identity?.email ?? '…'}</strong>. Les indicateurs
            ci-dessous utilisent uniquement les données autorisées pour votre rôle.
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

      {visibleMetrics.length || pulseLoading ? (
        <section aria-labelledby="ops-pulse-title" data-testid="ops-operational-pulse">
          <div className="ops-section-heading ops-section-heading--split">
            <div>
              <p className="ops-dashboard__eyebrow">Vue opérationnelle</p>
              <h2 id="ops-pulse-title">À surveiller maintenant</h2>
            </div>
            {pulseLoading ? <span className="ops-dashboard__loading">Actualisation…</span> : null}
          </div>
          <div className="ops-dashboard__pulse">
            {visibleMetrics.map((metric) => (
              <OpsKpiCard
                key={metric.key}
                href={metric.href}
                label={metric.label}
                value={metric.value}
                helper={metric.detail}
                icon={METRIC_ICONS[metric.key] ?? 'dashboard'}
                tone={metric.tone && metric.tone !== 'default' ? metric.tone : 'info'}
              />
            ))}
          </div>
        </section>
      ) : null}

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
