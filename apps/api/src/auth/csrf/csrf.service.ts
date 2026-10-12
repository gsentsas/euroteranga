import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AUTH_CONFIG, type AuthConfig } from '../auth.config.js';
import { constantTimeEqual, keyedDigest } from '../crypto/tokens.js';

const VERSION = 'v1';

export interface IssuedCsrfToken {
  csrfToken: string;
  expiresAt: Date;
}

/**
 * Stateless, session-bound CSRF tokens (signed double-submit variant):
 *
 *   token = "v1.<expiresAtSeconds>.<nonce>.<mac>"
 *   mac   = HMAC-SHA256(AUTH_CSRF_KEY, "csrf" | "v1" | sessionId | expiresAt | nonce)
 *
 * The client keeps the token in memory and sends it in X-CSRF-Token. It is
 * valid only for the session it was issued for (the session id comes from the
 * HttpOnly cookie, never from the client), only until expiry, and cannot be
 * forged without the key. Verification compares MACs in constant time.
 */
@Injectable()
export class CsrfService {
  constructor(@Inject(AUTH_CONFIG) private readonly config: AuthConfig) {}

  issue(sessionId: string, now = Date.now()): IssuedCsrfToken {
    const expiresAtSeconds = Math.floor((now + this.config.csrfTokenTtlMs) / 1000);
    const nonce = randomBytes(16).toString('base64url');
    const mac = this.mac(sessionId, expiresAtSeconds, nonce).toString('base64url');
    return {
      csrfToken: [VERSION, expiresAtSeconds, nonce, mac].join('.'),
      expiresAt: new Date(expiresAtSeconds * 1000),
    };
  }

  verify(sessionId: string, token: unknown, now = Date.now()): boolean {
    if (typeof token !== 'string' || token.length > 200) return false;
    const [version, expires, nonce, mac, ...rest] = token.split('.');
    if (version !== VERSION || !expires || !nonce || !mac || rest.length > 0) return false;
    if (!/^\d{1,12}$/.test(expires) || Number(expires) * 1000 <= now) return false;

    const expected = this.mac(sessionId, Number(expires), nonce);
    return constantTimeEqual(Buffer.from(mac, 'base64url'), expected);
  }

  private mac(sessionId: string, expiresAtSeconds: number, nonce: string): Buffer {
    return keyedDigest(this.config.csrfKey, [
      'csrf',
      VERSION,
      sessionId,
      String(expiresAtSeconds),
      nonce,
    ]);
  }
}
