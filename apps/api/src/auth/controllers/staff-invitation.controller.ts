import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import {
  StaffInvitationAcceptBody,
  staffInvitationAcceptSchema,
} from '../../authorization/authorization.dto.js';
import { AuthStatusResponse } from '../dto/auth.dto.js';
import { AuthRequestGuard } from '../http/auth.guards.js';
import { AuthRealmRoute } from '../http/request-context.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { StaffProvisioningService } from '../staff-provisioning/staff-provisioning.service.js';

@ApiTags('auth: staff provisioning')
@Controller({ path: 'auth/staff/invitation', version: '1' })
@AuthRealmRoute('staff')
@UseGuards(AuthRequestGuard)
export class StaffInvitationController {
  constructor(private readonly provisioning: StaffProvisioningService) {}

  @Post('accept')
  @HttpCode(200)
  @ApiBody({ type: StaffInvitationAcceptBody })
  @ApiOkResponse({ type: AuthStatusResponse })
  async accept(
    @Body(new ZodValidationPipe(staffInvitationAcceptSchema))
    body: z.infer<typeof staffInvitationAcceptSchema>,
  ): Promise<AuthStatusResponse> {
    await this.provisioning.acceptInvitation(body.token, body.newPassword);
    return { status: 'STAFF_INVITATION_ACCEPTED' };
  }
}
