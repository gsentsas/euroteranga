import { Inject, Injectable } from '@nestjs/common';
import { parseCookie } from 'cookie';
import type { CookieOptions, Request, Response } from 'express';
import { AUTH_CONFIG, type AuthConfig, type Realm } from '../auth.config.js';

/**
 * Session and challenge cookies. In staging/production: `__Host-` prefix,
 * Secure, HttpOnly, SameSite=Strict, Path=/ and no Domain attribute — a
 * host-only cookie of the API host, never shared with other subdomains.
 * Locally (plain HTTP) the names drop the prefix and Secure; the production
 * flags are derived from APP_ENV alone and cannot be turned off there.
 */
@Injectable()
export class AuthCookies {
  constructor(@Inject(AUTH_CONFIG) private readonly config: AuthConfig) {}

  private options(expires: Date): CookieOptions {
    return {
      httpOnly: true,
      secure: this.config.secureCookies,
      sameSite: 'strict',
      path: '/',
      expires,
    };
  }

  private read(request: Request, name: string): string | undefined {
    const header = request.headers.cookie;
    return header ? parseCookie(header)[name] : undefined;
  }

  private clear(response: Response, name: string): void {
    const { expires: _expires, ...options } = this.options(new Date(0));
    response.clearCookie(name, options);
  }

  readSession(request: Request, realm: Realm): string | undefined {
    return this.read(request, this.config.realms[realm].sessionCookieName);
  }

  setSession(response: Response, realm: Realm, token: string, expires: Date): void {
    response.cookie(this.config.realms[realm].sessionCookieName, token, this.options(expires));
  }

  clearSession(response: Response, realm: Realm): void {
    this.clear(response, this.config.realms[realm].sessionCookieName);
  }

  readStaffChallenge(request: Request): string | undefined {
    return this.read(request, this.config.staffChallengeCookieName);
  }

  setStaffChallenge(response: Response, token: string, expires: Date): void {
    response.cookie(this.config.staffChallengeCookieName, token, this.options(expires));
  }

  clearStaffChallenge(response: Response): void {
    this.clear(response, this.config.staffChallengeCookieName);
  }
}
