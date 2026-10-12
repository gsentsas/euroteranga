import type { Logger } from '@euroteranga/logger';
import { Inject, Injectable } from '@nestjs/common';
import { API_LOGGER } from '../../config/config.module.js';
import { AUTH_CONFIG, type AuthConfig, type Realm } from '../auth.config.js';
import { keyedDigest } from '../crypto/tokens.js';

export type SecurityEvent =
  | 'AUTH_LOGIN_SUCCESS'
  | 'AUTH_LOGIN_FAILURE'
  | 'AUTH_LOGOUT'
  | 'AUTH_PASSWORD_CHANGED'
  | 'AUTH_PASSWORD_RESET'
  | 'AUTH_PASSWORD_RESET_REQUESTED'
  | 'AUTH_REGISTRATION_REQUESTED'
  | 'AUTH_EMAIL_VERIFIED'
  | 'AUTH_EMAIL_VERIFICATION_FAILED'
  | 'AUTH_MFA_CHALLENGE_ISSUED'
  | 'AUTH_MFA_ENROLLED'
  | 'AUTH_MFA_SUCCESS'
  | 'AUTH_MFA_FAILURE'
  | 'AUTH_MFA_RECOVERY_CODE_USED'
  | 'AUTH_SESSION_REVOKED'
  | 'AUTH_RATE_LIMITED'
  | 'AUTH_MAIL_DELIVERY_FAILED';

export interface SecurityEventFields {
  realm?: Realm;
  /** Internal identity id (UUID), once the caller is identified. */
  identityId?: string;
  /** Raw identity hint (e.g. normalised email): logged only as a pseudonym. */
  subject?: string;
  /** Client address: logged only as a pseudonym. */
  ip?: string;
  reason?: string;
  [key: string]: unknown;
}

const FAILURE_EVENTS = new Set<SecurityEvent>([
  'AUTH_LOGIN_FAILURE',
  'AUTH_MFA_FAILURE',
  'AUTH_RATE_LIMITED',
  'AUTH_EMAIL_VERIFICATION_FAILED',
  'AUTH_MAIL_DELIVERY_FAILED',
]);

/**
 * Structured security events for authentication. Emails and IP addresses are
 * replaced by keyed pseudonyms (HMAC, AUTH_HMAC_KEY) that allow correlation
 * without revealing them; passwords, tokens, codes and cookies are never
 * passed here (and the logger redacts them as a second line of defence).
 */
@Injectable()
export class SecurityEventLogger {
  constructor(
    @Inject(API_LOGGER) private readonly logger: Logger,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
  ) {}

  pseudonym(kind: 'subject' | 'ip', value: string): string {
    return keyedDigest(this.config.hmacKey, ['log', kind, value]).toString('hex').slice(0, 24);
  }

  record(event: SecurityEvent, fields: SecurityEventFields = {}): void {
    const { subject, ip, ...rest } = fields;
    const entry = {
      security_event: event,
      ...rest,
      ...(subject !== undefined ? { subject_ref: this.pseudonym('subject', subject) } : {}),
      ...(ip !== undefined ? { ip_ref: this.pseudonym('ip', ip) } : {}),
    };
    if (FAILURE_EVENTS.has(event)) this.logger.warn('security event', entry);
    else this.logger.info('security event', entry);
  }
}
