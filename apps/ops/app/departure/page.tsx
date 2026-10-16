import type { Metadata } from 'next';
import { DepartureAdmin } from '../../components/departure/departure-admin';
import { OpsShell } from '../../components/ops-shell';
import { RequirePermission } from '../../components/staff-access';

export const metadata: Metadata = { title: 'Départ / Dispatch — EURO TERANGA Ops' };

export default function Page() {
  return (
    <OpsShell
      title="Départ / Dispatch"
      subtitle="Readiness serveur, autorisation explicite et cycle opérationnel du voyage"
    >
      <RequirePermission permission="departure.read">
        <DepartureAdmin />
      </RequirePermission>
    </OpsShell>
  );
}
