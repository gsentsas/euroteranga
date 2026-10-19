import { describe, expect, it } from 'vitest';
import { buildFoundationSecurityHeaders, loadPublicEnv } from './index.js';

function directives(appEnv: string, apiBaseUrl: string): Map<string, string[]> {
  const csp = buildFoundationSecurityHeaders(
    loadPublicEnv({ NEXT_PUBLIC_APP_ENV: appEnv, NEXT_PUBLIC_API_BASE_URL: apiBaseUrl }),
  ).find((header) => header.key === 'Content-Security-Policy')!.value;
  return new Map(
    csp.split('; ').map((directive) => {
      const [name = '', ...sources] = directive.split(' ');
      return [name, sources];
    }),
  );
}

describe('foundation Content-Security-Policy', () => {
  it('loads images from the site and the API origin only (MEDIA-1)', () => {
    const csp = directives('production', 'https://api.euroteranga.com/v1/');
    expect(csp.get('img-src')).toEqual(["'self'", 'data:', 'blob:', 'https://api.euroteranga.com']);
    for (const sources of csp.values()) {
      expect(sources).not.toContain('*');
      expect(sources).not.toContain('https:');
      expect(sources).not.toContain('http:');
    }
    expect(csp.get('frame-src')).toEqual(["'none'"]);
    expect(csp.get('object-src')).toEqual(["'none'"]);
    expect(csp.has('upgrade-insecure-requests')).toBe(true);
  });

  it('lets a form target the booking application only when asked, by exact origin (UI-PUBLIC-1)', () => {
    const env = loadPublicEnv({
      NEXT_PUBLIC_APP_ENV: 'production',
      NEXT_PUBLIC_API_BASE_URL: 'https://api.euroteranga.com',
    });
    const formAction = (options?: Parameters<typeof buildFoundationSecurityHeaders>[1]) =>
      buildFoundationSecurityHeaders(env, options)
        .find((header) => header.key === 'Content-Security-Policy')!
        .value.split('; ')
        .find((directive) => directive.startsWith('form-action'));
    expect(formAction()).toBe("form-action 'self'");
    expect(
      formAction({
        formActionOrigins: [
          'https://booking.euroteranga.com/reserver?x=1',
          'https://booking.euroteranga.com/',
        ],
      }),
    ).toBe("form-action 'self' https://booking.euroteranga.com");
    expect(() => formAction({ formActionOrigins: ['http://booking.euroteranga.com/'] })).toThrow(
      'https',
    );
    expect(() => formAction({ formActionOrigins: ['javascript:alert(1)'] })).toThrow();
    expect(() => formAction({ formActionOrigins: ['*'] })).toThrow();
  });
});
