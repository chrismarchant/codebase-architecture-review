import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM sealing for per-request retrieval tokens (SS00 §5.2).
 * Layout: 12-byte IV || ciphertext || 16-byte tag. The KEK is RETRIEVAL_KEK
 * (base64, 32 bytes).
 */
const IV_BYTES = 12;
const TAG_BYTES = 16;

function keyFrom(kekB64: string): Buffer {
  const key = Buffer.from(kekB64, 'base64');
  if (key.length !== 32) throw new Error('RETRIEVAL_KEK must be 32 bytes, base64 encoded');
  return key;
}

export function sealSecret(kekB64: string, plaintext: string | Uint8Array): Uint8Array {
  const key = keyFrom(kekB64);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  const data = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : Buffer.from(plaintext);
  const ct = Buffer.concat([cipher.update(data), cipher.final()]);
  return new Uint8Array(Buffer.concat([iv, ct, cipher.getAuthTag()]));
}

/** Throws a generic error on a wrong key or any tampering (details are not exposed). */
export function openSecretBytes(kekB64: string, sealed: Uint8Array): Uint8Array {
  const key = keyFrom(kekB64);
  if (sealed.length < IV_BYTES + TAG_BYTES) throw new Error('sealed secret is malformed');
  const buf = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength);
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(buf.length - TAG_BYTES);
  const ct = buf.subarray(IV_BYTES, buf.length - TAG_BYTES);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    decipher.setAuthTag(tag);
    return new Uint8Array(Buffer.concat([decipher.update(ct), decipher.final()]));
  } catch {
    throw new Error('secret could not be opened');
  }
}

/** UTF-8 convenience wrapper over openSecretBytes. */
export function openSecret(kekB64: string, sealed: Uint8Array): string {
  return Buffer.from(openSecretBytes(kekB64, sealed)).toString('utf8');
}
