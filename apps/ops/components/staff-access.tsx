'use client';

import type { AccessInfo } from '@euroteranga/auth-client';
import { useLogout } from '@refinedev/core';
import { useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { auth } from '../lib/auth';
import { OpsState } from './ops-state';

/** Permission a STAFF identity needs to use the operations back-office. */
export const OPS_ACCESS = 'ops.access';

type AccessState =
  | { status: 'loading' }
  | { status: 'ready'; access: AccessInfo }
  | { status: 'denied' }
  | { status: 'error'; message: string };

const AccessContext = createContext<AccessState>({ status: 'loading' });

/**
 * Loads the caller's roles and permissions from `GET /v1/admin/access/me`.
 * They only decide what the interface shows: every API call is authorized
 * again by the server, so hiding a button is never the protection.
 */
export function AccessProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [state, setState] = useState<AccessState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void auth.admin.access().then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setState(
          result.data.permissions.includes(OPS_ACCESS)
            ? { status: 'ready', access: result.data }
            : { status: 'denied' },
        );
      } else if (result.error.status === 401) {
        router.replace('/connexion');
      } else {
        setState({ status: 'error', message: result.error.message });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [router]);

  return <AccessContext.Provider value={state}>{children}</AccessContext.Provider>;
}

export function useAccess(): AccessState {
  return useContext(AccessContext);
}

/** True when the loaded access includes every given permission. */
export function useCan(...permissions: string[]): boolean {
  const state = useAccess();
  return (
    state.status === 'ready' &&
    permissions.every((permission) => state.access.permissions.includes(permission))
  );
}

function AccessDenied() {
  const { mutate: logout, isPending } = useLogout();
  return (
    <section aria-labelledby="access-denied-title">
      <h2 id="access-denied-title">Accès refusé</h2>
      <p>
        Votre compte est bien connecté, mais il n’a pas accès au back-office des opérations.
        Contactez un administrateur si vous pensez qu’il s’agit d’une erreur.
      </p>
      <button type="button" className="et-button" disabled={isPending} onClick={() => logout()}>
        Se déconnecter
      </button>
    </section>
  );
}

/** Renders its children only once the caller holds `ops.access`. */
export function AccessGate({ children }: { children: ReactNode }) {
  const state = useAccess();
  if (state.status === 'loading') {
    return (
      <OpsState
        kind="loading"
        title="Vérification des accès"
        detail="Contrôle des permissions de votre session…"
      />
    );
  }
  if (state.status === 'denied') return <AccessDenied />;
  if (state.status === 'error') {
    return (
      <OpsState
        kind="error"
        title="Impossible de vérifier les accès"
        detail={state.message}
      />
    );
  }
  return children;
}

/** Page-level display check; the API refuses the underlying calls anyway. */
export function RequirePermission({
  permission,
  children,
}: {
  permission: string;
  children: ReactNode;
}) {
  if (!useCan(permission)) {
    return (
      <OpsState
        kind="error"
        title="Accès insuffisant"
        detail="Vous n’avez pas la permission d’afficher cette page."
      />
    );
  }
  return children;
}
