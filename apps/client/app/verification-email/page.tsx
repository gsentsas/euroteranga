import { FoundationShell } from '@euroteranga/ui';
import type { Metadata } from 'next';
import { VerifyEmailForm } from '../../components/verify-email-form';
import { publicEnv } from '../../lib/env';

export const metadata: Metadata = { title: 'Confirmer votre adresse e-mail — EURO TERANGA Client' };

export default function Page() {
  return (
    <FoundationShell
      product="Client"
      title="Confirmer votre adresse e-mail"
      environment={publicEnv.NEXT_PUBLIC_APP_ENV}
    >
      <VerifyEmailForm />
    </FoundationShell>
  );
}
