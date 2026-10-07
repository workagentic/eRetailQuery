// packages/connectors/test/shopify-graphql.test.ts
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  AuthError,
  createShopifyGraphqlClient,
  PermanentError,
  RateLimitedError,
  TransientError,
} from '../src';
import { FakeShopifyAdmin, gqlOk, gqlThrottled, paginate } from '../src/testing';

const op = {
  name: 'Ping',
  document: 'query Ping { shop { name } }',
  schema: z.object({ shop: z.object({ name: z.string() }) }),
};
const ctx = {
  externalAccountId: 'a.myshopify.com',
  credentials: { accessToken: 'shpat_secret_token_value' },
};
const clientFor = (admin: FakeShopifyAdmin, apiVersion?: string) =>
  createShopifyGraphqlClient({ http: admin, apiVersion });

describe('createShopifyGraphqlClient', () => {
  it('posts the documented request and returns parsed data with the actual query cost', async () => {
    const admin = new FakeShopifyAdmin().on('Ping', () =>
      gqlOk({ shop: { name: 'Acme' } }, { actual: 42 }),
    );
    const res = await clientFor(admin, '2025-07').query(ctx, op, { x: 1 });
    expect(res).toEqual({ data: { shop: { name: 'Acme' } }, cost: 42 });
    const req = admin.requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://a.myshopify.com/admin/api/2025-07/graphql.json');
    expect(req.headers?.['X-Shopify-Access-Token']).toBe('shpat_secret_token_value');
    expect(JSON.parse(req.body!)).toEqual({
      query: op.document,
      variables: { x: 1 },
      operationName: 'Ping',
    });
  });
  it('rejects an invalid shop and unusable credentials before any request', async () => {
    const admin = new FakeShopifyAdmin();
    const c = clientFor(admin);
    await expect(c.query({ ...ctx, externalAccountId: 'evil.com' }, op, {})).rejects.toBeInstanceOf(
      PermanentError,
    );
    for (const credentials of [
      null,
      undefined,
      {},
      { accessToken: '' },
      { accessToken: 5 },
      'shpat_x',
    ]) {
      await expect(c.query({ ...ctx, credentials }, op, {})).rejects.toBeInstanceOf(AuthError);
    }
    expect(admin.requests).toHaveLength(0);
  });
  it.each([
    [401, AuthError],
    [403, AuthError],
    [500, TransientError],
    [502, TransientError],
    [404, PermanentError],
    [418, PermanentError],
  ] as const)('maps HTTP %i', async (status, type) => {
    const admin = new FakeShopifyAdmin();
    admin.failNext(status);
    await expect(clientFor(admin).query(ctx, op, {})).rejects.toBeInstanceOf(type);
  });
  it('maps HTTP 429 to a rate limit using retry-after, with a safe default', async () => {
    for (const [header, expected] of [
      ['3', 3000],
      ['', 2000],
      ['abc', 2000],
      ['-1', 2000],
      [undefined, 2000],
    ] as const) {
      const admin = new FakeShopifyAdmin();
      admin.failNext(429, header === undefined ? {} : { 'retry-after': header });
      const err = await clientFor(admin)
        .query(ctx, op, {})
        .catch((e) => e);
      expect(err).toBeInstanceOf(RateLimitedError);
      expect((err as RateLimitedError).retryAfterMs).toBe(expected);
    }
  });
  it('maps a THROTTLED GraphQL error to a wait computed from the throttle status', async () => {
    const admin = new FakeShopifyAdmin().on('Ping', () =>
      gqlThrottled({ requested: 600, available: 100, restoreRate: 50 }),
    );
    const err = await clientFor(admin)
      .query(ctx, op, {})
      .catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).retryAfterMs).toBe(10_000); // (600 - 100) / 50 s
  });
  it('clamps the throttle wait and defaults it when the cost data is missing', async () => {
    const tiny = new FakeShopifyAdmin().on('Ping', () =>
      gqlThrottled({ requested: 101, available: 100, restoreRate: 50 }),
    );
    expect(
      (
        (await clientFor(tiny)
          .query(ctx, op, {})
          .catch((e) => e)) as RateLimitedError
      ).retryAfterMs,
    ).toBe(500);
    const huge = new FakeShopifyAdmin().on('Ping', () =>
      gqlThrottled({ requested: 100000, available: 0, restoreRate: 1 }),
    );
    expect(
      (
        (await clientFor(huge)
          .query(ctx, op, {})
          .catch((e) => e)) as RateLimitedError
      ).retryAfterMs,
    ).toBe(60_000);
    const none = new FakeShopifyAdmin().on('Ping', () => ({
      errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }],
    }));
    expect(
      (
        (await clientFor(none)
          .query(ctx, op, {})
          .catch((e) => e)) as RateLimitedError
      ).retryAfterMs,
    ).toBe(2000);
  });
  it('maps ACCESS_DENIED and other GraphQL errors to permanent errors with fixed messages', async () => {
    const denied = new FakeShopifyAdmin().on('Ping', () => ({
      errors: [
        { message: 'Access denied for customer field', extensions: { code: 'ACCESS_DENIED' } },
      ],
    }));
    const e1 = await clientFor(denied)
      .query(ctx, op, {})
      .catch((e) => e);
    expect(e1).toBeInstanceOf(PermanentError);
    expect(e1.message).toBe("Shopify did not allow this request. Check the app's permissions.");
    const other = new FakeShopifyAdmin().on('Ping', () => ({
      errors: [{ message: 'Field x does not exist ' + 'shpat_leak' }],
    }));
    const e2 = await clientFor(other)
      .query(ctx, op, {})
      .catch((e) => e);
    expect(e2).toBeInstanceOf(PermanentError);
    expect(e2.message).toBe('Shopify returned an unexpected response.');
  });
  it('rejects malformed bodies and data that fails the schema, without echoing anything', async () => {
    const bodies = ['not json', '[]', '{"data": {"shop": {"name": 5}}}', '{"data": null}', '{}'];
    for (const body of bodies) {
      const admin = new FakeShopifyAdmin();
      admin.respondNext({ status: 200, body });
      const err = await clientFor(admin)
        .query(ctx, op, {})
        .catch((e) => e);
      expect(err).toBeInstanceOf(PermanentError);
      expect(err.message).toBe('Shopify returned an unexpected response.');
    }
  });
  it('never puts the token, the query or the variables into any error message', async () => {
    const admin = new FakeShopifyAdmin();
    admin.failNext(500);
    const err = await clientFor(admin)
      .query(ctx, op, { secretVariable: 'zzz' })
      .catch((e) => e);
    expect(err.message).not.toMatch(/shpat_|Ping|zzz|shop \{/);
  });
});

describe('paginate', () => {
  it('walks a list with cursors', () => {
    const items = [1, 2, 3, 4, 5];
    const first = paginate(items, 2, null);
    expect(first).toEqual({ nodes: [1, 2], pageInfo: { hasNextPage: true, endCursor: '1' } });
    const second = paginate(items, 2, first.pageInfo.endCursor);
    expect(second).toEqual({ nodes: [3, 4], pageInfo: { hasNextPage: true, endCursor: '3' } });
    expect(paginate(items, 2, second.pageInfo.endCursor)).toEqual({
      nodes: [5],
      pageInfo: { hasNextPage: false, endCursor: '4' },
    });
    expect(paginate([], 2, null)).toEqual({
      nodes: [],
      pageInfo: { hasNextPage: false, endCursor: null },
    });
  });
});
