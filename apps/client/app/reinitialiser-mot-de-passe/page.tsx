import { FoundationShell } from '@euroteranga/ui';
import type { Metadata } from 'next';
import { ResetPasswordForm } from '../../components/reset-password-form';
import { publicEnv } from '../../lib/env';

export const metadata: Metadata = { title: 'Nouveau mot de passe — EURO TERANGA Client' };

export default function Page() {
  return (
    <FoundationShell
      product="Client"
      title="Nouveau mot de passe"
      environment={publicEnv.NEXT_PUBLIC_APP_ENV}
    >
      <ResetPasswordForm />
    </FoundationShell>
  );
}
