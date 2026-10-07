import { AuthError, type HttpClient, type HttpRequest } from '@erq/connectors';
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
});
