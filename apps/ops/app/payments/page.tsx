import type { Metadata } from 'next';
import { OpsShell } from '../../components/ops-shell';
import { PaymentsAdmin } from '../../components/payments/payments-admin';
import { RequirePermission } from '../../components/staff-access';

export const metadata: Metadata = { title: 'Paiements — EURO TERANGA Ops' };

export default function Page() {
  return (
    <OpsShell title="Paiements" subtitle="Tentatives de paiement des réservations">
      <RequirePermission permission="payment.read">
        <PaymentsAdmin />
      </RequirePermission>
    </OpsShell>
  );
}
