'use client';

import type { AdminAuditEvent } from '@euroteranga/auth-client';
import { useCallback, useEffect, useState } from 'react';
import { auth } from '../../lib/auth';
import { OpsErrorState, OpsLoadingState } from '../ops-data-state';
import { OpsKpiCard } from '../ops-ui';

const dateFormat = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'medium' });

/** Display grouping by action name only; the audit trail itself is never altered. */
const IDENTITY_ACTION = /^(STAFF_|IDENTITY_|SESSIONS_|SUPER_ADMIN_)/;
const ROLE_ACTION = /^ROLE_/;

/** Append-only audit trail, newest first, paginated by cursor. */
export function AuditLog() {
  const [events, setEvents] = useState<AdminAuditEvent[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (cursor?: string) => {
    const result = await auth.admin.audit(cursor ? { cursor } : {});
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setEvents((previous) =>
      cursor ? [...(previous ?? []), ...result.data.items] : result.data.items,
    );
    setNextCursor(result.data.nextCursor);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error)
    return <OpsErrorState title="Impossible de charger le journal d’audit" message={error} />;
  if (!events) return <OpsLoadingState title="Chargement du journal…" />;
  const identityCount = events.filter((event) => IDENTITY_ACTION.test(event.action)).length;
  const roleCount = events.filter((event) => ROLE_ACTION.test(event.action)).length;
  const systemCount = events.filter((event) => !event.actor).length;

  return (
    <div className="et-network ops-operations-workspace ops-ground-workspace ops-admin-workspace">
      <div className="ops-operations-intro">
        <div>
          <p className="ops-operations-eyebrow">Traçabilité</p>
          <h2>Événements d’administration</h2>
          <p>
            Les événements les plus récents apparaissent d’abord. L’identifiant de requête relie un
            événement aux journaux techniques pour le diagnostic.
          </p>
        </div>
      </div>
      <p className="ops-ground-guardrail ops-ground-guardrail--strong">
        Journal append-only : aucun événement ne se modifie, ne se supprime ni ne se réécrit.
      </p>
      <section className="ops-operations-kpis" aria-label="Indicateurs des événements affichés">
        <OpsKpiCard
          label="Événements affichés"
          value={events.length}
          helper={nextCursor ? 'Éléments chargés · liste partielle' : 'Tous les événements chargés'}
          icon="audit"
          tone="info"
        />
        <OpsKpiCard
          label="Actions d’identité"
          value={identityCount}
          helper="Invitations, statuts, sessions"
          icon="users"
          tone="neutral"
        />
        <OpsKpiCard
          label="Actions de rôle"
          value={roleCount}
          helper="Attributions et retraits"
          icon="roles"
          tone="neutral"
        />
        <OpsKpiCard
          label="Actions système"
          value={systemCount}
          helper="Sans auteur humain"
          icon="shield"
          tone="neutral"
        />
      </section>
      {nextCursor ? (
        <p className="ops-ground-partial" role="note">
          Données partielles — d’autres événements sont disponibles. Les indicateurs ne portent que
          sur les {events.length} événements chargés.
        </p>
      ) : null}
      <section
        className="ops-operations-section ops-operations-section--primary"
        aria-labelledby="audit-list-title"
      >
        <div className="et-actions">
          <div>
            <p className="ops-operations-section-kicker">Lecture seule</p>
            <h2 id="audit-list-title">Journal</h2>
          </div>
        </div>
        <div className="et-table-wrap">
          <table className="et-table">
            <caption>Événements d’administration (les plus récents d’abord)</caption>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Action</th>
                <th scope="col">Auteur</th>
                <th scope="col">Ressource</th>
                <th scope="col">Request ID</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id}>
                  <td>
                    <time dateTime={event.occurredAt}>
                      {dateFormat.format(new Date(event.occurredAt))}
                    </time>
                  </td>
                  <td>
                    <span className="ops-code-chip">{event.action}</span>
                  </td>
                  <td>{event.actor ? event.actor.email : 'Système'}</td>
                  <td>
                    {event.resourceType}
                    {event.resourceId ? (
                      <>
                        {' '}
                        <span className="et-code">{event.resourceId}</span>
                      </>
                    ) : null}
                  </td>
                  <td className="et-code">{event.requestId ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {nextCursor ? (
          <button
            type="button"
            className="et-button et-button--secondary"
            onClick={() => void load(nextCursor)}
          >
            Afficher plus
          </button>
        ) : null}
      </section>
    </div>
  );
}
