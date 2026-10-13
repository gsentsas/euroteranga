import type { Metadata } from 'next';
import { OpsShell } from '../../components/ops-shell';
import { RequirePermission } from '../../components/staff-access';
import { TripsAdmin } from '../../components/trips/trips-admin';

export const metadata: Metadata = { title: 'Voyages — EURO TERANGA Ops' };

export default function Page() {
  return (
    <OpsShell title="Voyages" subtitle="Voyages planifiés, horaires et véhicules">
      <RequirePermission permission="trip.read">
        <TripsAdmin />
      </RequirePermission>
    </OpsShell>
  );
}
