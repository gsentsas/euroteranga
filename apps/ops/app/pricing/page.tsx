import type { Metadata } from 'next';
import { OpsShell } from '../../components/ops-shell';
import { BaggagePolicyAdmin } from '../../components/pricing/baggage-policy-admin';
import { PricingAdmin } from '../../components/pricing/pricing-admin';
import { RequirePermission } from '../../components/staff-access';

export const metadata: Metadata = { title: 'Tarification — EURO TERANGA Ops' };

export default function Page() {
  return (
    <OpsShell title="Tarification" subtitle="Grilles de tarifs de base versionnées">
      <RequirePermission permission="pricing.read">
        <PricingAdmin />
        <BaggagePolicyAdmin />
      </RequirePermission>
    </OpsShell>
  );
}
