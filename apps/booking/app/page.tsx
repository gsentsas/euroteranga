import { JourneyShell } from '@euroteranga/ui';
import { BookingFlow } from '../components/booking-flow';
import { journeyLinks, publicEnv } from '../lib/env';

export default function HomePage() {
  return (
    <JourneyShell
      area="Réservation"
      title="Réservez votre Paris ↔ Dakar."
      subtitle="Recherchez un départ réellement ouvert, choisissez votre siège et gardez le contrôle jusqu’à la confirmation."
      environment={publicEnv.NEXT_PUBLIC_APP_ENV}
      links={journeyLinks}
      current="booking"
    >
      <BookingFlow />
    </JourneyShell>
  );
}
