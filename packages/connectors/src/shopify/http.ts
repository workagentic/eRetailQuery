import { TransientError } from '../errors';

export interface HttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  body?: string;
}
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}
export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
}

export function createFetchHttpClient(
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): HttpClient {
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    async request(req) {
      try {
        const res = await doFetch(req.url, {
          method: req.method,
          headers: req.headers,
          body: req.body,
          redirect: 'error', // the host was validated, a redirect target would not be
          signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
        });
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => {
          headers[k.toLowerCase()] = v;
        });
        return { status: res.status, headers, body: await res.text() };
      } catch {
        // Deliberately drop the cause: it can contain the URL and its query string.
        throw new TransientError('network error');
      }
    },
  };
}
