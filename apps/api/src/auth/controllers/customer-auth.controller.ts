import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBody,
  ApiOkResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { z } from 'zod';
import {
  AcceptedResponse,
  AuthStatusResponse,
  EmailBody,
  emailOnlySchema,
  ErrorBody,
  RegisterBody,
  registerSchema,
  ResetPasswordBody,
  resetPasswordSchema,
  VerifyEmailBody,
  verifyEmailSchema,
} from '../dto/auth.dto.js';
import { AuthRequestGuard } from '../http/auth.guards.js';
import { AuthRealmRoute, ClientIp } from '../http/request-context.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { PasswordRecoveryService } from '../recovery/password-recovery.service.js';
import { RegistrationService } from '../registration/registration.service.js';

const GENERIC_REGISTRATION =
  'Si cette adresse peut être utilisée, les prochaines instructions seront envoyées.';
const GENERIC_RESET = 'Si un compte correspondant existe, les instructions ont été envoyées.';

/** Customer-only public flows. STAFF and CREW have no self-service equivalent. */
@ApiTags('auth: customer')
@ApiTooManyRequestsResponse({ type: ErrorBody })
@Controller({ path: 'auth/customer', version: '1' })
@AuthRealmRoute('customer')
@UseGuards(AuthRequestGuard)
export class CustomerAuthController {
  constructor(
    private readonly registration: RegistrationService,
    private readonly recovery: PasswordRecoveryService,
  ) {}

  @Post('register')
  @HttpCode(202)
  @ApiBody({ type: RegisterBody })
  @ApiAcceptedResponse({
    type: AcceptedResponse,
    description: 'Same response whether or not the address exists.',
  })
  @ApiUnprocessableEntityResponse({ type: ErrorBody, description: 'Password policy violation' })
  async register(
    @Body(new ZodValidationPipe(registerSchema)) body: z.infer<typeof registerSchema>,
    @ClientIp() ip: string,
  ): Promise<AcceptedResponse> {
    await this.registration.register(body.email, body.password, ip);
    return { message: GENERIC_REGISTRATION };
  }

  @Post('verify-email')
  @HttpCode(200)
  @ApiBody({ type: VerifyEmailBody })
  @ApiOkResponse({ type: AuthStatusResponse })
  @ApiBadRequestResponse({ type: ErrorBody })
  async verifyEmail(
    @Body(new ZodValidationPipe(verifyEmailSchema)) body: z.infer<typeof verifyEmailSchema>,
    @ClientIp() ip: string,
  ): Promise<AuthStatusResponse> {
    await this.registration.verifyEmail(body.token, body.password, ip);
    return { status: 'EMAIL_VERIFIED' };
  }

  @Post('resend-verification')
  @HttpCode(202)
  @ApiBody({ type: EmailBody })
  @ApiAcceptedResponse({ type: AcceptedResponse })
  async resendVerification(
    @Body(new ZodValidationPipe(emailOnlySchema)) body: z.infer<typeof emailOnlySchema>,
    @ClientIp() ip: string,
  ): Promise<AcceptedResponse> {
    await this.registration.resendVerification(body.email, ip);
    return { message: GENERIC_REGISTRATION };
  }

  @Post('password/forgot')
  @HttpCode(202)
  @ApiBody({ type: EmailBody })
  @ApiAcceptedResponse({
    type: AcceptedResponse,
    description: 'Same response whether or not the account exists.',
  })
  async forgotPassword(
    @Body(new ZodValidationPipe(emailOnlySchema)) body: z.infer<typeof emailOnlySchema>,
    @ClientIp() ip: string,
  ): Promise<AcceptedResponse> {
    await this.recovery.requestReset(body.email, ip);
    return { message: GENERIC_RESET };
  }

  @Post('password/reset')
  @HttpCode(200)
  @ApiBody({ type: ResetPasswordBody })
  @ApiOkResponse({ type: AuthStatusResponse })
  @ApiBadRequestResponse({ type: ErrorBody })
  @ApiUnprocessableEntityResponse({ type: ErrorBody })
  async resetPassword(
    @Body(new ZodValidationPipe(resetPasswordSchema)) body: z.infer<typeof resetPasswordSchema>,
    @ClientIp() ip: string,
  ): Promise<AuthStatusResponse> {
    await this.recovery.resetPassword(body.token, body.newPassword, ip);
    return { status: 'PASSWORD_RESET' };
  }
}
