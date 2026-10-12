'use client';

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';

interface FieldProps {
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  type?: 'email' | 'text';
  inputMode?: 'email' | 'numeric' | 'text';
  hint?: string;
  error?: string | undefined;
  required?: boolean;
  pattern?: string;
  maxLength?: number;
}

/** Labelled input; hint and error are announced through aria-describedby. */
export function TextField({
  label,
  name,
  value,
  onChange,
  autoComplete,
  type = 'text',
  inputMode,
  hint,
  error,
  required = true,
  pattern,
  maxLength,
}: FieldProps) {
  const id = useId();
  const describedBy = [hint ? `${id}-hint` : '', error ? `${id}-error` : '']
    .filter(Boolean)
    .join(' ');
  return (
    <div className="et-field">
      <label htmlFor={id}>{label}</label>
      {hint ? (
        <p id={`${id}-hint`} className="et-hint">
          {hint}
        </p>
      ) : null}
      <input
        id={id}
        name={name}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete={autoComplete}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        {...(inputMode ? { inputMode } : {})}
        {...(pattern ? { pattern } : {})}
        {...(maxLength ? { maxLength } : {})}
        className="et-input"
      />
      {error ? (
        <p id={`${id}-error`} className="et-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

interface PasswordFieldProps {
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: 'current-password' | 'new-password';
  hint?: string;
  error?: string | undefined;
}

/**
 * Password input with an accessible show/hide toggle. Pasting and password
 * managers work normally; the value lives only in this form's state.
 */
export function PasswordField({
  label,
  name,
  value,
  onChange,
  autoComplete,
  hint,
  error,
}: PasswordFieldProps) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  const describedBy = [hint ? `${id}-hint` : '', error ? `${id}-error` : '']
    .filter(Boolean)
    .join(' ');
  return (
    <div className="et-field">
      <label htmlFor={id}>{label}</label>
      {hint ? (
        <p id={`${id}-hint`} className="et-hint">
          {hint}
        </p>
      ) : null}
      <div className="et-password">
        <input
          id={id}
          name={name}
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete={autoComplete}
          required
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
          className="et-input"
        />
        <button
          type="button"
          className="et-button et-button--secondary"
          aria-controls={id}
          aria-pressed={visible}
          onClick={() => setVisible((current) => !current)}
        >
          {visible ? 'Masquer' : 'Afficher'}
          <span className="et-visually-hidden"> le mot de passe</span>
        </button>
      </div>
      {error ? (
        <p id={`${id}-error`} className="et-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Error summary that takes focus when it appears, so it is announced. */
export function FormAlert({ message }: { message: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (message) ref.current?.focus();
  }, [message]);
  if (!message) return null;
  return (
    <div ref={ref} className="et-alert" role="alert" tabIndex={-1}>
      {message}
    </div>
  );
}

/** Polite status message (success, generic confirmations). */
export function FormStatus({ children }: { children: ReactNode }) {
  return (
    <div className="et-status-box" role="status">
      {children}
    </div>
  );
}

export function SubmitButton({ pending, children }: { pending: boolean; children: ReactNode }) {
  return (
    <button type="submit" className="et-button" disabled={pending} aria-busy={pending || undefined}>
      {pending ? 'Veuillez patienter…' : children}
    </button>
  );
}

/**
 * Generic form wrapper: prevents double submission, exposes a single error
 * message, and leaves validation of credentials to the server.
 */
export function useFormSubmit<T>(action: () => Promise<T>) {
  const [pending, setPending] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return undefined;
    setPending(true);
    try {
      return await action();
    } finally {
      setPending(false);
    }
  };
  return { pending, submit };
}
