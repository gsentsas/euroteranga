import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'EURO TERANGA Crew',
    short_name: 'ET Crew',
    description: 'Application terrain équipage EURO TERANGA.',
    start_url: '/session',
    scope: '/',
    display: 'standalone',
    background_color: '#f3f7f5',
    theme_color: '#071f1a',
    lang: 'fr',
    icons: [
      { src: '/crew-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: '/crew-icon-maskable.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
    ],
  };
}
