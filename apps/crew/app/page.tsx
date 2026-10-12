import { FoundationShell } from '@euroteranga/ui';
import { publicEnv } from '../lib/env';

export default function HomePage() {
  return (
    <FoundationShell
      product="Crew"
      title="EURO TERANGA Crew"
      subtitle="Foundation environment"
      environment={publicEnv.NEXT_PUBLIC_APP_ENV}
    >
      <p>L’application équipage, y compris son mode hors ligne, n’est pas encore disponible.</p>
    </FoundationShell>
  );
}
