import type { Metadata } from 'next';
import { OpsShell } from '../../components/ops-shell';
import { ReportingDashboard } from '../../components/reporting/reporting-dashboard';
import { RequirePermission } from '../../components/staff-access';

export const metadata: Metadata = { title: 'Reporting — EURO TERANGA Ops' };

export default function Page() {
  return (
    <OpsShell
      title="Reporting opérationnel"
      subtitle="Activité, remplissage, finance, ponctualité, incidents, bagages et flotte"
    >
      <RequirePermission permission="reporting.view">
        <ReportingDashboard />
      </RequirePermission>
    </OpsShell>
  );
}
