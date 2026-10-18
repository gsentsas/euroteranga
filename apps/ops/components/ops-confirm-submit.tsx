'use client';

import { useState } from 'react';

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

  if (!confirming) {
    return (
      <button
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
    <div className="ops-confirm-action" role="group" aria-label={title}>
      <div>
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
      <div className="ops-confirm-action__buttons">
        <button
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
