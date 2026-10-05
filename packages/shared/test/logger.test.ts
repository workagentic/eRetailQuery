import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/logger';

function capture() {
  const lines: string[] = [];
  return { lines, destination: { write: (s: string) => void lines.push(s) } };
}

describe('createLogger', () => {
  it('redacts secrets at top level and nested', () => {
    const { lines, destination } = capture();
    const log = createLogger({ level: 'info', destination });
    log.info({ token: 'SECRET1', password: 'SECRET2' }, 'a');
    log.info({ conn: { access_token: 'SECRET3', encrypted_credentials: 'SECRET4' } }, 'b');
    log.info({ req: { headers: { authorization: 'Bearer SECRET5', cookie: 'SECRET6' } } }, 'c');
    const out = lines.join('');
    for (const s of ['SECRET1', 'SECRET2', 'SECRET3', 'SECRET4', 'SECRET5', 'SECRET6']) {
      expect(out).not.toContain(s);
    }
    expect(out).toContain('[REDACTED]');
  });
  it('redacts secrets two levels deep and the extended key set', () => {
    const { lines, destination } = capture();
    const log = createLogger({ destination });
    log.info({ conn: { auth: { accessToken: 'SECRETX' } } }, 'deep');
    log.info({ refreshToken: 'SECRETY', idToken: 'SECRETZ', clientSecret: 'SECRETW' }, 'flat');
    const out = lines.join('');
    for (const s of ['SECRETX', 'SECRETY', 'SECRETZ', 'SECRETW']) expect(out).not.toContain(s);
  });
  it('keeps non-secret fields', () => {
    const { lines, destination } = capture();
    createLogger({ destination }).info({ orgId: 'abc' }, 'hello');
    expect(lines.join('')).toContain('abc');
  });
});
