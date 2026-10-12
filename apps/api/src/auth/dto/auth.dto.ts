import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { z } from 'zod';

/**
 * Request schemas (validation) and matching OpenAPI classes (documentation).
 * Password policy is checked by the services, which give a useful message;
 * the schemas only bound sizes (protecting Argon2 from oversized input).
 */
const email = z.string().trim().max(254).pipe(z.email());
const password = z.string().min(1).max(1024);
const opaqueToken = z.string().min(1).max(256);

export const loginSchema = z.object({ email, password });
export const registerSchema = z.object({ email, password });
export const verifyEmailSchema = z.object({ token: opaqueToken, password });
export const emailOnlySchema = z.object({ email });
export const resetPasswordSchema = z.object({ token: opaqueToken, newPassword: password });
export const changePasswordSchema = z.object({ currentPassword: password, newPassword: password });
export const mfaCodeSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/),
});
export const mfaVerifySchema = z.union([
  z
    .object({
      code: z
        .string()
        .trim()
        .regex(/^\d{6}$/),
    })
    .strict(),
  z.object({ recoveryCode: z.string().trim().min(16).max(32) }).strict(),
]);

// --- OpenAPI documentation -------------------------------------------------

export class LoginBody {
  @ApiProperty({ format: 'email' }) email!: string;
  @ApiProperty({ format: 'password', writeOnly: true }) password!: string;
}

export class RegisterBody {
  @ApiProperty({ format: 'email' }) email!: string;
  @ApiProperty({
    format: 'password',
    writeOnly: true,
    minLength: 15,
    description: 'At least 15 characters; passphrases, spaces and Unicode are allowed.',
  })
  password!: string;
}

export class VerifyEmailBody {
  @ApiProperty({ writeOnly: true, description: 'Token from the verification link (#token=...)' })
  token!: string;
  @ApiProperty({
    format: 'password',
    writeOnly: true,
    description: 'Password chosen at registration',
  })
  password!: string;
}

export class EmailBody {
  @ApiProperty({ format: 'email' }) email!: string;
}

export class ResetPasswordBody {
  @ApiProperty({ writeOnly: true, description: 'Token from the reset link (#token=...)' })
  token!: string;
  @ApiProperty({ format: 'password', writeOnly: true, minLength: 15 }) newPassword!: string;
}

export class ChangePasswordBody {
  @ApiProperty({ format: 'password', writeOnly: true }) currentPassword!: string;
  @ApiProperty({ format: 'password', writeOnly: true, minLength: 15 }) newPassword!: string;
}

export class MfaCodeBody {
  @ApiProperty({ writeOnly: true, pattern: '^\\d{6}$', description: 'Current TOTP code' })
  code!: string;
}

export class MfaVerifyBody {
  @ApiPropertyOptional({ writeOnly: true, pattern: '^\\d{6}$', description: 'Current TOTP code' })
  code?: string;
  @ApiPropertyOptional({ writeOnly: true, description: 'One recovery code (instead of code)' })
  recoveryCode?: string;
}

export class AuthStatusResponse {
  @ApiProperty({
    enum: [
      'AUTHENTICATED',
      'MFA_REQUIRED',
      'MFA_ENROLLMENT_REQUIRED',
      'EMAIL_VERIFIED',
      'PASSWORD_RESET',
      'PASSWORD_CHANGED',
    ],
  })
  status!: string;
}

export class AcceptedResponse {
  @ApiProperty() message!: string;
}

export class MeResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ['customer', 'staff', 'crew'] }) realm!: string;
  @ApiProperty({ format: 'email' }) email!: string;
  @ApiProperty() emailVerified!: boolean;
}

export class SessionResponse {
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) idleExpiresAt!: string;
  @ApiProperty({ format: 'date-time' }) absoluteExpiresAt!: string;
}

export class CsrfResponse {
  @ApiProperty({ description: 'Send back in the X-CSRF-Token header; keep in memory only.' })
  csrfToken!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
}

export class MfaEnrollmentResponse {
  @ApiProperty({ description: 'otpauth:// URI for authenticator apps (contains the secret).' })
  otpauthUri!: string;
  @ApiProperty({ description: 'Base32 secret for manual entry. Shown once.' })
  secret!: string;
}

export class MfaEnrollmentConfirmResponse extends AuthStatusResponse {
  @ApiProperty({ type: [String], description: 'Single-use recovery codes. Shown once.' })
  recoveryCodes!: string[];
}

export class ErrorBody {
  @ApiProperty() code!: string;
  @ApiProperty() message!: string;
  @ApiProperty({ nullable: true }) requestId!: string;
}
