/** Frontends under test, with the local ports documented in the README. */
export interface FrontendApp {
  name: 'web' | 'booking' | 'client' | 'tracking' | 'ops' | 'crew';
  port: number;
  title: string;
  heading: string;
}

export const frontendApps: readonly FrontendApp[] = [
  { name: 'web', port: 3000, title: 'EURO TERANGA', heading: 'EURO TERANGA' },
  { name: 'booking', port: 3001, title: 'EURO TERANGA Booking', heading: 'EURO TERANGA Booking' },
  { name: 'client', port: 3002, title: 'EURO TERANGA Client', heading: 'EURO TERANGA Client' },
  {
    name: 'tracking',
    port: 3003,
    title: 'EURO TERANGA Tracking',
    heading: 'EURO TERANGA Tracking',
  },
  { name: 'ops', port: 3004, title: 'EURO TERANGA Ops', heading: 'Operations Control Center' },
  { name: 'crew', port: 3005, title: 'EURO TERANGA Crew', heading: 'EURO TERANGA Crew' },
];

export const appUrl = (app: FrontendApp): string => `http://127.0.0.1:${app.port}`;
