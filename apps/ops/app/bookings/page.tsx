import type { Metadata } from 'next';
import { BookingsAdmin } from '../../components/bookings/bookings-admin';
import { OpsShell } from '../../components/ops-shell';
import { RequirePermission } from '../../components/staff-access';

export const metadata: Metadata = { title: 'Réservations — EURO TERANGA Ops' };

export default function Page() {
  return (
    <OpsShell title="Réservations" subtitle="Retenues provisoires des clients">
      <RequirePermission permission="booking.read">
        <BookingsAdmin />
      </RequirePermission>
    </OpsShell>
  );
}
