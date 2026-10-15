import type { Metadata } from 'next';
import { CheckInAdmin } from '../../components/check-in/check-in-admin';
import { OpsShell } from '../../components/ops-shell';
import { RequirePermission } from '../../components/staff-access';

export const metadata: Metadata = { title: 'Check-in / Embarquement — EURO TERANGA Ops' };

export default function Page() {
  return (
    <OpsShell title="Check-in / Embarquement" subtitle="Contrôles, enregistrement et embarquement">
      <RequirePermission permission="checkin.read">
        <CheckInAdmin />
      </RequirePermission>
    </OpsShell>
  );
}
