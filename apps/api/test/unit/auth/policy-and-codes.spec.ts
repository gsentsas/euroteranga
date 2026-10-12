import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { normalizeEmail } from '../../../src/auth/identity/email.js';
import { hashRecoveryCode, normalizeRecoveryCode } from '../../../src/auth/mfa/recovery-codes.js';
import {
  generateTotpCode,
  matchTotpStep,
  TOTP_PERIOD_SECONDS,
} from '../../../src/auth/mfa/totp.js';
import { checkPasswordPolicy } from '../../../src/auth/password/password-policy.js';

describe('password policy', () => {
  it.each([
    'correct horse battery staple again',
    'Ma phrase de passe préférée 2026',
    'ünïcödé pässwörd wïth späcés',
    '這是一個很長的密碼短語用於測試目的',
    'Tr0ub4dor&3-plus-a-few-more',
  ])('accepts the passphrase %j without composition rules', (password) => {
    expect(checkPasswordPolicy(password)).toEqual({ ok: true });
  });

  it('requires 15 characters, counted as Unicode code points', () => {
    expect(checkPasswordPolicy('fourteen chars')).toMatchObject({ ok: false, reason: 'TOO_SHORT' });
    // 5 emoji + 10 letters = 15 code points, although it is 20 UTF-16 units.
    const mixed = '🚌🌍🧭🌅🛣abcdefghij';
    expect([...mixed]).toHaveLength(15);
    expect(checkPasswordPolicy(mixed)).toEqual({ ok: true });
    // 14 code points stay too short even when the UTF-16 length is larger.
    expect(checkPasswordPolicy('🚌🌍🧭🌅abcdefghij')).toMatchObject({ reason: 'TOO_SHORT' });
  });

  it('allows at least 128 characters and caps at 256', () => {
    const long = Array.from({ length: 64 }, (_, i) => `w${i}`).join(' ');
    expect(long.length).toBeGreaterThanOrEqual(128);
    expect(checkPasswordPolicy(long)).toEqual({ ok: true });
    expect(checkPasswordPolicy(`${long} `.repeat(3))).toMatchObject({ reason: 'TOO_LONG' });
  });

  it.each([
    'passwordpassword',
    'Password Password',
    'motdepasse123456',
    'correcthorsebatterystaple',
  ])('refuses the common password %j', (password) => {
    expect(checkPasswordPolicy(password)).toMatchObject({ ok: false, reason: 'TOO_COMMON' });
  });

  it.each(['1234567890123456', 'qwertyuiopasdfgh', 'azertyuiopqsdfgh', 'zyxwvutsrqponmlk'])(
    'refuses the keyboard or alphabet run %j',
    (password) => {
      expect(checkPasswordPolicy(password)).toMatchObject({ ok: false, reason: 'TOO_COMMON' });
    },
  );

  it.each(['aaaaaaaaaaaaaaaa', 'abababababababab', 'abcabcabcabcabcabc', '1111 2222 1111 2222'])(
    'refuses the repetitive password %j',
    (password) => {
      expect(checkPasswordPolicy(password)).toMatchObject({ ok: false, reason: 'TOO_REPETITIVE' });
    },
  );

  it('refuses the service name and the user email', () => {
    expect(checkPasswordPolicy('My EuroTeranga account 2026')).toMatchObject({
      reason: 'CONTAINS_SERVICE_NAME',
    });
    expect(checkPasswordPolicy('euro-teranga voyage dakar')).toMatchObject({
      reason: 'CONTAINS_SERVICE_NAME',
    });
    expect(
      checkPasswordPolicy('awa.diop and some words', { email: 'awa.diop@example.test' }),
    ).toMatchObject({
      reason: 'CONTAINS_EMAIL',
    });
  });

  it('gives an actionable French message', () => {
    const result = checkPasswordPolicy('passwordpassword');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe(
        'Ce mot de passe est trop courant. Choisissez une phrase de passe plus longue et unique.',
      );
    }
  });
});

describe('email normalisation', () => {
  it('trims, applies NFC and lowercases', () => {
    expect(normalizeEmail('  Awa.Diop@Example.TEST ')).toBe('awa.diop@example.test');
    expect(normalizeEmail('élodie@example.test')).toBe('élodie@example.test');
  });

  it('does not apply provider-specific rewriting', () => {
    expect(normalizeEmail('first.last+tag@gmail.com')).toBe('first.last+tag@gmail.com');
    expect(normalizeEmail('firstlast@gmail.com')).not.toBe(normalizeEmail('first.last@gmail.com'));
  });
});

describe('TOTP verification', () => {
  const secret = randomBytes(20);
  const now = 1_800_000_000_000;
  const step = Math.floor(now / 1000 / TOTP_PERIOD_SECONDS);

  it('matches the current step and ±1 step only', () => {
    expect(matchTotpStep(secret, generateTotpCode(secret, now), now)).toBe(step);
    expect(matchTotpStep(secret, generateTotpCode(secret, now - 30_000), now)).toBe(step - 1);
    expect(matchTotpStep(secret, generateTotpCode(secret, now + 30_000), now)).toBe(step + 1);
    expect(matchTotpStep(secret, generateTotpCode(secret, now + 90_000), now)).toBeNull();
    expect(matchTotpStep(secret, generateTotpCode(secret, now - 90_000), now)).toBeNull();
  });

  it('rejects malformed codes and codes of another secret', () => {
    expect(matchTotpStep(secret, '12345', now)).toBeNull();
    expect(matchTotpStep(secret, 'abcdef', now)).toBeNull();
    expect(matchTotpStep(randomBytes(20), generateTotpCode(secret, now), now)).toBeNull();
  });
});

describe('recovery codes', () => {
  it('normalises case and separators before hashing', () => {
    expect(normalizeRecoveryCode('abcd-efgh 2345-6723')).toBe('ABCDEFGH23456723');
    expect(Buffer.from(hashRecoveryCode('abcd-efgh-2345-6723'))).toEqual(
      Buffer.from(hashRecoveryCode('ABCDEFGH23456723')),
    );
    expect(hashRecoveryCode('ABCDEFGH23456723')).toHaveLength(32);
  });
});
