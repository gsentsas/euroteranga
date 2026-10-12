import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { z } from 'zod';

const roleKey = z
  .string()
  .trim()
  .regex(/^[A-Z][A-Z0-9_]{0,63}$/);
const reason = z.string().trim().min(1).max(255).optional();
const pageLimit = z.coerce.number().int().min(1).max(100).default(50);
const cursor = z.uuid().optional();

export const roleMutationSchema = z.object({ roleKey, reason }).strict();
export const staffInvitationSchema = z
  .object({ email: z.string().trim().max(254).pipe(z.email()), roleKey })
  .strict();
export const staffInvitationAcceptSchema = z
  .object({ token: z.string().min(1).max(256), newPassword: z.string().min(1).max(1024) })
  .strict();
export const identityStatusSchema = z
  .object({ status: z.enum(['ACTIVE', 'SUSPENDED', 'DISABLED']), reason })
  .strict();
export const reasonSchema = z.object({ reason }).strict();
export const identityListQuerySchema = z
  .object({ realm: z.enum(['staff', 'crew']).default('staff'), limit: pageLimit, cursor })
  .strict();
export const auditListQuerySchema = z.object({ limit: pageLimit, cursor }).strict();

// --- OpenAPI documentation -------------------------------------------------

export class RoleMutationBody {
  @ApiProperty({ example: 'OPS_MANAGER' }) roleKey!: string;
  @ApiPropertyOptional({ maxLength: 255 }) reason?: string;
}

export class StaffInvitationBody {
  @ApiProperty({ format: 'email' }) email!: string;
  @ApiProperty({ description: 'STAFF role granted with the invitation' }) roleKey!: string;
}

export class StaffInvitationAcceptBody {
  @ApiProperty({ writeOnly: true, description: 'Token from the invitation link (#token=...)' })
  token!: string;
  @ApiProperty({ format: 'password', writeOnly: true, minLength: 15 }) newPassword!: string;
}

export class IdentityStatusBody {
  @ApiProperty({ enum: ['ACTIVE', 'SUSPENDED', 'DISABLED'] })
  status!: 'ACTIVE' | 'SUSPENDED' | 'DISABLED';
  @ApiPropertyOptional({ maxLength: 255 }) reason?: string;
}

export class ReasonBody {
  @ApiPropertyOptional({ maxLength: 255 }) reason?: string;
}

export class AccessResponse {
  @ApiProperty({ type: [String] }) roles!: string[];
  @ApiProperty({ type: [String] }) permissions!: string[];
}
