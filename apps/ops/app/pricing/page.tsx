import type { Metadata } from 'next';
import { OpsShell } from '../../components/ops-shell';
import { BaggagePolicyAdmin } from '../../components/pricing/baggage-policy-admin';
import { CargoPricingAdmin } from '../../components/pricing/cargo-pricing-admin';
import { PricingAdmin } from '../../components/pricing/pricing-admin';
import { RequirePermission } from '../../components/staff-access';

export const metadata: Metadata = { title: 'Tarification — EURO TERANGA Ops' };

export default function Page() {
  return (
    <OpsShell
      title="Tarification"
      subtitle="Voyageurs, bagages et colis & fret — règles versionnées et auditées"
    >
      <RequirePermission permission="pricing.read">
        <PricingAdmin />
        <BaggagePolicyAdmin />
        <CargoPricingAdmin />
      </RequirePermission>
    </OpsShell>
  );
}
