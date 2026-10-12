import {
  Inject,
  Injectable,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AUTH_CONFIG, isRealm, type AuthConfig, type Realm } from '../auth.config.js';
import { CsrfService } from '../csrf/csrf.service.js';
import { AuthCookies } from '../session/auth-cookies.js';
import { SessionService } from '../session/session.service.js';
import { AuthErrors } from './public-api-error.js';
import { AUTH_REALM_KEY, type AuthRequest } from './request-context.js';

export const CSRF_HEADER = 'x-csrf-token';

/** Marks a route that works without a session (e.g. idempotent logout). */
export const SESSION_OPTIONAL_KEY = 'euroteranga:session-optional';
export const SessionOptional = () => SetMetadata(SESSION_OPTIONAL_KEY, true);

function routeRealm(reflector: Reflector, context: ExecutionContext): Realm {
  const fromMetadata = reflector.getAllAndOverride<Realm | undefined>(AUTH_REALM_KEY, [
    context.getHandler(),
    context.getClass(),
  ]);
  const fromPath = context.switchToHttp().getRequest<AuthRequest>().params.realm;
  const realm = fromMetadata ?? fromPath;
  if (!isRealm(realm)) throw AuthErrors.unauthenticated();
  return realm;
}

/**
 * Browser request checks for every auth route:
 * - when an Origin header is present it must be one of the realm's exact
 *   origins (a customer page cannot drive the staff realm);
 * - POST bodies must be JSON, which forces a CORS preflight for any
 *   cross-origin caller and rules out HTML-form CSRF.
 */
@Injectable()
export class AuthRequestGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    const realm = routeRealm(this.reflector, context);

    const origin = request.header('origin');
    if (origin !== undefined && !this.config.realms[realm].origins.includes(origin)) {
      throw AuthErrors.origin();
    }
    if (request.method === 'POST' && !request.is('application/json')) {
      throw AuthErrors.unsupportedMediaType();
    }
    return true;
  }
}

/** Requires a valid session of the route's realm and exposes the principal. */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly cookies: AuthCookies,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    const realm = routeRealm(this.reflector, context);
    const principal = await this.sessions.authenticate(
      realm,
      this.cookies.readSession(request, realm),
    );

    if (principal) {
      request.authPrincipal = principal;
      return true;
    }
    if (this.reflector.getAllAndOverride<boolean>(SESSION_OPTIONAL_KEY, [context.getHandler()])) {
      return true;
    }
    throw AuthErrors.unauthenticated();
  }
}

/**
 * Requires a CSRF token bound to the current session on authenticated
 * mutations. SameSite=Strict cookies are a complement, not a replacement.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly csrf: CsrfService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    const principal = request.authPrincipal;
    if (!principal) {
      // Fail closed: only explicitly session-optional routes (idempotent
      // logout without a session) may continue without a principal.
      if (this.reflector.getAllAndOverride<boolean>(SESSION_OPTIONAL_KEY, [context.getHandler()])) {
        return true;
      }
      throw AuthErrors.unauthenticated();
    }
    if (!this.csrf.verify(principal.sessionId, request.header(CSRF_HEADER))) {
      throw AuthErrors.csrf();
    }
    return true;
  }
}
