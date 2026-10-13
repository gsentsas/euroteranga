import type { Metadata } from 'next';
import { FleetAdmin } from '../../components/fleet/fleet-admin';
import { OpsShell } from '../../components/ops-shell';
import { RequirePermission } from '../../components/staff-access';

export const metadata: Metadata = { title: 'Flotte — EURO TERANGA Ops' };

export default function Page() {
  return (
    <OpsShell title="Flotte" subtitle="Registre des véhicules et cycle de vie">
      <RequirePermission permission="fleet.read">
        <FleetAdmin />
      </RequirePermission>
    </OpsShell>
  );
}
