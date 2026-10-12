import type { Metadata } from 'next';
import { RolesAdmin } from '../../../components/admin/roles-admin';
import { OpsShell } from '../../../components/ops-shell';
import { RequirePermission } from '../../../components/staff-access';

export const metadata: Metadata = { title: 'Rôles — EURO TERANGA Ops' };

export default function Page() {
  return (
    <OpsShell title="Rôles">
      <RequirePermission permission="role.read">
        <RolesAdmin />
      </RequirePermission>
    </OpsShell>
  );
}
