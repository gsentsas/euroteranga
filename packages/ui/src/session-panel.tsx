'use client';

import { useEffect, useState } from 'react';
import { FormAlert } from './forms.js';

export interface SessionPanelData {
  email: string;
  createdAt: string;
  absoluteExpiresAt: string;
}

export interface SessionPanelProps {
  /** Asks the server; null means "not authenticated" (never a client flag). */
  load: () => Promise<SessionPanelData | null>;
  onUnauthenticated: () => void;
  onLogout: () => Promise<void>;
}

const formatDate = (value: string) =>
  new Intl.DateTimeFormat('fr-FR', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(value)) + ' UTC';

/** Minimal authenticated view: identity and current session, with logout. */
export function SessionPanel({ load, onUnauthenticated, onLogout }: SessionPanelProps) {
  const [data, setData] = useState<SessionPanelData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let active = true;
    load()
      .then((result) => {
        if (!active) return;
        if (result) setData(result);
        else onUnauthenticated();
      })
      .catch(
        () => active && setError('Impossible de vérifier votre session. Réessayez plus tard.'),
      );
    return () => {
      active = false;
    };
  }, [load, onUnauthenticated]);

  if (error) return <FormAlert message={error} />;
  if (!data) return <p role="status">Vérification de la session…</p>;

  return (
    <section aria-labelledby="session-title">
      <h2 id="session-title">Votre session</h2>
      <dl>
        <dt>Adresse e-mail</dt>
        <dd data-testid="session-email">{data.email}</dd>
        <dt>Connecté depuis</dt>
        <dd>{formatDate(data.createdAt)}</dd>
        <dt>Expiration au plus tard</dt>
        <dd>{formatDate(data.absoluteExpiresAt)}</dd>
      </dl>
      <button
        type="button"
        className="et-button"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          try {
            await onLogout();
          } finally {
            setPending(false);
          }
        }}
      >
        Se déconnecter
      </button>
    </section>
  );
}
