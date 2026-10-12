'use client';

import { FormAlert, SubmitButton, TextField, useFormSubmit } from '@euroteranga/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { auth } from '../lib/auth';

/** Step 2 of 2: TOTP code, or one recovery code. */
export function MfaVerifyForm() {
  const router = useRouter();
  const [useRecovery, setUseRecovery] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { pending, submit } = useFormSubmit(async () => {
    setError(null);
    const result = await auth.staffMfaVerify(
      useRecovery ? { recoveryCode: code } : { code: code.replace(/\s+/g, '') },
    );
    if (result.ok) router.push('/');
    else {
      setError(result.error.message);
      setCode('');
    }
  });

  return (
    <form className="et-form" onSubmit={submit} aria-label="Vérification en deux étapes">
      <FormAlert message={error} />
      {useRecovery ? (
        <TextField
          label="Code de récupération"
          name="recoveryCode"
          autoComplete="off"
          hint="Format XXXX-XXXX-XXXX-XXXX. Chaque code ne fonctionne qu’une fois."
          value={code}
          onChange={setCode}
          maxLength={32}
        />
      ) : (
        <TextField
          label="Code de l’application d’authentification"
          name="code"
          autoComplete="one-time-code"
          inputMode="numeric"
          pattern="[0-9 ]{6,7}"
          hint="Code à 6 chiffres affiché dans votre application."
          value={code}
          onChange={setCode}
          maxLength={7}
        />
      )}
      <SubmitButton pending={pending}>Valider</SubmitButton>
      <p>
        <button
          type="button"
          className="et-button et-button--secondary"
          onClick={() => {
            setUseRecovery((current) => !current);
            setCode('');
            setError(null);
          }}
        >
          {useRecovery
            ? 'Utiliser l’application d’authentification'
            : 'Utiliser un code de récupération'}
        </button>
      </p>
      <p>
        <Link href="/connexion">Recommencer la connexion</Link>
      </p>
    </form>
  );
}
