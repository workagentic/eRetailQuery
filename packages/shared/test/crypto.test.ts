import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decrypt, encrypt, EnvKeyProvider } from '../src/crypto';

const b64 = () => randomBytes(32).toString('base64');
const provider = () => new EnvKeyProvider('k1', { k1: b64() });

describe('encrypt/decrypt', () => {
  it('round-trips, including empty and unicode strings', () => {
    const p = provider();
    for (const text of ['', 'shpat_abc123', 'ünïcödé 🚀 {"a":1}']) {
      expect(decrypt(encrypt(text, p), p)).toBe(text);
    }
  });
  it('produces different ciphertext each time (random IV)', () => {
    const p = provider();
    expect(encrypt('same', p)).not.toBe(encrypt('same', p));
  });
  it('embeds the key id and version', () => {
    expect(encrypt('x', provider()).startsWith('v1.k1.')).toBe(true);
  });
  it('detects tampering', () => {
    const p = provider();
    const parts = encrypt('secret', p).split('.');
    parts[4] = Buffer.from('tampered').toString('base64url');
    expect(() => decrypt(parts.join('.'), p)).toThrow();
  });
  it('fails with the wrong key', () => {
    const payload = encrypt('secret', provider());
    expect(() => decrypt(payload, provider())).toThrow();
  });
  it('binds ciphertext to AAD', () => {
    const p = provider();
    const payload = encrypt('secret', p, 'org-1');
    expect(decrypt(payload, p, 'org-1')).toBe('secret');
    expect(() => decrypt(payload, p, 'org-2')).toThrow();
  });
  it('decrypts old ciphertext after key rotation', () => {
    const oldKey = b64();
    const before = new EnvKeyProvider('k1', { k1: oldKey });
    const payload = encrypt('secret', before);
    const after = new EnvKeyProvider('k2', { k1: oldKey, k2: b64() });
    expect(decrypt(payload, after)).toBe('secret');
    expect(encrypt('new', after).startsWith('v1.k2.')).toBe(true);
  });
  it('rejects malformed payloads and unknown key ids', () => {
    const p = provider();
    expect(() => decrypt('garbage', p)).toThrow(/malformed/);
    expect(() => decrypt('v1.nokey.a.b.c', p)).toThrow(/unknown encryption key/);
  });
});

describe('decrypt hardening', () => {
  it('rejects a tag truncated to 4 bytes', () => {
    const p = provider();
    const parts = encrypt('secret', p).split('.');
    parts[3] = Buffer.from(parts[3]!, 'base64url').subarray(0, 4).toString('base64url');
    expect(() => decrypt(parts.join('.'), p)).toThrow(/malformed/);
  });
  it('rejects a tampered tag', () => {
    const p = provider();
    const parts = encrypt('secret', p).split('.');
    const tag = Buffer.from(parts[3]!, 'base64url');
    tag[0] = tag[0]! ^ 0xff;
    parts[3] = tag.toString('base64url');
    expect(() => decrypt(parts.join('.'), p)).toThrow();
  });
  it('rejects a tampered iv, and an iv of the wrong length', () => {
    const p = provider();
    const parts = encrypt('secret', p).split('.');
    const iv = Buffer.from(parts[2]!, 'base64url');
    iv[0] = iv[0]! ^ 0xff;
    expect(() =>
      decrypt([...parts.slice(0, 2), iv.toString('base64url'), ...parts.slice(3)].join('.'), p),
    ).toThrow();
    const short = Buffer.alloc(8).toString('base64url');
    expect(() => decrypt([...parts.slice(0, 2), short, ...parts.slice(3)].join('.'), p)).toThrow(
      /malformed/,
    );
  });
  it('rejects a swapped key id that points at another valid key', () => {
    const p = new EnvKeyProvider('k1', { k1: b64(), k2: b64() });
    const parts = encrypt('secret', p).split('.');
    parts[1] = 'k2';
    expect(() => decrypt(parts.join('.'), p)).toThrow();
  });
});

describe('EnvKeyProvider', () => {
  it('rejects keys that are not 32 bytes', () => {
    expect(() => new EnvKeyProvider('k', { k: Buffer.alloc(16).toString('base64') })).toThrow(
      /32 bytes/,
    );
  });
  it('rejects key ids containing dots', () => {
    expect(() => new EnvKeyProvider('a.b', { 'a.b': b64() })).toThrow(/key id/);
  });
  it('requires the current id to exist', () => {
    expect(() => new EnvKeyProvider('missing', { k: b64() })).toThrow();
  });
  it('builds from env including retired keys', () => {
    const old = b64();
    const p = EnvKeyProvider.fromEnv({
      ENCRYPTION_KEY_ID: 'k2',
      ENCRYPTION_KEY: b64(),
      ENCRYPTION_OLD_KEYS: JSON.stringify({ k1: old }),
    });
    expect(p.get('k1').length).toBe(32);
    expect(p.current().keyId).toBe('k2');
  });
  it('rejects invalid ENCRYPTION_OLD_KEYS without echoing the input', () => {
    let message = '';
    try {
      EnvKeyProvider.fromEnv({
        ENCRYPTION_KEY_ID: 'k2',
        ENCRYPTION_KEY: b64(),
        ENCRYPTION_OLD_KEYS: '{SECRETKEYMATERIAL',
      });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toBe('ENCRYPTION_OLD_KEYS must be a JSON object of keyId to base64 key');
    expect(message).not.toContain('SECRETKEYMATERIAL');
  });
  it('throws a clear error when env is missing', () => {
    expect(() => EnvKeyProvider.fromEnv({})).toThrow(/ENCRYPTION_KEY/);
  });
});
