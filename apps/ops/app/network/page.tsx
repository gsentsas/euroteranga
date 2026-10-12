import type { Metadata } from 'next';
import { NetworkAdmin } from '../../components/network/network-admin';
import { OpsShell } from '../../components/ops-shell';
import { RequirePermission } from '../../components/staff-access';

export const metadata: Metadata = { title: 'Réseau — EURO TERANGA Ops' };

export default function Page() {
  return (
    <OpsShell title="Réseau" subtitle="Pays, points du réseau et routes versionnées">
      <RequirePermission permission="network.read">
        <NetworkAdmin />
      </RequirePermission>
    </OpsShell>
  );
}
