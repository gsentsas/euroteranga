import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiOkResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import type { z } from 'zod';
import { AuthStatusResponse, ErrorBody } from '../../auth/dto/auth.dto.js';
import { AuthRequestGuard } from '../../auth/http/auth.guards.js';
import { AuthRealmRoute, ClientIp } from '../../auth/http/request-context.js';
import { ZodValidationPipe } from '../../auth/http/zod-validation.pipe.js';
import { StaffInvitationAcceptBody, staffInvitationAcceptSchema } from '../authorization.dto.js';
import { StaffProvisioningService } from './staff-provisioning.service.js';

/**
 * Public (pre-authentication) acceptance of a STAFF invitation. It sets the
 * password only; MFA enrollment happens at the first login.
 */
@ApiTags('auth: staff provisioning')
@ApiTooManyRequestsResponse({ type: ErrorBody })
@Controller({ path: 'auth/staff/invitation', version: '1' })
@AuthRealmRoute('staff')
@UseGuards(AuthRequestGuard)
export class StaffInvitationController {
  constructor(private readonly provisioning: StaffProvisioningService) {}

  @Post('accept')
  @HttpCode(200)
  @ApiBody({ type: StaffInvitationAcceptBody })
  @ApiOkResponse({ type: AuthStatusResponse })
  @ApiBadRequestResponse({ type: ErrorBody, description: 'INVALID_OR_EXPIRED_INVITATION' })
  async accept(
    @Body(new ZodValidationPipe(staffInvitationAcceptSchema))
    body: z.infer<typeof staffInvitationAcceptSchema>,
    @ClientIp() ip: string,
  ): Promise<AuthStatusResponse> {
    await this.provisioning.acceptInvitation(body.token, body.newPassword, ip);
    return { status: 'STAFF_INVITATION_ACCEPTED' };
  }
}
