import type { Metadata } from 'next';
import { FinanceAdmin } from '../../components/finance/finance-admin';
import { OpsShell } from '../../components/ops-shell';
import { RequirePermission } from '../../components/staff-access';

export const metadata: Metadata = { title: 'Finance — EURO TERANGA Ops' };

export default function Page() {
  return (
    <OpsShell
      title="Finance opérationnelle"
      subtitle="Revenus, dépenses, remboursements et contribution par voyage"
    >
      <RequirePermission permission="finance.read">
        <FinanceAdmin />
      </RequirePermission>
    </OpsShell>
  );
}
