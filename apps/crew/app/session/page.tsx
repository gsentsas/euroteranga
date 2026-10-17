import type { Metadata } from 'next';
import { CrewShell } from '../../components/crew-shell';
import { CrewWorkspace } from '../../components/crew-workspace';
import { publicEnv } from '../../lib/env';

export const metadata: Metadata = { title: 'Session équipage — EURO TERANGA Crew' };

export default function Page() {
  return (
    <CrewShell
      title="Opérations équipage"
      subtitle="Actions terrain, cache local et synchronisation avec le Core API."
      environment={publicEnv.NEXT_PUBLIC_APP_ENV}
    >
      <CrewWorkspace />
    </CrewShell>
  );
}
