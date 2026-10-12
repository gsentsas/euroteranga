'use client';

import { FormAlert, FormStatus, SubmitButton, TextField, useFormSubmit } from '@euroteranga/ui';
import { useState } from 'react';
import { auth } from '../lib/auth';

export function ForgotPasswordForm() {
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { pending, submit } = useFormSubmit(async () => {
    setError(null);
    const result = await auth.forgotPassword(email);
    if (result.ok) setMessage(result.data.message);
    else setError(result.error.message);
  });

  if (message) return <FormStatus>{message}</FormStatus>;
  return (
    <form className="et-form" onSubmit={submit} aria-label="Mot de passe oublié">
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
      <SubmitButton pending={pending}>Recevoir un lien de réinitialisation</SubmitButton>
    </form>
  );
}
