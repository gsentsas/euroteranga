import type { Metadata } from 'next';
import { CargoAdmin } from '../../components/cargo/cargo-admin';
import { OpsShell } from '../../components/ops-shell';
import { RequirePermission } from '../../components/staff-access';

export const metadata: Metadata = { title: 'Colis & fret — EURO TERANGA Ops' };

export default function Page() {
  return (
    <OpsShell
      title="Colis & fret"
      subtitle="Enregistrement, affectation et suivi opérationnel Paris ↔ Dakar"
    >
      <RequirePermission permission="cargo.read">
        <CargoAdmin />
      </RequirePermission>
    </OpsShell>
  );
}
