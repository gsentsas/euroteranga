'use client';

import { FormAlert, PasswordField, SubmitButton, TextField, useFormSubmit } from '@euroteranga/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { auth } from '../lib/auth';

export function CrewLoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { pending, submit } = useFormSubmit(async () => {
    setError(null);
    const result = await auth.login('crew', email, password);
    if (result.ok) router.push('/session');
    else setError(result.error.message);
  });

  return (
    <form className="et-form" onSubmit={submit} aria-label="Connexion équipage">
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
      <PasswordField
        label="Mot de passe"
        name="password"
        autoComplete="current-password"
        value={password}
        onChange={setPassword}
      />
      <SubmitButton pending={pending}>Se connecter</SubmitButton>
    </form>
  );
}
