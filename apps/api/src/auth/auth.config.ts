import { decodeSecretKey, type ApiEnv } from '@euroteranga/config';
import { AuthRealm } from '@euroteranga/database';

/** Realm as it appears in URLs (`/v1/auth/:realm/...`). */
export type Realm = 'customer' | 'staff' | 'crew';
export const REALMS: readonly Realm[] = ['customer', 'staff', 'crew'];

export function isRealm(value: unknown): value is Realm {
  return typeof value === 'string' && (REALMS as readonly string[]).includes(value);
}

const DB_REALMS: Record<Realm, AuthRealm> = {
  customer: AuthRealm.CUSTOMER,
  staff: AuthRealm.STAFF,
  crew: AuthRealm.CREW,
};

export function toDbRealm(realm: Realm): AuthRealm {
  return DB_REALMS[realm];
}

export interface RealmSettings {
  /** Exact browser origins allowed to use this realm. */
  origins: readonly string[];
  sessionAbsoluteMs: number;
  sessionIdleMs: number;
  /** A password alone never yields a session in an MFA realm. */
  mfaRequired: boolean;
  sessionCookieName: string;
}

export interface AuthConfig {
  /** Secure, `__Host-` prefixed cookies (staging/production only). */
  secureCookies: boolean;
  realms: Record<Realm, RealmSettings>;
  staffChallengeCookieName: string;
  emailVerificationTtlMs: number;
  passwordResetTtlMs: number;
  mfaChallengeTtlMs: number;
  mfaChallengeMaxAttempts: number;
  csrfTokenTtlMs: number;
  /** lastSeenAt / idle expiry are refreshed at most this often per session. */
  sessionTouchIntervalMs: number;
  csrfKey: Buffer;
  hmacKey: Buffer;
  totpKey: Buffer;
  totpKeyVersion: number;
  clientPublicUrl: string;
  opsPublicUrl: string;
  staffInvitationTtlMs: number;
  staffEnrollmentGrantTtlMs: number;
  /** Exact origins accepted by CORS (all realms plus API_CORS_ORIGINS). */
  corsOrigins: readonly string[];
}

export const AUTH_CONFIG = Symbol('AUTH_CONFIG');

const SECOND = 1000;

/**
 * Single place where authentication settings are derived from the validated
 * environment. Cookie flags depend only on APP_ENV: they cannot be weakened
 * for production by another variable.
 */
export function buildAuthConfig(env: ApiEnv): AuthConfig {
  const secureCookies = env.APP_ENV === 'staging' || env.APP_ENV === 'production';
  const cookieName = (name: string) => (secureCookies ? `__Host-et_${name}` : `et_${name}`);

  const realm = (
    name: Realm,
    origins: string[],
    absoluteSeconds: number,
    idleSeconds: number,
  ): RealmSettings => ({
    origins,
    sessionAbsoluteMs: absoluteSeconds * SECOND,
    sessionIdleMs: idleSeconds * SECOND,
    mfaRequired: name === 'staff',
    sessionCookieName: cookieName(`${name}_session`),
  });

  const realms: Record<Realm, RealmSettings> = {
    customer: realm(
      'customer',
      env.AUTH_CUSTOMER_ORIGINS,
      env.AUTH_CUSTOMER_SESSION_ABSOLUTE_SECONDS,
      env.AUTH_CUSTOMER_SESSION_IDLE_SECONDS,
    ),
    staff: realm(
      'staff',
      env.AUTH_STAFF_ORIGINS,
      env.AUTH_STAFF_SESSION_ABSOLUTE_SECONDS,
      env.AUTH_STAFF_SESSION_IDLE_SECONDS,
    ),
    crew: realm(
      'crew',
      env.AUTH_CREW_ORIGINS,
      env.AUTH_CREW_SESSION_ABSOLUTE_SECONDS,
      env.AUTH_CREW_SESSION_IDLE_SECONDS,
    ),
  };

  return {
    secureCookies,
    realms,
    staffChallengeCookieName: cookieName('staff_mfa'),
    emailVerificationTtlMs: env.AUTH_EMAIL_VERIFICATION_TTL_SECONDS * SECOND,
    passwordResetTtlMs: env.AUTH_PASSWORD_RESET_TTL_SECONDS * SECOND,
    mfaChallengeTtlMs: env.AUTH_MFA_CHALLENGE_TTL_SECONDS * SECOND,
    mfaChallengeMaxAttempts: 5,
    csrfTokenTtlMs: 2 * 3600 * SECOND,
    sessionTouchIntervalMs: 5 * 60 * SECOND,
    csrfKey: decodeSecretKey(env.AUTH_CSRF_KEY),
    hmacKey: decodeSecretKey(env.AUTH_HMAC_KEY),
    totpKey: decodeSecretKey(env.AUTH_TOTP_ENCRYPTION_KEY),
    totpKeyVersion: env.AUTH_TOTP_ENCRYPTION_KEY_VERSION,
    clientPublicUrl: env.CLIENT_PUBLIC_URL.replace(/\/+$/, ''),
    opsPublicUrl: env.OPS_PUBLIC_URL.replace(/\/+$/, ''),
    staffInvitationTtlMs: env.AUTH_STAFF_INVITATION_TTL_SECONDS * SECOND,
    staffEnrollmentGrantTtlMs: env.AUTH_STAFF_ENROLLMENT_GRANT_TTL_SECONDS * SECOND,
    corsOrigins: [
      ...new Set([
        ...env.API_CORS_ORIGINS,
        ...env.AUTH_CUSTOMER_ORIGINS,
        ...env.AUTH_STAFF_ORIGINS,
        ...env.AUTH_CREW_ORIGINS,
      ]),
    ],
  };
}
