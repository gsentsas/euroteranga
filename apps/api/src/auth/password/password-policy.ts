import { normalizePassword } from '../crypto/password-hasher.js';
import { COMMON_LONG_PASSWORDS, KEYBOARD_SEQUENCES, SERVICE_TERMS } from './blocklist.js';

export const PASSWORD_MIN_LENGTH = 15;
export const PASSWORD_MAX_LENGTH = 256;

export type PasswordPolicyReason =
  | 'TOO_SHORT'
  | 'TOO_LONG'
  | 'TOO_COMMON'
  | 'TOO_REPETITIVE'
  | 'CONTAINS_SERVICE_NAME'
  | 'CONTAINS_EMAIL';

export type PasswordPolicyResult =
  { ok: true } | { ok: false; reason: PasswordPolicyReason; message: string };

const MESSAGES: Record<PasswordPolicyReason, string> = {
  TOO_SHORT: `Le mot de passe doit contenir au moins ${PASSWORD_MIN_LENGTH} caractères. Une phrase de passe de plusieurs mots est idéale.`,
  TOO_LONG: `Le mot de passe ne doit pas dépasser ${PASSWORD_MAX_LENGTH} caractères.`,
  TOO_COMMON:
    'Ce mot de passe est trop courant. Choisissez une phrase de passe plus longue et unique.',
  TOO_REPETITIVE: 'Ce mot de passe est trop répétitif. Choisissez une phrase de passe plus variée.',
  CONTAINS_SERVICE_NAME: 'Le mot de passe ne doit pas contenir le nom du service.',
  CONTAINS_EMAIL: 'Le mot de passe ne doit pas contenir votre adresse e-mail.',
};

const reject = (reason: PasswordPolicyReason): PasswordPolicyResult => ({
  ok: false,
  reason,
  message: MESSAGES[reason],
});

/**
 * Length-based policy (NIST SP 800-63B / OWASP): at least 15 characters, long
 * passphrases, spaces and any Unicode allowed, no composition rules, no
 * periodic rotation. Known-weak passwords are refused locally; nothing is
 * sent to an external service.
 */
export function checkPasswordPolicy(
  password: string,
  context: { email?: string } = {},
): PasswordPolicyResult {
  const normalized = normalizePassword(password);
  const length = [...normalized].length; // code points, not UTF-16 units

  if (length < PASSWORD_MIN_LENGTH) return reject('TOO_SHORT');
  if (length > PASSWORD_MAX_LENGTH) return reject('TOO_LONG');

  // Compare without case, spaces and common separators.
  const compact = normalized.toLowerCase().replace(/[\s._\-+*/\\|,;:!?'"`~]+/g, '');

  if (SERVICE_TERMS.some((term) => compact.includes(term))) return reject('CONTAINS_SERVICE_NAME');

  if (context.email) {
    const email = context.email.trim().toLowerCase();
    const localPart = email.split('@')[0] ?? '';
    if (
      compact.includes(email.replace(/[\s.]+/g, '')) ||
      (localPart.length >= 4 && compact.includes(localPart.replace(/[.]+/g, '')))
    ) {
      return reject('CONTAINS_EMAIL');
    }
  }

  if (new Set(compact).size < 5 || /^(.{1,6})\1+.{0,3}$/.test(compact)) {
    return reject('TOO_REPETITIVE');
  }

  if (
    COMMON_LONG_PASSWORDS.has(compact) ||
    KEYBOARD_SEQUENCES.some((sequence) => sequence.includes(compact))
  ) {
    return reject('TOO_COMMON');
  }

  return { ok: true };
}
