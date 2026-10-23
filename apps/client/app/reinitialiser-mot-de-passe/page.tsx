import { JourneyShell } from '@euroteranga/ui';
import type { Metadata } from 'next';
import { ResetPasswordForm } from '../../components/reset-password-form';
import { journeyLinks, publicEnv } from '../../lib/env';

export const metadata: Metadata = { title: 'Nouveau mot de passe — EURO TERANGA' };

export default function Page() {
  return (
    <JourneyShell
      area="Espace client"
      title="Choisissez un nouveau mot de passe."
      subtitle="Créez une phrase de passe longue et unique pour sécuriser votre espace voyage."
      environment={publicEnv.NEXT_PUBLIC_APP_ENV}
      links={journeyLinks}
      current="client"
    >
      <section className="et-auth-panel" aria-labelledby="reset-password-panel">
        <h2 id="reset-password-panel">Nouveau mot de passe</h2>
        <ResetPasswordForm />
      </section>
    </JourneyShell>
  );
}
