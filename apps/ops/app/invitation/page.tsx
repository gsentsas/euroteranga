import { FoundationShell } from '@euroteranga/ui';
import type { Metadata } from 'next';
import { InvitationForm } from '../../components/invitation-form';
import { publicEnv } from '../../lib/env';

export const metadata: Metadata = {
  title: 'Activation du compte — EURO TERANGA Ops',
  // The token travels in the fragment, which is never sent; no referrer either way.
  referrer: 'no-referrer',
};

/** Public page: reached from the invitation e-mail, before any session exists. */
export default function Page() {
  return (
    <FoundationShell
      product="Ops"
      title="Activation du compte"
      environment={publicEnv.NEXT_PUBLIC_APP_ENV}
    >
      <InvitationForm />
    </FoundationShell>
  );
}
