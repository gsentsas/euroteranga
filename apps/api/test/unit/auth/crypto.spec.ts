import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ARGON2_PARAMETERS,
  hashPassword,
  normalizePassword,
  verifyAgainstDummyHash,
  verifyPassword,
} from '../../../src/auth/crypto/password-hasher.js';
import {
  constantTimeEqual,
  hashOpaqueToken,
  isWellFormedOpaqueToken,
  keyedDigest,
  secureRandomToken,
} from '../../../src/auth/crypto/tokens.js';
import { TotpSecretCipher } from '../../../src/auth/crypto/totp-cipher.js';

const PASSPHRASE = 'synthetic unit test passphrase 21';

describe('password hashing (Argon2id)', () => {
  it('produces a PHC string with the configured Argon2id parameters', async () => {
    const hash = await hashPassword(PASSPHRASE);
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/);
    expect(hash).not.toContain(PASSPHRASE);
    expect(ARGON2_PARAMETERS.memoryCost).toBeGreaterThanOrEqual(19456);
    expect(ARGON2_PARAMETERS.timeCost).toBeGreaterThanOrEqual(2);
  });

  it('salts every hash differently', async () => {
    expect(await hashPassword(PASSPHRASE)).not.toBe(await hashPassword(PASSPHRASE));
  });

  it('verifies the right password and rejects others', async () => {
    const hash = await hashPassword(PASSPHRASE);
    await expect(verifyPassword(hash, PASSPHRASE)).resolves.toBe(true);
    await expect(verifyPassword(hash, `${PASSPHRASE}!`)).resolves.toBe(false);
  });

  it('treats NFKC-equivalent input as the same password', async () => {
    const composed = 'mot de passe très très long é';
    const decomposed = composed.normalize('NFD');
    expect(decomposed).not.toBe(composed);
    const hash = await hashPassword(composed);
    await expect(verifyPassword(hash, decomposed)).resolves.toBe(true);
    expect(normalizePassword(decomposed)).toBe(normalizePassword(composed));
  });

  it('never throws on a corrupted stored hash', async () => {
    await expect(verifyPassword('not-a-phc-string', PASSPHRASE)).resolves.toBe(false);
  });

  it('runs a full verification for unknown accounts and always fails', async () => {
    await verifyAgainstDummyHash('warm up');
    const started = performance.now();
    await expect(verifyAgainstDummyHash(PASSPHRASE)).resolves.toBe(false);
    // A real Argon2 verification with 64 MiB / t=3 cannot be instantaneous.
    expect(performance.now() - started).toBeGreaterThan(5);
  });
});

describe('opaque tokens', () => {
  it('generates 256-bit base64url tokens from the CSPRNG', () => {
    const tokens = new Set(Array.from({ length: 50 }, secureRandomToken));
    expect(tokens.size).toBe(50);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    }
  });

  it('validates the token shape before any lookup', () => {
    expect(isWellFormedOpaqueToken(secureRandomToken())).toBe(true);
    for (const bad of [undefined, '', 'short', 'A'.repeat(44), `${'A'.repeat(42)}=`, 42]) {
      expect(isWellFormedOpaqueToken(bad)).toBe(false);
    }
  });

  it('stores SHA-256 digests of tokens', () => {
    const token = secureRandomToken();
    expect(Buffer.from(hashOpaqueToken(token))).toEqual(
      createHash('sha256').update(token).digest(),
    );
  });

  it('keys digests and separates parts unambiguously', () => {
    const key = randomBytes(32);
    expect(keyedDigest(key, ['ab', 'c'])).not.toEqual(keyedDigest(key, ['a', 'bc']));
    expect(keyedDigest(key, ['x'])).not.toEqual(keyedDigest(randomBytes(32), ['x']));
    expect(keyedDigest(key, ['x'])).toHaveLength(32);
  });

  it('compares secrets in constant time and never matches different lengths', () => {
    const a = randomBytes(32);
    expect(constantTimeEqual(a, Buffer.from(a))).toBe(true);
    expect(constantTimeEqual(a, randomBytes(32))).toBe(false);
    expect(constantTimeEqual(a, a.subarray(0, 31))).toBe(false);
  });
});

describe('TOTP secret encryption (AES-256-GCM)', () => {
  const identityId = '0190a0a0-0000-7000-8000-000000000001';

  it('round-trips and uses a fresh 96-bit nonce each time', () => {
    const cipher = new TotpSecretCipher(randomBytes(32), 1);
    const secret = randomBytes(20);
    const first = cipher.encrypt(secret, identityId);
    const second = cipher.encrypt(secret, identityId);
    expect(first.nonce).toHaveLength(12);
    expect(Buffer.from(first.nonce)).not.toEqual(Buffer.from(second.nonce));
    expect(Buffer.from(first.ciphertext).includes(secret)).toBe(false);
    expect(cipher.decrypt(first, identityId)).toEqual(secret);
  });

  it('refuses tampered ciphertext, another identity, another key or key version', () => {
    const key = randomBytes(32);
    const cipher = new TotpSecretCipher(key, 1);
    const encrypted = cipher.encrypt(randomBytes(20), identityId);

    const tampered = { ...encrypted, ciphertext: Uint8Array.from(encrypted.ciphertext) };
    tampered.ciphertext[0] = (tampered.ciphertext[0] ?? 0) ^ 0xff;
    expect(() => cipher.decrypt(tampered, identityId)).toThrow();
    expect(() => cipher.decrypt(encrypted, '0190a0a0-0000-7000-8000-000000000002')).toThrow();
    expect(() => new TotpSecretCipher(randomBytes(32), 1).decrypt(encrypted, identityId)).toThrow();
    expect(() => new TotpSecretCipher(key, 2).decrypt(encrypted, identityId)).toThrow(
      /key version/,
    );
  });

  it('requires a 32-byte key', () => {
    expect(() => new TotpSecretCipher(randomBytes(16), 1)).toThrow();
  });
});
