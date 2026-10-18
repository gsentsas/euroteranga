'use client';

import { useEffect, useRef, type ReactNode } from 'react';

export function OpsDetailRegion({
  id,
  focusKey,
  onClose,
  closeLabel = 'Retour à la liste',
  children,
}: {
  id: string;
  focusKey: string | null;
  onClose?: () => void;
  closeLabel?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!focusKey) return;
    const frame = requestAnimationFrame(() => {
      ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      ref.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusKey]);

  const close = () => {
    const trigger = document.querySelector<HTMLElement>(
      `[aria-controls="${id}"][aria-expanded="true"]`,
    );
    onClose?.();
    requestAnimationFrame(() => trigger?.focus());
  };

  return (
    <div
      id={id}
      ref={ref}
      className="ops-detail-region"
      tabIndex={-1}
      aria-live="polite"
      data-testid={`${id}-region`}
    >
      {onClose ? (
        <div className="ops-detail-region__toolbar">
          <span>Fiche ouverte</span>
          <button type="button" className="et-button et-button--secondary" onClick={close}>
            {closeLabel}
          </button>
        </div>
      ) : null}
      {children}
    </div>
  );
}
