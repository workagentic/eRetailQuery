import { AuthError, SHOPIFY_API_VERSION, type HttpClient, type HttpRequest } from '@erq/connectors';
import { describe, expect, it } from 'vitest';
import { createWorkerConnectors } from '../src/sync/connectors';

function fakeHttp(): HttpClient & { requests: HttpRequest[] } {
  const requests: HttpRequest[] = [];
  return {
    requests,
    async request(req) {
      requests.push(req);
      throw new Error('the network must not be reached');
    },
  };
}

describe('createWorkerConnectors', () => {
  it('registers the Shopify connector, which rejects unusable credentials without a request', async () => {
    const http = fakeHttp();
    const connector = createWorkerConnectors({}, http).get('shopify');
    const err = await connector
      .fetchPage(
        { connectionId: 'c', externalAccountId: 'a.myshopify.com', credentials: null },
        'locations',
        null,
        {},
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect(http.requests).toHaveLength(0);
  });

  const versionSent = async (env: NodeJS.ProcessEnv): Promise<string> => {
    const requests: HttpRequest[] = [];
    const http: HttpClient = {
      async request(req) {
        requests.push(req);
        return { status: 500, headers: {}, body: '{}' };
      },
    };
    await createWorkerConnectors(env, http)
      .get('shopify')
      .fetchPage(
        {
          connectionId: 'c',
          externalAccountId: 'a.myshopify.com',
          credentials: { accessToken: 't' },
        },
        'locations',
        null,
        {},
      )
      .catch(() => undefined);
    return /\/admin\/api\/([^/]+)\/graphql\.json$/.exec(requests[0]!.url)![1]!;
  };

  it('uses SHOPIFY_API_VERSION when it is YYYY-MM and the built-in default when empty', async () => {
    expect(await versionSent({ SHOPIFY_API_VERSION: '2026-01' })).toBe('2026-01');
    expect(await versionSent({ SHOPIFY_API_VERSION: '' })).toBe(SHOPIFY_API_VERSION);
    expect(await versionSent({ SHOPIFY_API_VERSION: '  ' })).toBe(SHOPIFY_API_VERSION);
    expect(await versionSent({})).toBe(SHOPIFY_API_VERSION);
  });

  it('refuses to start with an invalid SHOPIFY_API_VERSION, without echoing the value', () => {
    for (const bad of ['2025-7', 'latest', 'unstable', '2025-07/../x', 'shpat_secret_value']) {
      let message = '';
      try {
        createWorkerConnectors({ SHOPIFY_API_VERSION: bad }, fakeHttp());
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toBe('SHOPIFY_API_VERSION must look like 2025-07 (YYYY-MM) or be empty.');
      expect(message).not.toContain(bad);
    }
  });
});
