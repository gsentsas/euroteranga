import { AuthIdentityStatus } from '@euroteranga/database';
import { Controller, Get, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { staffInvitationMail } from '../../../src/auth/mail/auth-mailer.js';
import { isAllowedStatusTransition } from '../../../src/authorization/access-rules.js';
import {
  AuthorizationGuard,
  RequirePermissions,
} from '../../../src/authorization/authorization.guard.js';
import type { AuthorizationService } from '../../../src/authorization/authorization.service.js';
import { PERMISSIONS } from '../../../src/authorization/permissions.js';

@Controller('probe')
@RequirePermissions(PERMISSIONS.OPS_ACCESS)
class ProbeController {
  @Get('declared')
  @RequirePermissions(PERMISSIONS.ROLE_READ)
  declared() {}

  @Get('class-only')
  classOnly() {}
}

@Controller('undeclared')
class UndeclaredController {
  @Get()
  open() {}
}

function context(controller: object, handler: string, principal?: object): ExecutionContext {
  const instance = controller as Record<string, unknown>;
  return {
    getClass: () => controller.constructor,
    getHandler: () => instance[handler],
    switchToHttp: () => ({ getRequest: () => ({ authPrincipal: principal }) }),
  } as unknown as ExecutionContext;
}

function guardWith(permissions: string[]) {
  const asked: string[][] = [];
  const service = {
    hasAll: async (_id: string, required: readonly string[]) => {
      asked.push([...required]);
      return (
        required.length > 0 && required.every((permission) => permissions.includes(permission))
      );
    },
  } as unknown as AuthorizationService;
  return { guard: new AuthorizationGuard(new Reflector(), service), asked };
}

const principal = { identityId: 'id', realm: 'staff', sessionId: 'session' };

describe('AuthorizationGuard (deny by default)', () => {
  it('refuses an endpoint guarded without any declared permission', async () => {
    const { guard } = guardWith(Object.values(PERMISSIONS));
    await expect(
      guard.canActivate(context(new UndeclaredController(), 'open', principal)),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('refuses when there is no authenticated principal', async () => {
    const { guard } = guardWith(Object.values(PERMISSIONS));
    await expect(
      guard.canActivate(context(new ProbeController(), 'declared')),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('requires class AND method permissions together', async () => {
    const { guard, asked } = guardWith([PERMISSIONS.OPS_ACCESS, PERMISSIONS.ROLE_READ]);
    await expect(
      guard.canActivate(context(new ProbeController(), 'declared', principal)),
    ).resolves.toBe(true);
    expect(asked[0]?.sort()).toEqual([PERMISSIONS.OPS_ACCESS, PERMISSIONS.ROLE_READ].sort());

    const onlyMethod = guardWith([PERMISSIONS.ROLE_READ]);
    await expect(
      onlyMethod.guard.canActivate(context(new ProbeController(), 'declared', principal)),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('applies the class requirement to methods without their own', async () => {
    const { guard, asked } = guardWith([PERMISSIONS.OPS_ACCESS]);
    await expect(
      guard.canActivate(context(new ProbeController(), 'classOnly', principal)),
    ).resolves.toBe(true);
    expect(asked[0]).toEqual([PERMISSIONS.OPS_ACCESS]);
  });
});

describe('identity status transitions', () => {
  it.each([
    [AuthIdentityStatus.ACTIVE, AuthIdentityStatus.SUSPENDED, true],
    [AuthIdentityStatus.ACTIVE, AuthIdentityStatus.DISABLED, true],
    [AuthIdentityStatus.SUSPENDED, AuthIdentityStatus.ACTIVE, true],
    [AuthIdentityStatus.SUSPENDED, AuthIdentityStatus.DISABLED, true],
    [AuthIdentityStatus.PENDING_VERIFICATION, AuthIdentityStatus.ACTIVE, false],
    [AuthIdentityStatus.DISABLED, AuthIdentityStatus.ACTIVE, false],
    [AuthIdentityStatus.ACTIVE, AuthIdentityStatus.ACTIVE, false],
    [AuthIdentityStatus.ACTIVE, AuthIdentityStatus.PENDING_VERIFICATION, false],
  ])('%s → %s allowed=%s', (from, to, allowed) => {
    expect(isAllowedStatusTransition(from, to)).toBe(allowed);
  });
});

describe('staff invitation mail', () => {
  it('links to the OPS invitation page with the token in the fragment only', () => {
    const token = 'A'.repeat(43);
    const mail = staffInvitationMail(
      'https://ops.example.test',
      'new@example.test',
      token,
      72 * 3_600_000,
    );
    expect(mail.to).toBe('new@example.test');
    expect(mail.text).toContain(`https://ops.example.test/invitation#token=${token}`);
    expect(mail.text).not.toMatch(/[?&]token=/);
    expect(mail.text).toContain('72 heures');
  });
});
