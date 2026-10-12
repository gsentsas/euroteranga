import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { z } from 'zod';

const roleKey = z.string().trim().min(1).max(64);
const reason = z.string().trim().min(1).max(255).optional();

export const roleMutationSchema = z.object({ roleKey, reason }).strict();
export const staffInvitationSchema = z
  .object({ email: z.string().trim().max(254).pipe(z.email()), roleKey })
  .strict();
export const staffInvitationAcceptSchema = z
  .object({
    token: z.string().min(1).max(256),
    newPassword: z.string().min(1).max(1024),
  })
  .strict();
export const identityStatusSchema = z
  .object({ status: z.enum(['ACTIVE', 'SUSPENDED', 'DISABLED']), reason })
  .strict();
export const reasonSchema = z.object({ reason }).strict();

export class RoleMutationBody {
  @ApiProperty() roleKey!: string;
  @ApiPropertyOptional() reason?: string;
}

export class StaffInvitationBody {
  @ApiProperty({ format: 'email' }) email!: string;
  @ApiProperty() roleKey!: string;
}

export class StaffInvitationAcceptBody {
  @ApiProperty({ writeOnly: true }) token!: string;
  @ApiProperty({ format: 'password', writeOnly: true, minLength: 15 }) newPassword!: string;
}

export class IdentityStatusBody {
  @ApiProperty({ enum: ['ACTIVE', 'SUSPENDED', 'DISABLED'] }) status!:
    | 'ACTIVE'
    | 'SUSPENDED'
    | 'DISABLED';
  @ApiPropertyOptional() reason?: string;
}

export class ReasonBody {
  @ApiPropertyOptional() reason?: string;
}
