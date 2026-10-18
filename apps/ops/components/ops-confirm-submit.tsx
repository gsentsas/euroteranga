'use client';

import { useEffect, useRef, useState } from 'react';

export function OpsConfirmSubmit({
  actionLabel,
  confirmLabel,
  title,
  description,
  disabled = false,
}: {
  actionLabel: string;
  confirmLabel: string;
  title: string;
  description: string;
  disabled?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const actionRef = useRef<HTMLButtonElement>(null);
  const returnRef = useRef<HTMLButtonElement>(null);
  const openedRef = useRef(false);

  useEffect(() => {
    if (confirming) {
      openedRef.current = true;
      returnRef.current?.focus();
      return;
    }
    if (openedRef.current) {
      openedRef.current = false;
      actionRef.current?.focus();
    }
  }, [confirming]);

  if (!confirming) {
    return (
      <button
        ref={actionRef}
        type="button"
        className="et-button ops-sensitive-action"
        disabled={disabled}
        onClick={() => setConfirming(true)}
      >
        {actionLabel}
      </button>
    );
  }

  return (
    <div
      className="ops-confirm-action"
      role="group"
      aria-label={title}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setConfirming(false);
      }}
    >
      <div>
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
      <div className="ops-confirm-action__buttons">
        <button
          ref={returnRef}
          type="button"
          className="et-button et-button--secondary"
          disabled={disabled}
          onClick={() => setConfirming(false)}
        >
          Retour
        </button>
        <button type="submit" className="et-button ops-sensitive-action" disabled={disabled}>
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}
