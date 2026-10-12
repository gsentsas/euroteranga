import { FoundationShell } from '@euroteranga/ui';
import { publicEnv } from '../lib/env';

export default function HomePage() {
  return (
    <FoundationShell
      title="EURO TERANGA"
      subtitle="Europe ↔ Afrique par la route"
      environment={publicEnv.NEXT_PUBLIC_APP_ENV}
    >
      <p>
        La plateforme est en cours de développement. Aucun service de réservation ou de transport
        n’est encore ouvert.
      </p>
    </FoundationShell>
  );
}
