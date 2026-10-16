import { FoundationShell } from '@euroteranga/ui';
import Link from 'next/link';
import { publicEnv } from '../lib/env';

export default function HomePage() {
  return (
    <FoundationShell
      product="Crew"
      title="EURO TERANGA Crew"
      subtitle="Opérations terrain — en ligne et hors ligne"
      environment={publicEnv.NEXT_PUBLIC_APP_ENV}
    >
      <p>Embarquement terrain avec file locale persistante et validation par le Core API.</p>
      <p>
        <Link href="/session">Ouvrir l’espace équipage</Link>
      </p>
    </FoundationShell>
  );
}
