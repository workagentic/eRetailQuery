import { randomBytes } from 'node:crypto';
import { EnvKeyProvider } from '@erq/shared';
import { describe, expect, it } from 'vitest';
import {
  credentialsAad,
  decryptConnectionCredentials,
  encryptConnectionCredentials,
} from '../src/credentials';
import { AuthError } from '../src/errors';

const provider = () => new EnvKeyProvider('k1', { k1: randomBytes(32).toString('base64') });
const CONN = '00000000-0000-4000-8000-0000000000c1';

describe('connection credentials', () => {
  it('round-trips JSON credentials', () => {
    const p = provider();
    const encrypted = encryptConnectionCredentials({ accessToken: 'shpat_secret' }, p, CONN);
    expect(encrypted).not.toContain('shpat_secret');
    expect(decryptConnectionCredentials(encrypted, p, CONN)).toEqual({
      accessToken: 'shpat_secret',
    });
  });
  it('returns null for connections without credentials (demo connections)', () => {
    expect(decryptConnectionCredentials(null, provider(), CONN)).toBeNull();
  });
  it('is bound to the connection id through the AAD', () => {
    const p = provider();
    const encrypted = encryptConnectionCredentials({ t: 1 }, p, CONN);
    expect(credentialsAad(CONN)).toBe(`connection:${CONN}`);
    expect(() =>
      decryptConnectionCredentials(encrypted, p, '00000000-0000-4000-8000-0000000000c2'),
    ).toThrow(AuthError);
  });
  it('throws AuthError without leaking secrets for garbage, wrong keys and non-JSON plaintext', () => {
    const p = provider();
    expect(() => decryptConnectionCredentials('garbage', p, CONN)).toThrow(AuthError);
    const other = encryptConnectionCredentials({ t: 'SECRETVALUE' }, provider(), CONN);
    try {
      decryptConnectionCredentials(other, p, CONN);
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain('SECRETVALUE');
    }
  });
});
