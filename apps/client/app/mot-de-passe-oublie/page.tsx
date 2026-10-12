import { FoundationShell } from '@euroteranga/ui';
import type { Metadata } from 'next';
import { ForgotPasswordForm } from '../../components/forgot-password-form';
import { publicEnv } from '../../lib/env';

export const metadata: Metadata = { title: 'Mot de passe oublié — EURO TERANGA Client' };

export default function Page() {
  return (
    <FoundationShell
      product="Client"
      title="Mot de passe oublié"
      environment={publicEnv.NEXT_PUBLIC_APP_ENV}
    >
      <p>Indiquez votre adresse e-mail pour recevoir un lien de réinitialisation.</p>
      <ForgotPasswordForm />
    </FoundationShell>
  );
}
