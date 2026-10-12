import { FoundationShell } from '@euroteranga/ui';
import { publicEnv } from '../lib/env';

export default function HomePage() {
  return (
    <FoundationShell
      product="Client"
      title="EURO TERANGA Client"
      subtitle="Foundation environment"
      environment={publicEnv.NEXT_PUBLIC_APP_ENV}
    >
      <p>L’espace client n’est pas encore disponible. Aucune donnée client n’est affichée.</p>
    </FoundationShell>
  );
}
