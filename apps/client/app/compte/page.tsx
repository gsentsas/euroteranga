import { FoundationShell } from '@euroteranga/ui';
import type { Metadata } from 'next';
import { AccountView } from '../../components/account-view';
import { CustomerBookings } from '../../components/customer-bookings';
import { publicEnv } from '../../lib/env';

export const metadata: Metadata = { title: 'Mon compte — EURO TERANGA Client' };

export default function Page() {
  return (
    <FoundationShell
      product="Client"
      title="Mon compte"
      environment={publicEnv.NEXT_PUBLIC_APP_ENV}
    >
      <div className="et-account-sections">
        <AccountView />
        <CustomerBookings />
      </div>
    </FoundationShell>
  );
}
