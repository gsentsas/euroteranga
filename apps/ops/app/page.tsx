import { FoundationShell } from '@euroteranga/ui';
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
      <p>
        Le back-office des opérations n’est pas encore disponible. Aucune donnée opérationnelle
        n’est affichée et aucun indicateur n’est calculé.
      </p>
    </FoundationShell>
  );
}
