import type { Metadata } from 'next';
import { OpsShell } from '../../components/ops-shell';
import { RegulatoryPermitsAdmin } from '../../components/regulatory-permits/regulatory-permits-admin';
import { RequirePermission } from '../../components/staff-access';

export const metadata: Metadata = {
  title: 'Autorisations réglementaires — EURO TERANGA Ops',
};

export default function Page() {
  return (
    <OpsShell
      title="Autorisations réglementaires"
      subtitle="Registre des permis opérationnels et de leur validité intrinsèque"
    >
      <RequirePermission permission="permit.read">
        <RegulatoryPermitsAdmin />
      </RequirePermission>
    </OpsShell>
  );
}
