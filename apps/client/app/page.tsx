import { FoundationShell } from '@euroteranga/ui';
import Link from 'next/link';
import { publicEnv } from '../lib/env';

export default function HomePage() {
  return (
    <FoundationShell
      product="Client"
      title="EURO TERANGA Client"
      subtitle="Foundation environment"
      environment={publicEnv.NEXT_PUBLIC_APP_ENV}
    >
      <p>L’espace client n’est pas encore disponible. Aucune donnée client n’est affichée.</p>
      <p>
        <Link href="/connexion">Se connecter</Link>
        <span aria-hidden="true"> · </span>
        <Link href="/inscription">Créer un compte</Link>
      </p>
    </FoundationShell>
  );
}
