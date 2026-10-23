import { JourneyShell } from '@euroteranga/ui';
import type { Metadata } from 'next';
import { AccountView } from '../../components/account-view';
import { CustomerBaggage } from '../../components/customer-baggage';
import { CustomerBookings } from '../../components/customer-bookings';
import { CustomerCheckIn } from '../../components/customer-check-in';
import { CustomerCargo } from '../../components/customer-cargo';
import { CustomerCompliance } from '../../components/customer-compliance';
import { CustomerPassengers } from '../../components/customer-passengers';
import { publicEnv } from '../../lib/env';

export const metadata: Metadata = { title: 'Mon espace — EURO TERANGA' };

export default function Page() {
  return (
    <JourneyShell
      area="Mon espace"
      title="Préparez votre voyage."
      subtitle="Réservations, voyageurs, documents, bagages et check-in réunis dans un seul espace."
      environment={publicEnv.NEXT_PUBLIC_APP_ENV}
      current="client"
    >
      <div className="et-account-sections">
        <AccountView />
        <CustomerBookings />
        <CustomerPassengers />
        <CustomerCompliance />
        <CustomerBaggage />
        <CustomerCargo />
        <CustomerCheckIn />
      </div>
    </JourneyShell>
  );
}
