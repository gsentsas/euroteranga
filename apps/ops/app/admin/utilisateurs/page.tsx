import type { Metadata } from 'next';
import { UsersAdmin } from '../../../components/admin/users-admin';
import { OpsShell } from '../../../components/ops-shell';
import { RequirePermission } from '../../../components/staff-access';

export const metadata: Metadata = { title: 'Utilisateurs — EURO TERANGA Ops' };

export default function Page() {
  return (
    <OpsShell title="Utilisateurs">
      <RequirePermission permission="identity.read">
        <UsersAdmin />
      </RequirePermission>
    </OpsShell>
  );
}
