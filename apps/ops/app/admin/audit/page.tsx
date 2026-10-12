import type { Metadata } from 'next';
import { AuditLog } from '../../../components/admin/audit-log';
import { OpsShell } from '../../../components/ops-shell';
import { RequirePermission } from '../../../components/staff-access';

export const metadata: Metadata = { title: 'Journal d’audit — EURO TERANGA Ops' };

export default function Page() {
  return (
    <OpsShell title="Journal d’audit">
      <RequirePermission permission="audit.read">
        <AuditLog />
      </RequirePermission>
    </OpsShell>
  );
}
