import { FoundationShell } from '@euroteranga/ui';
import { StaffHome } from '../components/staff-home';
import { publicEnv } from '../lib/env';
import { FoundationNav } from './foundation-nav';

export default function OperationsHomePage() {
  return (
    <FoundationShell
      product="Ops"
      title="Operations Control Center"
      subtitle="Foundation environment"
      environment={publicEnv.NEXT_PUBLIC_APP_ENV}
      navigation={<FoundationNav />}
    >
      <StaffHome />
    </FoundationShell>
  );
}
