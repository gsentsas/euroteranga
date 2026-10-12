'use client';

import type { AdminAuditEvent } from '@euroteranga/auth-client';
import { useCallback, useEffect, useState } from 'react';
import { auth } from '../../lib/auth';

const dateFormat = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'medium' });

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

  if (error) {
    return (
      <div className="et-alert" role="alert">
        {error}
      </div>
    );
  }
  if (!events) return <p role="status">Chargement…</p>;
  return (
    <>
      <div className="et-table-wrap">
        <table className="et-table">
          <caption>Événements d’administration (les plus récents d’abord)</caption>
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Action</th>
              <th scope="col">Auteur</th>
              <th scope="col">Ressource</th>
              <th scope="col">Requête</th>
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
                  <span className="et-tag">{event.action}</span>
                </td>
                <td>{event.actor ? event.actor.email : 'Système'}</td>
                <td>
                  {event.resourceType}
                  {event.resourceId ? ` ${event.resourceId}` : ''}
                </td>
                <td className="et-hint">{event.requestId ?? '—'}</td>
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
    </>
  );
}
