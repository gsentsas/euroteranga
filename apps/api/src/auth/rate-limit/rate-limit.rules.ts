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
  /** STAFF invitation acceptance per client address (PR-03). */
  staffInvitationIp: { action: 'staff-invitation:ip', limit: 20, windowMs: 15 * MINUTE },
  /** Wrong current passwords per authenticated identity. */
  passwordChangeIdentity: { action: 'password-change:identity', limit: 5, windowMs: 15 * MINUTE },
  /** Passenger-document uploads per authenticated CUSTOMER identity (PR-11). */
  passengerDocumentUploadIdentity: {
    action: 'passenger-document-upload:identity',
    limit: 20,
    windowMs: HOUR,
  },
  /** Public media library uploads per STAFF identity (MEDIA-1): decoding is costly. */
  publicMediaUploadIdentity: {
    action: 'public-media-upload:identity',
    limit: 60,
    windowMs: HOUR,
  },
  /** Compliance evaluations requested per authenticated CUSTOMER identity (PR-12). */
  complianceEvaluationIdentity: {
    action: 'compliance-evaluation:identity',
    limit: 30,
    windowMs: HOUR,
  },
  /** Customer baggage pre-registrations per authenticated identity (PR-13). */
  baggageRegistrationIdentity: {
    action: 'baggage-registration:identity',
    limit: 30,
    windowMs: HOUR,
  },
  /** STAFF operational scans/events: high enough for loading, finite for abuse. */
  baggageOperationIdentity: {
    action: 'baggage-operation:identity',
    limit: 600,
    windowMs: 15 * MINUTE,
  },
  /** STAFF road-freight writes and operational events. */
  cargoOperationIdentity: {
    action: 'cargo-operation:identity',
    limit: 600,
    windowMs: 15 * MINUTE,
  },
  /** Public Cargo tracking lookups per client address; tokens are capability secrets. */
  cargoPublicTrackingIp: {
    action: 'cargo-tracking:ip',
    limit: 300,
    windowMs: 15 * MINUTE,
  },
  /** Anonymous freight estimates: cheap but bounded to protect Pricing and PostgreSQL. */
  cargoPricingEstimateIp: {
    action: 'cargo-pricing-estimate:ip',
    limit: 120,
    windowMs: 15 * MINUTE,
  },
  /** Customer seat assignments and self check-ins per identity (PR-14). */
  checkInCustomerIdentity: {
    action: 'check-in-customer:identity',
    limit: 60,
    windowMs: HOUR,
  },
  /** STAFF counter operations: seat assignments and check-ins. */
  checkInOperationIdentity: {
    action: 'check-in-operation:identity',
    limit: 600,
    windowMs: 15 * MINUTE,
  },
  /** STAFF boarding scans: a full coach several times over, finite for abuse. */
  boardingScanIdentity: {
    action: 'boarding-scan:identity',
    limit: 1200,
    windowMs: 15 * MINUTE,
  },
} as const satisfies Record<string, RateLimitRule>;
