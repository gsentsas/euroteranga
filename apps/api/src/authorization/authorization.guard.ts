import { Injectable, SetMetadata, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthRequest } from '../auth/http/request-context.js';
import { AuthorizationErrors } from './authorization.errors.js';
import { AuthorizationService } from './authorization.service.js';
import type { PermissionKey } from './permissions.js';

export const REQUIRED_PERMISSIONS_KEY = 'euroteranga:required-permissions';

/**
 * Declares the permissions an action requires. Class- and method-level
 * declarations add up (a method cannot drop a class requirement).
 */
export const RequirePermissions = (...permissions: PermissionKey[]) =>
  SetMetadata(REQUIRED_PERMISSIONS_KEY, permissions);

/**
 * Server-side permission enforcement, deny by default:
 * - no authenticated principal → 403;
 * - guard applied without any declared permission → 403 (a forgotten
 *   decorator must not open an endpoint);
 * - missing any required permission → 403.
 * Permissions are read from the database on every request. Hiding a menu in
 * the UI is never a substitute.
 */
@Injectable()
export class AuthorizationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authorization: AuthorizationService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = [
      ...new Set(
        this.reflector.getAllAndMerge<PermissionKey[]>(REQUIRED_PERMISSIONS_KEY, [
          context.getClass(),
          context.getHandler(),
        ]),
      ),
    ];
    const principal = context.switchToHttp().getRequest<AuthRequest>().authPrincipal;
    if (!principal || required.length === 0) throw AuthorizationErrors.forbidden();
    if (!(await this.authorization.hasAll(principal.identityId, required))) {
      throw AuthorizationErrors.forbidden();
    }
    return true;
  }
}
