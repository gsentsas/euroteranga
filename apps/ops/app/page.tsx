import { OpsShell } from '../components/ops-shell';
import { StaffHome } from '../components/staff-home';

export default function OperationsHomePage() {
  return (
    <OpsShell
      title="Centre de contrôle"
      subtitle="Pilotage du réseau, des voyages et des opérations terrain."
    >
      <StaffHome />
    </OpsShell>
  );
}
