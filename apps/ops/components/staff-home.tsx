'use client';

import { Authenticated, useGetIdentity, useLogout } from '@refinedev/core';

function StaffSession() {
  const { data: identity } = useGetIdentity<{ id: string; email: string }>();
  const { mutate: logout, isPending } = useLogout();
  return (
    <section aria-labelledby="staff-session-title">
      <h2 id="staff-session-title">Session</h2>
      <p>
        Connecté en tant que <strong data-testid="session-email">{identity?.email ?? '…'}</strong>.
      </p>
      <p>
        Le back-office des opérations n’est pas encore disponible. Aucune donnée opérationnelle
        n’est affichée et aucun indicateur n’est calculé.
      </p>
      <button type="button" className="et-button" disabled={isPending} onClick={() => logout()}>
        Se déconnecter
      </button>
    </section>
  );
}

/** Rendered only for a valid STAFF session (checked by the API). */
export function StaffHome() {
  return (
    <Authenticated
      key="ops-home"
      redirectOnFail="/connexion"
      loading={<p role="status">Vérification de la session…</p>}
    >
      <StaffSession />
    </Authenticated>
  );
}
