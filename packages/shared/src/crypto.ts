import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface KeyProvider {
  current(): { keyId: string; key: Buffer };
  get(keyId: string): Buffer;
}

const KEY_ID_RE = /^[A-Za-z0-9_-]+$/;

export class EnvKeyProvider implements KeyProvider {
  private readonly keys = new Map<string, Buffer>();

  constructor(
    private readonly currentId: string,
    keys: Record<string, string>,
  ) {
    for (const [id, b64] of Object.entries(keys)) {
      if (!KEY_ID_RE.test(id))
        throw new Error(`invalid key id "${id}": use letters, digits, - or _`);
      const key = Buffer.from(b64, 'base64');
      if (key.length !== 32) throw new Error(`encryption key "${id}" must be 32 bytes (base64)`);
      this.keys.set(id, key);
    }
    if (!this.keys.has(currentId))
      throw new Error(`current encryption key "${currentId}" not provided`);
  }

  static fromEnv(env: Record<string, string | undefined>): EnvKeyProvider {
    const id = env.ENCRYPTION_KEY_ID;
    const key = env.ENCRYPTION_KEY;
    if (!id || !key) throw new Error('ENCRYPTION_KEY_ID and ENCRYPTION_KEY are required');
    let retired: Record<string, string> = {};
    if (env.ENCRYPTION_OLD_KEYS) {
      try {
        retired = JSON.parse(env.ENCRYPTION_OLD_KEYS) as Record<string, string>;
      } catch {
        // Deliberately drop the cause: a parse error can echo key material.
        throw new Error('ENCRYPTION_OLD_KEYS must be a JSON object of keyId to base64 key');
      }
    }
    return new EnvKeyProvider(id, { ...retired, [id]: key });
  }

  current(): { keyId: string; key: Buffer } {
    return { keyId: this.currentId, key: this.get(this.currentId) };
  }

  get(keyId: string): Buffer {
    const key = this.keys.get(keyId);
    if (!key) throw new Error(`unknown encryption key id: ${keyId}`);
    return key;
  }
}

/** Format: v1.<keyId>.<iv>.<tag>.<ciphertext> (base64url parts). AES-256-GCM. */
export function encrypt(plaintext: string, provider: KeyProvider, aad?: string): string {
  const { keyId, key } = provider.current();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  if (aad !== undefined) cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', keyId, iv, tag, ciphertext]
    .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
    .join('.');
}

export function decrypt(payload: string, provider: KeyProvider, aad?: string): string {
  const parts = payload.split('.');
  if (parts.length !== 5 || parts[0] !== 'v1') throw new Error('malformed ciphertext');
  const [, keyId = '', iv = '', tag = '', ciphertext = ''] = parts;
  const key = provider.get(keyId);
  const ivBuf = Buffer.from(iv, 'base64url');
  const tagBuf = Buffer.from(tag, 'base64url');
  if (ivBuf.length !== 12 || tagBuf.length !== 16) throw new Error('malformed ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', key, ivBuf, {
    authTagLength: 16,
  });
  if (aad !== undefined) decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tagBuf);
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
