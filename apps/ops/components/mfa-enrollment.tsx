'use client';

import { FormAlert, FormStatus, SubmitButton, TextField, useFormSubmit } from '@euroteranga/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { auth } from '../lib/auth';

type Enrollment = { otpauthUri: string; secret: string };

/**
 * First STAFF login: set up TOTP, confirm with a first code, then show the
 * recovery codes once. Secret and codes stay in component memory only.
 */
export function MfaEnrollment() {
  const router = useRouter();
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  useEffect(() => {
    let active = true;
    void auth.staffEnrollmentStart().then((result) => {
      if (!active) return;
      if (result.ok) setEnrollment(result.data);
      else setStartError(result.error.message);
    });
    return () => {
      active = false;
    };
  }, []);

  const { pending, submit } = useFormSubmit(async () => {
    setError(null);
    const result = await auth.staffEnrollmentConfirm(code.replace(/\s+/g, ''));
    if (result.ok) {
      setRecoveryCodes(result.data.recoveryCodes);
      setEnrollment(null);
    } else {
      setError(result.error.message);
      setCode('');
    }
  });

  if (recoveryCodes) {
    return (
      <section aria-labelledby="recovery-title">
        <h2 id="recovery-title">Codes de récupération</h2>
        <FormStatus>
          <p>
            <strong>Ces codes ne seront affichés qu’une seule fois.</strong> Conservez-les dans un
            endroit sûr : chacun permet une connexion si votre téléphone n’est pas disponible.
          </p>
        </FormStatus>
        <ul className="et-code-list" data-testid="recovery-codes">
          {recoveryCodes.map((recoveryCode) => (
            <li key={recoveryCode} className="et-code">
              {recoveryCode}
            </li>
          ))}
        </ul>
        <button
          type="button"
          className="et-button"
          onClick={() => {
            setRecoveryCodes(null);
            router.push('/');
          }}
        >
          J’ai conservé mes codes, continuer
        </button>
      </section>
    );
  }

  if (startError) {
    return (
      <>
        <FormAlert message={startError} />
        <p>
          <Link href="/connexion">Revenir à la connexion</Link>
        </p>
      </>
    );
  }
  if (!enrollment) return <p role="status">Préparation…</p>;

  return (
    <form
      className="et-form"
      onSubmit={submit}
      aria-label="Configuration de la double authentification"
    >
      <p>La double authentification est obligatoire pour les comptes opérations.</p>
      <ol>
        <li>
          Ajoutez un compte dans votre application d’authentification (
          <a href={enrollment.otpauthUri}>ouvrir l’application</a> ou saisissez la clé ci-dessous).
        </li>
        <li>Saisissez le code à 6 chiffres affiché par l’application.</li>
      </ol>
      <p>
        Clé :{' '}
        <span className="et-code" data-testid="totp-secret">
          {enrollment.secret}
        </span>
      </p>
      <FormAlert message={error} />
      <TextField
        label="Code de l’application d’authentification"
        name="code"
        autoComplete="one-time-code"
        inputMode="numeric"
        pattern="[0-9 ]{6,7}"
        value={code}
        onChange={setCode}
        maxLength={7}
      />
      <SubmitButton pending={pending}>Activer</SubmitButton>
    </form>
  );
}
