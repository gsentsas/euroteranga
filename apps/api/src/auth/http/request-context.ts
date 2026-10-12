import {
  createParamDecorator,
  NotFoundException,
  SetMetadata,
  type ExecutionContext,
  type PipeTransform,
} from '@nestjs/common';
import type { Request } from 'express';
import { isRealm, type Realm } from '../auth.config.js';
import type { AuthPrincipal } from '../session/auth-principal.js';

export interface AuthRequest extends Request {
  authPrincipal?: AuthPrincipal;
}

/** Realm of routes whose path does not contain `:realm`. */
export const AUTH_REALM_KEY = 'euroteranga:auth-realm';
export const AuthRealmRoute = (realm: Realm) => SetMetadata(AUTH_REALM_KEY, realm);

/** Unknown realms are reported as missing routes, not as validation errors. */
export class ParseRealmPipe implements PipeTransform<string, Realm> {
  transform(value: string): Realm {
    if (!isRealm(value)) throw new NotFoundException();
    return value;
  }
}

/**
 * Client address as resolved by Express. It honours X-Forwarded-For only when
 * API_TRUST_PROXY allows it; by default it is the TCP peer address.
 */
export const ClientIp = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const request = context.switchToHttp().getRequest<Request>();
  return request.ip ?? request.socket.remoteAddress ?? 'unknown';
});

export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthPrincipal | undefined =>
    context.switchToHttp().getRequest<AuthRequest>().authPrincipal,
);
