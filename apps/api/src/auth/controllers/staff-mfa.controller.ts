import { Body, Controller, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import {
  ApiBody,
  ApiOkResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import {
  AuthStatusResponse,
  ErrorBody,
  MfaCodeBody,
  mfaCodeSchema,
  MfaEnrollmentConfirmResponse,
  MfaEnrollmentResponse,
  MfaVerifyBody,
  mfaVerifySchema,
} from '../dto/auth.dto.js';
import { AuthRequestGuard } from '../http/auth.guards.js';
import { AuthRealmRoute, ClientIp } from '../http/request-context.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { StaffMfaService } from '../mfa/staff-mfa.service.js';
import { AuthCookies } from '../session/auth-cookies.js';

/**
 * Second factor for STAFF. Every route requires the short-lived challenge
 * cookie set by a correct password; none of them works with a password alone.
 */
@ApiTags('auth: staff mfa')
@ApiUnauthorizedResponse({
  type: ErrorBody,
  description: 'MFA_CODE_INVALID / MFA_CHALLENGE_INVALID',
})
@ApiTooManyRequestsResponse({ type: ErrorBody })
@Controller({ path: 'auth/staff/mfa', version: '1' })
@AuthRealmRoute('staff')
@UseGuards(AuthRequestGuard)
export class StaffMfaController {
  constructor(
    private readonly mfa: StaffMfaService,
    private readonly cookies: AuthCookies,
  ) {}

  @Post('verify')
  @HttpCode(200)
  @ApiBody({ type: MfaVerifyBody })
  @ApiOkResponse({ type: AuthStatusResponse, description: 'Session cookie set.' })
  async verify(
    @Body(new ZodValidationPipe(mfaVerifySchema)) body: z.infer<typeof mfaVerifySchema>,
    @ClientIp() ip: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthStatusResponse> {
    const session = await this.mfa.verifyLogin(this.cookies.readStaffChallenge(request), body, ip);
    this.cookies.clearStaffChallenge(response);
    this.cookies.setSession(response, 'staff', session.token, session.absoluteExpiresAt);
    return { status: 'AUTHENTICATED' };
  }

  @Post('enrollment/start')
  @HttpCode(200)
  @ApiOkResponse({ type: MfaEnrollmentResponse })
  startEnrollment(@Req() request: Request): Promise<MfaEnrollmentResponse> {
    return this.mfa.startEnrollment(this.cookies.readStaffChallenge(request));
  }

  @Post('enrollment/confirm')
  @HttpCode(200)
  @ApiBody({ type: MfaCodeBody })
  @ApiOkResponse({
    type: MfaEnrollmentConfirmResponse,
    description: 'Session cookie set; recovery codes shown once.',
  })
  async confirmEnrollment(
    @Body(new ZodValidationPipe(mfaCodeSchema)) body: z.infer<typeof mfaCodeSchema>,
    @ClientIp() ip: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<MfaEnrollmentConfirmResponse> {
    const { session, recoveryCodes } = await this.mfa.confirmEnrollment(
      this.cookies.readStaffChallenge(request),
      body.code,
      ip,
    );
    this.cookies.clearStaffChallenge(response);
    this.cookies.setSession(response, 'staff', session.token, session.absoluteExpiresAt);
    return { status: 'AUTHENTICATED', recoveryCodes };
  }
}
