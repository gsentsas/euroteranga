import { describe, expect, it } from 'vitest';
import { loadJourneyPublicUrls, loadPublicEnv } from './index.js';

describe('traveller public URLs', () => {
  it('normalizes the four JourneyShell destinations', () => {
    const env = loadPublicEnv({
      NEXT_PUBLIC_APP_ENV: 'ci',
      NEXT_PUBLIC_API_BASE_URL: 'http://localhost:4000',
      NEXT_PUBLIC_SITE_URL: 'http://localhost:3000/',
      NEXT_PUBLIC_BOOKING_URL: 'http://localhost:3001/',
      NEXT_PUBLIC_CLIENT_URL: 'http://localhost:3002/',
      NEXT_PUBLIC_TRACKING_URL: 'http://localhost:3003/',
    });

    expect(loadJourneyPublicUrls(env)).toEqual({
      home: 'http://localhost:3000/',
      booking: 'http://localhost:3001/',
      client: 'http://localhost:3002/compte',
      tracking: 'http://localhost:3003/',
    });
  });

  it('fails closed when a JourneyShell destination is missing', () => {
    const env = loadPublicEnv({
      NEXT_PUBLIC_APP_ENV: 'ci',
      NEXT_PUBLIC_API_BASE_URL: 'http://localhost:4000',
      NEXT_PUBLIC_CLIENT_URL: 'http://localhost:3002',
    });

    expect(() => loadJourneyPublicUrls(env)).toThrow('NEXT_PUBLIC_SITE_URL');
    expect(() => loadJourneyPublicUrls(env)).toThrow('NEXT_PUBLIC_BOOKING_URL');
    expect(() => loadJourneyPublicUrls(env)).toThrow('NEXT_PUBLIC_TRACKING_URL');
  });

  it('requires https for configured journey URLs in deployed environments', () => {
    expect(() =>
      loadPublicEnv({
        NEXT_PUBLIC_APP_ENV: 'production',
        NEXT_PUBLIC_API_BASE_URL: 'https://api.euroteranga.com',
        NEXT_PUBLIC_SITE_URL: 'http://euroteranga.com',
        NEXT_PUBLIC_BOOKING_URL: 'https://booking.euroteranga.com',
        NEXT_PUBLIC_CLIENT_URL: 'https://client.euroteranga.com',
        NEXT_PUBLIC_TRACKING_URL: 'https://tracking.euroteranga.com',
      }),
    ).toThrow('NEXT_PUBLIC_SITE_URL');
  });
});
