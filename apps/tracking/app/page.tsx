import { FoundationShell } from '@euroteranga/ui';
import { publicEnv } from '../lib/env';

export default function HomePage() {
  return (
    <FoundationShell
      product="Tracking"
      title="EURO TERANGA Tracking"
      subtitle="Foundation environment"
      environment={publicEnv.NEXT_PUBLIC_APP_ENV}
    >
      <p>
        Aucun suivi de voyage n’est disponible. Aucune position, réelle ou simulée, n’est affichée.
      </p>
    </FoundationShell>
  );
}
