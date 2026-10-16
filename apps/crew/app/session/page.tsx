import { FoundationShell } from '@euroteranga/ui';
import type { Metadata } from 'next';
import { CrewWorkspace } from '../../components/crew-workspace';
import { publicEnv } from '../../lib/env';

export const metadata: Metadata = { title: 'Session équipage — EURO TERANGA Crew' };

export default function Page() {
  return (
    <FoundationShell
      product="Crew"
      title="Opérations équipage"
      environment={publicEnv.NEXT_PUBLIC_APP_ENV}
    >
      <CrewWorkspace />
    </FoundationShell>
  );
}
