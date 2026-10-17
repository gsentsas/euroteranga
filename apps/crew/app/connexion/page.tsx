import type { Metadata } from 'next';
import { CrewLoginForm } from '../../components/crew-login-form';
import { CrewShell } from '../../components/crew-shell';
import { publicEnv } from '../../lib/env';

export const metadata: Metadata = { title: 'Connexion équipage — EURO TERANGA Crew' };

export default function Page() {
  return (
    <CrewShell
      title="Connexion équipage"
      subtitle="Accédez à la session terrain affectée à votre compte Crew."
      environment={publicEnv.NEXT_PUBLIC_APP_ENV}
    >
      <section className="crew-auth-panel">
        <CrewLoginForm />
      </section>
    </CrewShell>
  );
}
