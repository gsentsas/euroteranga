import type { Metadata } from 'next';
import { OpsShell } from '../../components/ops-shell';
import { SeatMapsAdmin } from '../../components/seat-maps/seat-maps-admin';
import { RequirePermission } from '../../components/staff-access';

export const metadata: Metadata = { title: 'Plans de sièges — EURO TERANGA Ops' };

export default function Page() {
  return (
    <OpsShell title="Plans de sièges" subtitle="Configurations physiques versionnées">
      <RequirePermission permission="seatmap.read">
        <SeatMapsAdmin />
      </RequirePermission>
    </OpsShell>
  );
}
