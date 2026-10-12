'use client';

import {
  FormAlert,
  FormStatus,
  PasswordField,
  SubmitButton,
  TextField,
  useFormSubmit,
} from '@euroteranga/ui';
import Link from 'next/link';
import { useState } from 'react';
import { auth } from '../lib/auth';
import { useLinkToken } from './use-link-token';

export function VerifyEmailForm() {
  const { token, ready } = useLinkToken();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);

  const { pending, submit } = useFormSubmit(async () => {
    if (!token) return;
    setError(null);
    const result = await auth.verifyEmail(token, password);
    if (result.ok) setVerified(true);
    else setError(result.error.message);
  });

  if (verified) {
    return (
      <FormStatus>
        <p>Votre adresse e-mail est confirmée.</p>
        <p>
          <Link href="/connexion">Se connecter</Link>
        </p>
      </FormStatus>
    );
  }
  if (!ready) return <p>Chargement…</p>;
  if (!token) {
    return (
      <>
        <FormAlert message="Ce lien est incomplet. Ouvrez le lien reçu par e-mail ou demandez-en un nouveau." />
        <ResendVerificationForm />
      </>
    );
  }

  return (
    <>
      <form className="et-form" onSubmit={submit} aria-label="Confirmation de l’adresse e-mail">
        <p>Pour activer votre compte, saisissez le mot de passe choisi lors de l’inscription.</p>
        <FormAlert message={error} />
        <PasswordField
          label="Mot de passe"
          name="password"
          autoComplete="current-password"
          value={password}
          onChange={setPassword}
        />
        <SubmitButton pending={pending}>Confirmer mon adresse</SubmitButton>
      </form>
      <ResendVerificationForm />
    </>
  );
}

function ResendVerificationForm() {
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { pending, submit } = useFormSubmit(async () => {
    setError(null);
    const result = await auth.resendVerification(email);
    if (result.ok) setMessage(result.data.message);
    else setError(result.error.message);
  });

  return (
    <section aria-labelledby="resend-title">
      <h2 id="resend-title">Lien expiré ?</h2>
      {message ? (
        <FormStatus>{message}</FormStatus>
      ) : (
        <form className="et-form" onSubmit={submit} aria-label="Recevoir un nouveau lien">
          <FormAlert message={error} />
          <TextField
            label="Adresse e-mail"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            value={email}
            onChange={setEmail}
          />
          <SubmitButton pending={pending}>Recevoir un nouveau lien</SubmitButton>
        </form>
      )}
    </section>
  );
}
