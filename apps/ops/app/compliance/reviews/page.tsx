import type { Metadata } from 'next';
import { ComplianceReviewsAdmin } from '../../../components/compliance/compliance-reviews-admin';
import { OpsShell } from '../../../components/ops-shell';
import { RequirePermission } from '../../../components/staff-access';

export const metadata: Metadata = { title: 'Revues passagers — EURO TERANGA Ops' };

export default function Page() {
  return (
    <OpsShell title="Revues passagers" subtitle="Conformité réglementaire par voyage">
      <RequirePermission permission="compliance.read">
        <ComplianceReviewsAdmin />
      </RequirePermission>
    </OpsShell>
  );
}
