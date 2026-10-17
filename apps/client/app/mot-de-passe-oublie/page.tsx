import { JourneyShell } from '@euroteranga/ui';
import type { Metadata } from 'next';
import { ForgotPasswordForm } from '../../components/forgot-password-form';
import { publicEnv } from '../../lib/env';

export const metadata: Metadata = { title: 'Mot de passe oublié — EURO TERANGA' };

export default function Page() {
  return (
    <JourneyShell
      area="Espace client"
      title="Retrouvez l’accès à votre compte."
      subtitle="Indiquez votre adresse e-mail pour recevoir un lien de réinitialisation."
      environment={publicEnv.NEXT_PUBLIC_APP_ENV}
      current="client"
    >
      <section className="et-auth-panel" aria-labelledby="forgot-password-panel">
        <h2 id="forgot-password-panel">Réinitialiser mon mot de passe</h2>
        <ForgotPasswordForm />
      </section>
    </JourneyShell>
  );
}
