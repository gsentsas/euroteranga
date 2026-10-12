export interface RateLimitRule {
  /** Stable name, part of the bucket key and stored for operability. */
  action: string;
  limit: number;
  windowMs: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Every authentication rate limit, in one place. Identity buckets are keyed
 * by realm + normalised email whether or not the account exists, so a 429
 * reveals nothing about existence. There is no permanent lockout: buckets
 * expire with their window.
 */
export const RATE_LIMITS = {
  /** Failed logins per identity hint. */
  loginIdentity: { action: 'login:identity', limit: 5, windowMs: 15 * MINUTE },
  /** All login attempts per client address. */
  loginIp: { action: 'login:ip', limit: 30, windowMs: 15 * MINUTE },
  registerIp: { action: 'register:ip', limit: 10, windowMs: HOUR },
  passwordResetIdentity: { action: 'password-reset:identity', limit: 5, windowMs: HOUR },
  passwordResetIp: { action: 'password-reset:ip', limit: 20, windowMs: HOUR },
  verificationIdentity: { action: 'verification:identity', limit: 5, windowMs: HOUR },
  verificationIp: { action: 'verification:ip', limit: 20, windowMs: HOUR },
  /** Submissions of email-link tokens (verify email, reset password). */
  tokenSubmissionIp: { action: 'token:ip', limit: 30, windowMs: 15 * MINUTE },
  /** MFA verification per client address (challenges also cap attempts). */
  mfaIp: { action: 'mfa:ip', limit: 30, windowMs: 15 * MINUTE },
  /** Wrong current passwords per authenticated identity. */
  passwordChangeIdentity: { action: 'password-change:identity', limit: 5, windowMs: 15 * MINUTE },
} as const satisfies Record<string, RateLimitRule>;
