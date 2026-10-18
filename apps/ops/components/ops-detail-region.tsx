'use client';

import { useEffect, useRef, type ReactNode } from 'react';

export function OpsDetailRegion({
  id,
  focusKey,
  children,
}: {
  id: string;
  focusKey: string | null;
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

  return (
    <div id={id} ref={ref} className="ops-detail-region" tabIndex={-1} aria-live="polite">
      {children}
    </div>
  );
}
