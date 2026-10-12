/** Frontends under test, with the local ports documented in the README. */
export interface FrontendApp {
  name: 'web' | 'booking' | 'client' | 'tracking' | 'ops' | 'crew';
  port: number;
  /** Public page checked by the foundation test. */
  path: string;
  title: string;
  heading: string;
}

export const frontendApps: readonly FrontendApp[] = [
  { name: 'web', port: 3000, path: '/', title: 'EURO TERANGA', heading: 'EURO TERANGA' },
  {
    name: 'booking',
    port: 3001,
    path: '/',
    title: 'EURO TERANGA Booking',
    heading: 'EURO TERANGA Booking',
  },
  {
    name: 'client',
    port: 3002,
    path: '/',
    title: 'EURO TERANGA Client',
    heading: 'EURO TERANGA Client',
  },
  {
    name: 'tracking',
    port: 3003,
    path: '/',
    title: 'EURO TERANGA Tracking',
    heading: 'EURO TERANGA Tracking',
  },
  // The OPS home page now requires a STAFF session; its public page is the login.
  {
    name: 'ops',
    port: 3004,
    path: '/connexion',
    title: 'Connexion opérations — EURO TERANGA Ops',
    heading: 'Connexion opérations',
  },
  { name: 'crew', port: 3005, path: '/', title: 'EURO TERANGA Crew', heading: 'EURO TERANGA Crew' },
];

/**
 * Apps and API are addressed as "localhost" (not 127.0.0.1): the API's CORS
 * and realm origin allow-lists list http://localhost:<port>, and the session
 * cookie must be same-site with the page.
 */
export const appUrl = (app: FrontendApp, path = app.path): string =>
  `http://localhost:${app.port}${path}`;

export const appByName = (name: FrontendApp['name']): FrontendApp => {
  const app = frontendApps.find((candidate) => candidate.name === name);
  if (!app) throw new Error(`unknown app ${name}`);
  return app;
};

export const API_URL = 'http://127.0.0.1:4000';
