import { FoundationShell } from '@euroteranga/ui';
import type { Metadata } from 'next';
import { CrewLoginForm } from '../../components/crew-login-form';
import { publicEnv } from '../../lib/env';

export const metadata: Metadata = { title: 'Connexion équipage — EURO TERANGA Crew' };

export default function Page() {
  return (
    <FoundationShell
      product="Crew"
      title="Connexion équipage"
      environment={publicEnv.NEXT_PUBLIC_APP_ENV}
    >
      <CrewLoginForm />
    </FoundationShell>
  );
}
