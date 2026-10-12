'use client';

import { useEffect, useState } from 'react';

/**
 * Reads the single-use token from the URL fragment (#token=...) and removes
 * it from the address bar and history right away. Fragments are never sent to
 * servers or Referer headers; the token stays in memory only.
 */
export function useLinkToken(): { token: string | null; ready: boolean } {
  const [state, setState] = useState<{ token: string | null; ready: boolean }>({
    token: null,
    ready: false,
  });
  useEffect(() => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname);
    setState({ token, ready: true });
  }, []);
  return state;
}
