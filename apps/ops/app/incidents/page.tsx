import type { Metadata } from 'next';
import { IncidentAdmin } from '../../components/incidents/incident-admin';
import { OpsShell } from '../../components/ops-shell';
import { RequirePermission } from '../../components/staff-access';

export const metadata: Metadata = { title: 'Incidents — EURO TERANGA Ops' };

export default function Page() {
  return (
    <OpsShell
      title="Incidents"
      subtitle="Déclaration, affectation, traitement et journal opérationnel des incidents"
    >
      <RequirePermission permission="incident.read">
        <IncidentAdmin />
      </RequirePermission>
    </OpsShell>
  );
}
