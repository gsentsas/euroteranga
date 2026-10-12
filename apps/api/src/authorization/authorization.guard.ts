import { Injectable, SetMetadata, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthRequest } from '../auth/http/request-context.js';
import { AuthorizationErrors } from './authorization.errors.js';
import { AuthorizationService } from './authorization.service.js';
import type { PermissionKey } from './permissions.js';

export const REQUIRED_PERMISSIONS_KEY = 'euroteranga:required-permissions';

export const RequirePermissions = (...permissions: PermissionKey[]) =>
  SetMetadata(REQUIRED_PERMISSIONS_KEY, permissions);

/**
 * Server-side permission enforcement. Navigation visibility is never treated
 * as authorization: every protected controller action goes through this guard.
 */
@Injectable()
export class AuthorizationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authorization: AuthorizationService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required =
      this.reflector.getAllAndOverride<readonly PermissionKey[]>(
        REQUIRED_PERMISSIONS_KEY,
        [context.getHandler(), context.getClass()],
      ) ?? [];
    if (required.length === 0) return true;

    const request = context.switchToHttp().getRequest<AuthRequest>();
    const principal = request.authPrincipal;
    if (!principal) throw AuthorizationErrors.forbidden();
    if (!(await this.authorization.hasAll(principal.identityId, required))) {
      throw AuthorizationErrors.forbidden();
    }
    return true;
  }
}
