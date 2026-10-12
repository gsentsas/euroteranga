import { OpsShell } from '../components/ops-shell';
import { StaffHome } from '../components/staff-home';

export default function OperationsHomePage() {
  return (
    <OpsShell title="Operations Control Center" subtitle="Foundation environment">
      <StaffHome />
    </OpsShell>
  );
}
