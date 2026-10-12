import { FoundationShell } from '@euroteranga/ui';
import { publicEnv } from '../lib/env';

export default function HomePage() {
  return (
    <FoundationShell
      product="Booking"
      title="EURO TERANGA Booking"
      subtitle="Foundation environment"
      environment={publicEnv.NEXT_PUBLIC_APP_ENV}
    >
      <p>
        Le moteur de réservation n’est pas encore disponible. Aucune réservation ne peut être
        effectuée.
      </p>
    </FoundationShell>
  );
}
