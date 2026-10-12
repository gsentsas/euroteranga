import type { AuthProvider } from '@refinedev/core';
import { auth } from './auth';

/**
 * Refine auth provider backed by the Core API. `check` asks the API for the
 * current STAFF session on every navigation guard: hiding a page in Refine is
 * not a protection, the API answer is. Any failure counts as signed out.
 */
export const authProvider: AuthProvider = {
  // Sign-in has two steps (password, then TOTP) handled by dedicated pages.
  login: async () => ({ success: false, redirectTo: '/connexion' }),
  check: async () => {
    const me = await auth.me('staff');
    return me.ok ? { authenticated: true } : { authenticated: false, redirectTo: '/connexion' };
  },
  logout: async () => {
    await auth.logout('staff');
    return { success: true, redirectTo: '/connexion' };
  },
  onError: async (error: unknown) => ({
    error: error instanceof Error ? error : new Error('Erreur'),
  }),
  getIdentity: async () => {
    const me = await auth.me('staff');
    return me.ok ? { id: me.data.id, email: me.data.email } : null;
  },
};
