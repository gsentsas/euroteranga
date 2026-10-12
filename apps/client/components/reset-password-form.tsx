'use client';

import { FormAlert, FormStatus, PasswordField, SubmitButton, useFormSubmit } from '@euroteranga/ui';
import Link from 'next/link';
import { useState } from 'react';
import { auth } from '../lib/auth';
import { useLinkToken } from './use-link-token';

export function ResetPasswordForm() {
  const { token, ready } = useLinkToken();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | undefined>();
  const [done, setDone] = useState(false);

  const { pending, submit } = useFormSubmit(async () => {
    if (!token) return;
    setError(null);
    setPasswordError(undefined);
    const result = await auth.resetPassword(token, password);
    if (result.ok) {
      setDone(true);
      setPassword('');
    } else {
      if (result.error.code === 'PASSWORD_POLICY_VIOLATION') setPasswordError(result.error.message);
      setError(result.error.message);
    }
  });

  if (done) {
    return (
      <FormStatus>
        <p>Votre mot de passe a été modifié. Toutes vos sessions ont été fermées.</p>
        <p>
          <Link href="/connexion">Se connecter</Link>
        </p>
      </FormStatus>
    );
  }
  if (!ready) return <p>Chargement…</p>;
  if (!token) {
    return (
      <p>
        Ce lien est incomplet ou expiré.{' '}
        <Link href="/mot-de-passe-oublie">Demander un nouveau lien</Link>
      </p>
    );
  }
  return (
    <form className="et-form" onSubmit={submit} aria-label="Nouveau mot de passe">
      <FormAlert message={error} />
      <PasswordField
        label="Nouveau mot de passe"
        name="newPassword"
        autoComplete="new-password"
        hint="Au moins 15 caractères. Une phrase de plusieurs mots est idéale."
        error={passwordError}
        value={password}
        onChange={setPassword}
      />
      <SubmitButton pending={pending}>Enregistrer le mot de passe</SubmitButton>
    </form>
  );
}
