import type { Metadata } from 'next';
import { ManifestsAdmin } from '../../components/manifests/manifests-admin';
import { OpsShell } from '../../components/ops-shell';
import { RequirePermission } from '../../components/staff-access';

export const metadata: Metadata = { title: 'Manifestes passagers — EURO TERANGA Ops' };

export default function Page() {
  return (
    <OpsShell title="Manifestes passagers" subtitle="Snapshots immuables et historique par voyage">
      <RequirePermission permission="manifest.read">
        <ManifestsAdmin />
      </RequirePermission>
    </OpsShell>
  );
}
