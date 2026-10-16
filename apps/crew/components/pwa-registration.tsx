'use client';

import { useEffect } from 'react';

export function PwaRegistration() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    void (async () => {
      try {
        await navigator.serviceWorker.register('/sw.js', { scope: '/' });
        await navigator.serviceWorker.ready;
      } catch {
        // The app remains usable online when service workers are unavailable.
      }
    })();
  }, []);
  return null;
}
