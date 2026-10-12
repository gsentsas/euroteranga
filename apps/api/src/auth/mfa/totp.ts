import { randomBytes } from 'node:crypto';
import { Secret, TOTP } from 'otpauth';

/** RFC 6238 parameters understood by every standard authenticator app. */
export const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;
/** Accept the previous and next 30 s step to absorb clock drift (±1 step). */
export const TOTP_WINDOW = 1;
const ISSUER = 'EURO TERANGA';

/** 160-bit secret from the CSPRNG (RFC 4226 recommends at least 128 bits). */
export function generateTotpSecret(): Buffer {
  return randomBytes(20);
}

function totp(secret: Buffer, label = 'account'): TOTP {
  return new TOTP({
    issuer: ISSUER,
    label,
    algorithm: 'SHA1',
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
    secret: new Secret({ buffer: Uint8Array.from(secret).buffer }),
  });
}

export function totpEnrollmentDetails(secret: Buffer, email: string) {
  const instance = totp(secret, email);
  return { otpauthUri: instance.toString(), secret: instance.secret.base32 };
}

/**
 * Returns the absolute time step matched by `code` (within ±1 step of `now`),
 * or null. Callers must then record the step atomically to prevent replay.
 */
export function matchTotpStep(secret: Buffer, code: string, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const delta = totp(secret).validate({ token: code, timestamp: now, window: TOTP_WINDOW });
  if (delta === null) return null;
  return Math.floor(now / 1000 / TOTP_PERIOD_SECONDS) + delta;
}

/** Test helper and enrollment check: the code for a given instant. */
export function generateTotpCode(secret: Buffer, now = Date.now()): string {
  return totp(secret).generate({ timestamp: now });
}
