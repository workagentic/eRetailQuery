import { randomBytes } from 'node:crypto';
import {
  AuthError,
  PermanentError,
  SHOPIFY_RECONNECT_MESSAGE,
  TransientError,
  decryptConnectionCredentials,
  encryptConnectionCredentials,
  type ShopifyRefreshGrant,
} from '@erq/connectors';
import { EnvKeyProvider } from '@erq/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { REFRESH_WINDOW_MS, createTokenService, type RefreshFn } from '../src/tokens';
import { CONN_A, ORG_A, ORG_B, startEnv, type TestEnv } from './helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await startEnv();
});
afterAll(async () => {
  await env?.stop();
});

const NOW = new Date('2026-10-08T12:00:00.000Z');
const DAY = 86_400_000;
const keyProvider = new EnvKeyProvider('k1', { k1: randomBytes(32).toString('base64') });

async function seed(opts: { accessInMs: number; refreshInMs?: number; refreshToken?: string }) {
  const creds = {
    accessToken: 'shpat_seed',
    accessTokenExpiresAt: new Date(NOW.getTime() + opts.accessInMs).toISOString(),
    refreshToken: opts.refreshToken ?? 'shprt_seed',
    refreshTokenExpiresAt: new Date(NOW.getTime() + (opts.refreshInMs ?? 80 * DAY)).toISOString(),
  };
  await env.owner.query(
    `update store_connections set encrypted_credentials = $2, access_token_expires_at = $3,
       refresh_token_expires_at = $4, status = 'active', last_error = null where id = $1`,
    [
      CONN_A,
      encryptConnectionCredentials(creds, keyProvider, CONN_A),
      creds.accessTokenExpiresAt,
      creds.refreshTokenExpiresAt,
    ],
  );
}
async function stored() {
  const { rows } = await env.owner.query(
    `select encrypted_credentials, access_token_expires_at, refresh_token_expires_at, status, last_error
       from store_connections where id = $1`,
    [CONN_A],
  );
  return {
    ...rows[0],
    creds: decryptConnectionCredentials(
      rows[0].encrypted_credentials,
      keyProvider,
      CONN_A,
    ) as Record<string, string>,
  };
}
const grant = (n: number): ShopifyRefreshGrant => ({
  accessToken: `shpat_gen${n}`,
  scopes: [],
  accessTokenExpiresInSec: 3600,
  refreshToken: `shprt_gen${n}`,
  refreshTokenExpiresInSec: 7_776_000,
});
/** Shopify's rotation: a refresh token works exactly once. */
function rotating(delayMs = 0) {
  const calls: string[] = [];
  let generation = 0;
  const valid = new Set(['shprt_seed']);
  const fn: RefreshFn = async ({ refreshToken }) => {
    calls.push(refreshToken);
    await new Promise((r) => setTimeout(r, delayMs));
    if (!valid.delete(refreshToken)) throw new AuthError(SHOPIFY_RECONNECT_MESSAGE);
    generation += 1;
    valid.add(`shprt_gen${generation}`);
    return grant(generation);
  };
  return { fn, calls };
}
const service = (refresh?: RefreshFn) =>
  createTokenService({ db: env.db, keyProvider, refresh, now: () => NOW });
const args = { orgId: ORG_A, connectionId: CONN_A };

beforeEach(() => seed({ accessInMs: 60_000 }));

describe('createTokenService.ensureFresh', () => {
  it('does not refresh (or lock) when the access token has more than five minutes left', async () => {
    await seed({ accessInMs: REFRESH_WINDOW_MS + 1000 });
    const { fn, calls } = rotating();
    await expect(service(fn).ensureFresh(args)).resolves.toEqual({ accessToken: 'shpat_seed' });
    expect(calls).toEqual([]);
  });
  it('refreshes at exactly five minutes left and returns only the access token', async () => {
    await seed({ accessInMs: REFRESH_WINDOW_MS });
    const { fn, calls } = rotating();
    const result = await service(fn).ensureFresh(args);
    expect(result).toEqual({ accessToken: 'shpat_gen1' }); // no refreshToken key at all
    expect(calls).toEqual(['shprt_seed']);
    const row = await stored();
    expect(row.creds).toEqual({
      accessToken: 'shpat_gen1',
      accessTokenExpiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
      refreshToken: 'shprt_gen1',
      refreshTokenExpiresAt: new Date(NOW.getTime() + 7_776_000_000).toISOString(),
    });
    expect(row.access_token_expires_at.toISOString()).toBe(row.creds.accessTokenExpiresAt);
    expect(row.refresh_token_expires_at.toISOString()).toBe(row.creds.refreshTokenExpiresAt);
  });
  it('refreshes an already expired access token', async () => {
    await seed({ accessInMs: -10 * 60_000 });
    const { fn } = rotating();
    await expect(service(fn).ensureFresh(args)).resolves.toEqual({ accessToken: 'shpat_gen1' });
  });
  it('serialises concurrent callers: ONE Shopify call, everyone gets the rotated token', async () => {
    const { fn, calls } = rotating(80);
    const svc = service(fn);
    const results = await Promise.all([1, 2, 3].map(() => svc.ensureFresh(args)));
    expect(calls).toEqual(['shprt_seed']); // a second call with the dead token would have thrown
    expect(results).toEqual([
      { accessToken: 'shpat_gen1' },
      { accessToken: 'shpat_gen1' },
      { accessToken: 'shpat_gen1' },
    ]);
    expect((await stored()).creds.refreshToken).toBe('shprt_gen1');
  });
  it('holds a FOR NO KEY UPDATE lock on the connection row while it refreshes, without blocking key-share writers, and commits the new pair when it lets go', async () => {
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const refresh: RefreshFn = async () => {
      entered();
      await gate;
      return grant(1);
    };
    const pending = service(refresh).ensureFresh(args);
    await inside;
    const c = await env.owner.connect();
    try {
      await c.query('begin');
      // The refresher holds FOR NO KEY UPDATE. Both FOR UPDATE and FOR NO KEY UPDATE conflict with it, so NOWAIT
      // gets 55P03 (lock_not_available) in either mode; we use the SAME mode a second refresher would use.
      await expect(
        c.query('select id from store_connections where id = $1 for no key update nowait', [
          CONN_A,
        ]),
      ).rejects.toMatchObject({ code: '55P03' });
      await c.query('rollback');
      // ... but a child-row writer (it takes FOR KEY SHARE on the parent) is NOT blocked: this is what FOR UPDATE
      // would have broken. `for key share nowait` must succeed while the refresh is in flight.
      await c.query('begin');
      await c.query('select id from store_connections where id = $1 for key share nowait', [
        CONN_A,
      ]);
      await c.query('rollback');
    } finally {
      c.release();
    }
    expect((await stored()).creds.refreshToken).toBe('shprt_seed'); // nothing visible before commit
    release();
    await expect(pending).resolves.toEqual({ accessToken: 'shpat_gen1' });
    expect((await stored()).creds.refreshToken).toBe('shprt_gen1');
  });
  it('turns a lock timeout into a TransientError, leaving the stored pair untouched and calling Shopify not at all', async () => {
    const { fn, calls } = rotating();
    const blocker = await env.owner.connect();
    try {
      await blocker.query('begin');
      // A holder that is NOT the refresher: FOR NO KEY UPDATE, the mode the refresher itself needs.
      await blocker.query('select id from store_connections where id = $1 for no key update', [
        CONN_A,
      ]);
      const svc = createTokenService({
        db: env.db,
        keyProvider,
        refresh: fn,
        now: () => NOW,
        lockTimeoutMs: 150,
      });
      await expect(svc.ensureFresh(args)).rejects.toBeInstanceOf(TransientError);
      expect(calls).toEqual([]);
      await blocker.query('rollback');
    } finally {
      blocker.release();
    }
    expect((await stored()).creds.refreshToken).toBe('shprt_seed');
    await expect(service(fn).ensureFresh(args)).resolves.toEqual({ accessToken: 'shpat_gen1' }); // the retry works
  });
  it('a transient failure leaves the stored pair untouched, and the retry uses the SAME refresh token', async () => {
    const calls: string[] = [];
    let failures = 1;
    const refresh: RefreshFn = async ({ refreshToken }) => {
      calls.push(refreshToken);
      if (failures-- > 0) throw new TransientError('Shopify is temporarily unavailable');
      return grant(1);
    };
    const svc = service(refresh);
    await expect(svc.ensureFresh(args)).rejects.toBeInstanceOf(TransientError);
    expect((await stored()).creds.refreshToken).toBe('shprt_seed');
    await expect(svc.ensureFresh(args)).resolves.toEqual({ accessToken: 'shpat_gen1' });
    expect(calls).toEqual(['shprt_seed', 'shprt_seed']);
  });
  it('a failing credentials write throws fixed text (no ciphertext, no tokens, no cause) and rolls back', async () => {
    await env.owner.query(`
      create or replace function erq_test_fail_cred_write() returns trigger language plpgsql as $$
      begin raise exception 'forced failure'; end $$;
      create trigger erq_test_fail_cred_write before update of encrypted_credentials on store_connections
        for each row execute function erq_test_fail_cred_write();`);
    try {
      const { fn } = rotating();
      const err = (await service(fn)
        .ensureFresh(args)
        .catch((e: unknown) => e)) as Error;
      expect(err).toBeInstanceOf(TransientError);
      expect(err.message).toBe('Could not store refreshed credentials.');
      expect(err.cause).toBeUndefined();
      for (const secret of ['shpat_gen1', 'shprt_gen1', 'shprt_seed', 'shpat_seed', 'params'])
        expect(err.message).not.toContain(secret);
    } finally {
      await env.owner.query(
        `drop trigger erq_test_fail_cred_write on store_connections; drop function erq_test_fail_cred_write();`,
      );
    }
    expect((await stored()).creds).toMatchObject({
      accessToken: 'shpat_seed',
      refreshToken: 'shprt_seed',
    });
  });
  it('a final refusal throws the fixed reconnect text and changes nothing', async () => {
    const refresh: RefreshFn = async () => {
      throw new AuthError(SHOPIFY_RECONNECT_MESSAGE);
    };
    const err = (await service(refresh)
      .ensureFresh(args)
      .catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(AuthError);
    expect(err.message).toBe('Shopify no longer accepts this connection. Reconnect the store.');
    for (const secret of ['shprt_seed', 'shpat_seed']) expect(err.message).not.toContain(secret);
    expect((await stored()).creds.refreshToken).toBe('shprt_seed');
  });
  it('does not call Shopify when the refresh token itself has expired', async () => {
    await seed({ accessInMs: -1000, refreshInMs: -1000 });
    const { fn, calls } = rotating();
    await expect(service(fn).ensureFresh(args)).rejects.toMatchObject({
      name: 'AuthError',
      message: SHOPIFY_RECONNECT_MESSAGE,
    });
    expect(calls).toEqual([]);
  });
  it('never refreshes the old shape, whatever the clock says', async () => {
    await env.owner.query(
      `update store_connections set encrypted_credentials = $2, access_token_expires_at = null, refresh_token_expires_at = null where id = $1`,
      [CONN_A, encryptConnectionCredentials({ accessToken: 'shpat_old' }, keyProvider, CONN_A)],
    );
    const { fn, calls } = rotating();
    await expect(service(fn).ensureFresh(args)).resolves.toEqual({ accessToken: 'shpat_old' });
    expect(calls).toEqual([]);
  });
  it('returns null for a connection without credentials and fails closed when refreshing is not configured', async () => {
    await expect(service(undefined).ensureFresh(args)).rejects.toMatchObject({
      name: 'PermanentError',
      message: 'Token refresh is not configured on this server.',
    });
    await env.owner.query(
      `update store_connections set encrypted_credentials = null where id = $1`,
      [CONN_A],
    );
    await expect(service(undefined).ensureFresh(args)).resolves.toBeNull();
  });
  it("cannot reach another org's connection", async () => {
    await expect(
      service(rotating().fn).ensureFresh({ orgId: ORG_B, connectionId: CONN_A }),
    ).rejects.toBeInstanceOf(PermanentError);
    expect((await stored()).creds.refreshToken).toBe('shprt_seed');
  });
});
