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

export function RegisterForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | undefined>();
  const [done, setDone] = useState<string | null>(null);

  const { pending, submit } = useFormSubmit(async () => {
    setError(null);
    setPasswordError(undefined);
    const result = await auth.register(email, password);
    if (result.ok) {
      setDone(result.data.message);
      setPassword('');
    } else if (result.error.code === 'PASSWORD_POLICY_VIOLATION') {
      setPasswordError(result.error.message);
      setError(result.error.message);
    } else {
      setError(result.error.message);
    }
  });

  if (done) {
    return (
      <FormStatus>
        <p>{done}</p>
        <p>Consultez votre boîte de réception et ouvrez le lien de confirmation.</p>
      </FormStatus>
    );
  }

  return (
    <form className="et-form" onSubmit={submit} aria-label="Création de compte">
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
        autoComplete="new-password"
        hint="Au moins 15 caractères. Une phrase de plusieurs mots est idéale ; espaces et accents sont acceptés."
        error={passwordError}
        value={password}
        onChange={setPassword}
      />
      <SubmitButton pending={pending}>Créer mon compte</SubmitButton>
      <p>
        Déjà inscrit ? <Link href="/connexion">Se connecter</Link>
      </p>
    </form>
  );
}
