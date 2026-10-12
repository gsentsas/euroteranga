'use client';

import { FormAlert, PasswordField, SubmitButton, useFormSubmit } from '@euroteranga/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { auth } from '../lib/auth';
import { useLinkToken } from './use-link-token';

/**
 * Accepts a STAFF invitation: the single-use token comes from the URL
 * fragment, is removed from the address bar at once and stays in memory only.
 * Accepting sets the password; the second factor is configured at the first
 * sign-in, which the invitation authorizes once.
 */
export function InvitationForm() {
  const router = useRouter();
  const { token, ready } = useLinkToken();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | undefined>();

  const { pending, submit } = useFormSubmit(async () => {
    if (!token) return;
    setError(null);
    setPasswordError(undefined);
    const result = await auth.acceptStaffInvitation(token, password);
    if (result.ok) {
      setPassword('');
      router.replace('/connexion?compte=active');
      return;
    }
    if (result.error.code === 'PASSWORD_POLICY_VIOLATION') setPasswordError(result.error.message);
    setError(result.error.message);
  });

  if (!ready) return <p>Chargement…</p>;
  if (!token) {
    return (
      <p role="status">
        Ce lien d’invitation est incomplet ou expiré. Demandez une nouvelle invitation à un
        administrateur.
      </p>
    );
  }
  return (
    <form className="et-form" onSubmit={submit} aria-label="Activation du compte">
      <FormAlert message={error} />
      <PasswordField
        label="Choisissez un mot de passe"
        name="newPassword"
        autoComplete="new-password"
        hint="Au moins 15 caractères. Une phrase de plusieurs mots est idéale."
        error={passwordError}
        value={password}
        onChange={setPassword}
      />
      <SubmitButton pending={pending}>Activer mon compte</SubmitButton>
    </form>
  );
}
