'use client';

import { FormAlert, PasswordField, SubmitButton, TextField, useFormSubmit } from '@euroteranga/ui';
import { useState } from 'react';
import { auth } from '../lib/auth';
import { clientAppUrl } from '../lib/env';

/**
 * CUSTOMER sign-in, as in the client app: the session stays in the API's
 * HttpOnly cookie; nothing is stored in the page or in web storage. The
 * selection survives because the page is not reloaded.
 */
export function CustomerLogin({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { pending, submit } = useFormSubmit(async () => {
    setError(null);
    const result = await auth.login('customer', email, password);
    if (result.ok) onSignedIn();
    else setError(result.error.message);
  });
  return (
    <form className="et-form" onSubmit={submit} aria-label="Connexion client">
      <p>Connectez-vous à votre espace client pour réserver.</p>
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
      <p>
        Pas encore de compte ? <a href={`${clientAppUrl}/inscription`}>Créer un compte client</a>
      </p>
    </form>
  );
}
