'use client';

import { FormAlert, PasswordField, SubmitButton, TextField, useFormSubmit } from '@euroteranga/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { auth } from '../lib/auth';

/** Step 1 of 2: a correct password only leads to the second factor. */
export function StaffLoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { pending, submit } = useFormSubmit(async () => {
    setError(null);
    const result = await auth.login('staff', email, password);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    router.push(result.data.status === 'MFA_ENROLLMENT_REQUIRED' ? '/mfa/configuration' : '/mfa');
  });

  return (
    <form className="et-form" onSubmit={submit} aria-label="Connexion opérations">
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
      <SubmitButton pending={pending}>Continuer</SubmitButton>
    </form>
  );
}
