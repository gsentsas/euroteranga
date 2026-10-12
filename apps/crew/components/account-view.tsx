'use client';

import { SessionPanel, type SessionPanelData } from '@euroteranga/ui';
import { useRouter } from 'next/navigation';
import { useCallback } from 'react';
import { auth } from '../lib/auth';

/** Authenticated page body: the API decides whether the session is valid. */
export function AccountView() {
  const router = useRouter();
  const load = useCallback(async (): Promise<SessionPanelData | null> => {
    const [me, session] = await Promise.all([auth.me('crew'), auth.session('crew')]);
    if (!me.ok || !session.ok) {
      if ((!me.ok && me.error.status === 401) || (!session.ok && session.error.status === 401))
        return null;
      throw new Error('session check failed');
    }
    return {
      email: me.data.email,
      createdAt: session.data.createdAt,
      absoluteExpiresAt: session.data.absoluteExpiresAt,
    };
  }, []);
  const onUnauthenticated = useCallback(() => router.replace('/connexion'), [router]);
  const onLogout = useCallback(async () => {
    await auth.logout('crew');
    router.replace('/connexion');
  }, [router]);

  return <SessionPanel load={load} onUnauthenticated={onUnauthenticated} onLogout={onLogout} />;
}
