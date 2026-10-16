'use client';

import { useEffect } from 'react';

export function PwaRegistration() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    void (async () => {
      try {
        const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
        await navigator.serviceWorker.ready;
        const urls = performance.getEntriesByType('resource').flatMap((entry) => {
          try {
            const url = new URL(entry.name);
            return url.origin === location.origin && url.pathname.startsWith('/_next/static/')
              ? [entry.name]
              : [];
          } catch {
            return [];
          }
        });
        registration.active?.postMessage({ type: 'CACHE_STATIC_ASSETS', urls });
      } catch {
        // The app remains usable online when service workers are unavailable.
      }
    })();
  }, []);
  return null;
}
