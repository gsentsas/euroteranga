import { AuthSessionRevocationReason } from '@euroteranga/database';
import { Body, Controller, Get, HttpCode, Param, Post, Res, UseGuards } from '@nestjs/common';
import {
  ApiBody,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiParam,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Realm } from '../auth.config.js';
import { CsrfService } from '../csrf/csrf.service.js';
import {
  AuthStatusResponse,
  ChangePasswordBody,
  changePasswordSchema,
  CsrfResponse,
  ErrorBody,
  LoginBody,
  loginSchema,
  MeResponse,
  SessionResponse,
} from '../dto/auth.dto.js';
import { AuthRequestGuard, CsrfGuard, SessionGuard, SessionOptional } from '../http/auth.guards.js';
import { AuthErrors } from '../http/public-api-error.js';
import { ClientIp, CurrentPrincipal, ParseRealmPipe } from '../http/request-context.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { IdentityQueries } from '../identity/identity.queries.js';
import { LoginService } from '../login/login.service.js';
import { PasswordChangeService } from '../recovery/password-change.service.js';
import { SecurityEventLogger } from '../security-log/security-events.js';
import type { AuthPrincipal } from '../session/auth-principal.js';
import { AuthCookies } from '../session/auth-cookies.js';
import { SessionService } from '../session/session.service.js';

/** Flows shared by the three realms. HTTP concerns only; logic lives in services. */
@ApiTags('auth: sessions')
@ApiParam({ name: 'realm', enum: ['customer', 'staff', 'crew'] })
@ApiForbiddenResponse({ type: ErrorBody, description: 'Origin not allowed or CSRF token invalid' })
@Controller({ path: 'auth/:realm', version: '1' })
@UseGuards(AuthRequestGuard)
export class RealmAuthController {
  constructor(
    private readonly login: LoginService,
    private readonly sessions: SessionService,
    private readonly passwordChange: PasswordChangeService,
    private readonly csrf: CsrfService,
    private readonly cookies: AuthCookies,
    private readonly identities: IdentityQueries,
    private readonly securityLog: SecurityEventLogger,
  ) {}

  @Post('login')
  @HttpCode(200)
  @ApiBody({ type: LoginBody })
  @ApiOkResponse({
    type: AuthStatusResponse,
    description:
      'AUTHENTICATED (session cookie set) or, for staff, MFA_REQUIRED / MFA_ENROLLMENT_REQUIRED (challenge cookie set).',
  })
  @ApiUnauthorizedResponse({
    type: ErrorBody,
    description: 'INVALID_CREDENTIALS (same for every cause)',
  })
  @ApiTooManyRequestsResponse({ type: ErrorBody })
  async signIn(
    @Param('realm', ParseRealmPipe) realm: Realm,
    @Body(new ZodValidationPipe(loginSchema)) body: z.infer<typeof loginSchema>,
    @ClientIp() ip: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthStatusResponse> {
    const outcome = await this.login.login(realm, body.email, body.password, ip);
    if (outcome.kind === 'challenge') {
      this.cookies.setStaffChallenge(response, outcome.token, outcome.expiresAt);
      return { status: outcome.status };
    }
    this.cookies.setSession(
      response,
      realm,
      outcome.session.token,
      outcome.session.absoluteExpiresAt,
    );
    return { status: 'AUTHENTICATED' };
  }

  @Get('me')
  @UseGuards(SessionGuard)
  @ApiOkResponse({ type: MeResponse })
  @ApiUnauthorizedResponse({ type: ErrorBody })
  async me(@CurrentPrincipal() principal: AuthPrincipal): Promise<MeResponse> {
    return this.identities.me(principal);
  }

  @Get('session')
  @UseGuards(SessionGuard)
  @ApiOkResponse({ type: SessionResponse })
  @ApiUnauthorizedResponse({ type: ErrorBody })
  async session(@CurrentPrincipal() principal: AuthPrincipal): Promise<SessionResponse> {
    const session = await this.sessions.describe(principal.sessionId);
    if (!session) throw AuthErrors.unauthenticated();
    return {
      createdAt: session.createdAt.toISOString(),
      idleExpiresAt: session.idleExpiresAt.toISOString(),
      absoluteExpiresAt: session.absoluteExpiresAt.toISOString(),
    };
  }

  @Get('csrf')
  @UseGuards(SessionGuard)
  @ApiOkResponse({ type: CsrfResponse })
  @ApiUnauthorizedResponse({ type: ErrorBody })
  csrfToken(@CurrentPrincipal() principal: AuthPrincipal): CsrfResponse {
    const issued = this.csrf.issue(principal.sessionId);
    return { csrfToken: issued.csrfToken, expiresAt: issued.expiresAt.toISOString() };
  }

  /** Idempotent: without a valid session it still clears the cookie. */
  @Post('logout')
  @HttpCode(204)
  @SessionOptional()
  @UseGuards(SessionGuard, CsrfGuard)
  @ApiNoContentResponse()
  async logout(
    @Param('realm', ParseRealmPipe) realm: Realm,
    @CurrentPrincipal() principal: AuthPrincipal | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    if (principal) {
      await this.sessions.revoke(principal.sessionId, AuthSessionRevocationReason.LOGOUT);
      this.securityLog.record('AUTH_LOGOUT', { realm, identityId: principal.identityId });
    }
    this.cookies.clearSession(response, realm);
  }

  @Post('sessions/revoke-all')
  @HttpCode(204)
  @UseGuards(SessionGuard, CsrfGuard)
  @ApiNoContentResponse({
    description: 'Every session of the caller, including this one, is revoked.',
  })
  async revokeAll(
    @Param('realm', ParseRealmPipe) realm: Realm,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.identities.revokeAllSessions(principal, AuthSessionRevocationReason.LOGOUT_ALL);
    this.securityLog.record('AUTH_SESSION_REVOKED', {
      realm,
      identityId: principal.identityId,
      scope: 'all',
    });
    this.cookies.clearSession(response, realm);
  }

  @Post('password/change')
  @HttpCode(200)
  @UseGuards(SessionGuard, CsrfGuard)
  @ApiBody({ type: ChangePasswordBody })
  @ApiOkResponse({
    type: AuthStatusResponse,
    description: 'All sessions revoked; a new session cookie is set.',
  })
  async changePassword(
    @Param('realm', ParseRealmPipe) realm: Realm,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(changePasswordSchema)) body: z.infer<typeof changePasswordSchema>,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthStatusResponse> {
    const session = await this.passwordChange.changePassword(
      principal,
      body.currentPassword,
      body.newPassword,
    );
    this.cookies.setSession(response, realm, session.token, session.absoluteExpiresAt);
    return { status: 'PASSWORD_CHANGED' };
  }
}
