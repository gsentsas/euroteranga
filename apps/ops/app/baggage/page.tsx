import type { Metadata } from 'next';
import { BaggageAdmin } from '../../components/baggage/baggage-admin';
import { OpsShell } from '../../components/ops-shell';
import { RequirePermission } from '../../components/staff-access';

export const metadata: Metadata = { title: 'Bagages — EURO TERANGA Ops' };

export default function Page() {
  return (
    <OpsShell title="Bagages" subtitle="Enregistrement, pesée et historique des bagages">
      <RequirePermission permission="baggage.read">
        <BaggageAdmin />
      </RequirePermission>
    </OpsShell>
  );
}
