import { FoundationShell } from '@euroteranga/ui';
import { BookingFlow } from '../components/booking-flow';
import { publicEnv } from '../lib/env';

export default function HomePage() {
  return (
    <FoundationShell
      product="Booking"
      title="EURO TERANGA Booking"
      subtitle="Choisissez votre trajet et retenez vos sièges"
      environment={publicEnv.NEXT_PUBLIC_APP_ENV}
    >
      <BookingFlow />
    </FoundationShell>
  );
}
