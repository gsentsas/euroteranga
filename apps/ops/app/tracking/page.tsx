import type { Metadata } from 'next';
import { OpsShell } from '../../components/ops-shell';
import { RequirePermission } from '../../components/staff-access';
import { TrackingAdmin } from '../../components/tracking/tracking-admin';

export const metadata: Metadata = { title: 'Tracking — EURO TERANGA Ops' };

export default function Page() {
  return (
    <OpsShell
      title="Tracking"
      subtitle="Suivi opérationnel, confidentialité publique et santé des providers"
    >
      <RequirePermission permission="tracking.read">
        <TrackingAdmin />
      </RequirePermission>
    </OpsShell>
  );
}
