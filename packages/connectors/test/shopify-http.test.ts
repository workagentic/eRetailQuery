import { describe, expect, it } from 'vitest';
import { createFetchHttpClient, TransientError } from '../src';

describe('createFetchHttpClient', () => {
  it('returns status, lowercased headers and body, and refuses redirects', async () => {
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe('error');
      return new Response('{"ok":true}', { status: 201, headers: { 'Retry-After': '2' } });
    }) as unknown as typeof fetch;
    const http = createFetchHttpClient({ fetchImpl });
    const res = await http.request({
      method: 'POST',
      url: 'https://a.myshopify.com/x',
      body: '{}',
    });
    expect(res.status).toBe(201);
    expect(res.headers['retry-after']).toBe('2');
    expect(res.body).toBe('{"ok":true}');
  });
  it('maps network failures to TransientError without leaking the url', async () => {
    const fetchImpl = (async () => {
      throw new Error('connect ECONNREFUSED https://a.myshopify.com/x?code=secret');
    }) as unknown as typeof fetch;
    const http = createFetchHttpClient({ fetchImpl });
    const err = await http
      .request({ method: 'GET', url: 'https://a.myshopify.com/x' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(TransientError);
    expect(String(err.message)).not.toMatch(/secret|myshopify/);
  });
});
