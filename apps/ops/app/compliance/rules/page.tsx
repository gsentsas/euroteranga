import type { Metadata } from 'next';
import { ComplianceRulesAdmin } from '../../../components/compliance/compliance-rules-admin';
import { OpsShell } from '../../../components/ops-shell';
import { RequirePermission } from '../../../components/staff-access';

export const metadata: Metadata = { title: 'Règles réglementaires — EURO TERANGA Ops' };

export default function Page() {
  return (
    <OpsShell title="Règles réglementaires" subtitle="Sources vérifiées, versions et publication">
      <RequirePermission permission="compliance.rule.read">
        <ComplianceRulesAdmin />
      </RequirePermission>
    </OpsShell>
  );
}
