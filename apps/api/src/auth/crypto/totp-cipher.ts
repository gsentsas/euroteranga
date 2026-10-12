import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface EncryptedTotpSecret {
  /** Ciphertext followed by the GCM authentication tag. */
  ciphertext: Uint8Array<ArrayBuffer>;
  nonce: Uint8Array<ArrayBuffer>;
  keyVersion: number;
}

/**
 * TOTP secrets must be recoverable to verify codes, so they are encrypted
 * (not hashed) with AES-256-GCM. The identity id is bound as additional
 * authenticated data: a ciphertext copied onto another identity fails to
 * decrypt. The key lives outside the database (AUTH_TOTP_ENCRYPTION_KEY).
 */
export class TotpSecretCipher {
  constructor(
    private readonly key: Buffer,
    private readonly keyVersion: number,
  ) {
    if (key.length !== 32) throw new Error('TOTP encryption key must be 32 bytes');
  }

  encrypt(secret: Buffer, identityId: string): EncryptedTotpSecret {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(identityId, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(secret), cipher.final(), cipher.getAuthTag()]);
    return {
      ciphertext: new Uint8Array(ciphertext),
      nonce: new Uint8Array(nonce),
      keyVersion: this.keyVersion,
    };
  }

  decrypt(encrypted: EncryptedTotpSecret, identityId: string): Buffer {
    if (encrypted.keyVersion !== this.keyVersion) {
      // Key rotation is not implemented yet (documented limitation).
      throw new Error(`Unsupported TOTP key version ${encrypted.keyVersion}`);
    }
    const ciphertext = Buffer.from(encrypted.ciphertext);
    const body = ciphertext.subarray(0, ciphertext.length - TAG_BYTES);
    const tag = ciphertext.subarray(ciphertext.length - TAG_BYTES);
    const decipher = createDecipheriv(ALGORITHM, this.key, encrypted.nonce, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(Buffer.from(identityId, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  }
}
