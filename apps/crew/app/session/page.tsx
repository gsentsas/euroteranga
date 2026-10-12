import { FoundationShell } from '@euroteranga/ui';
import type { Metadata } from 'next';
import { AccountView } from '../../components/account-view';
import { publicEnv } from '../../lib/env';

export const metadata: Metadata = { title: 'Session équipage — EURO TERANGA Crew' };

export default function Page() {
  return (
    <FoundationShell
      product="Crew"
      title="Session équipage"
      environment={publicEnv.NEXT_PUBLIC_APP_ENV}
    >
      <p>Les fonctions voyage et hors ligne ne sont pas encore disponibles.</p>
      <AccountView />
    </FoundationShell>
  );
}
