'use client';

import { useGetIdentity, useLogout } from '@refinedev/core';
import { useAccess } from './staff-access';

/** Shown inside OpsShell, i.e. for a STAFF session holding `ops.access`. */
export function StaffHome() {
  const { data: identity } = useGetIdentity<{ id: string; email: string }>();
  const { mutate: logout, isPending } = useLogout();
  const state = useAccess();
  const roles = state.status === 'ready' ? state.access.roles : [];
  return (
    <section aria-labelledby="staff-session-title">
      <h2 id="staff-session-title">Session</h2>
      <p>
        Connecté en tant que <strong data-testid="session-email">{identity?.email ?? '…'}</strong>.
      </p>
      <p>
        Rôles : <span data-testid="session-roles">{roles.length ? roles.join(', ') : 'aucun'}</span>
      </p>
      <p>
        Utilisez la navigation pour accéder aux espaces autorisés pour vos rôles. Les données du
        réseau sont disponibles aux profils disposant de la permission de lecture correspondante.
      </p>
      <button type="button" className="et-button" disabled={isPending} onClick={() => logout()}>
        Se déconnecter
      </button>
    </section>
  );
}
