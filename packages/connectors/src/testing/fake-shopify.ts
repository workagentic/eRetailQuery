import type { HttpClient, HttpRequest, HttpResponse } from '../shopify/http';
import {
  SHOPIFY_FUTURE_DATA_WEBHOOK_TOPICS,
  SHOPIFY_WEBHOOK_TOPICS,
  topicToEnum,
} from '../shopify/webhooks';

const ENUM_TO_TOPIC = new Map<string, string>(
  [...SHOPIFY_WEBHOOK_TOPICS, ...SHOPIFY_FUTURE_DATA_WEBHOOK_TOPICS].map((t) => [
    topicToEnum(t),
    t,
  ]),
);

/** In-memory Shopify for tests: OAuth token exchange and webhook subscriptions. Records every request. */
export class FakeShopify implements HttpClient {
  readonly requests: HttpRequest[] = [];
  readonly subscriptions = new Map<string, string>();
  private readonly scripted: HttpResponse[] = [];
  private readonly token: string;
  private readonly refreshToken: string;
  /** Refresh tokens Shopify would still accept (each one is single use). */
  private readonly validRefresh = new Set<string>();
  /** Every refresh token a client presented, in order (also the ones Shopify refused). */
  readonly presentedRefreshTokens: string[] = [];
  private refreshGeneration = 0;
  private readonly scope: string;
  private readonly codes: Set<string>;

  constructor(
    opts: { token?: string; refreshToken?: string; scope?: string; codes?: Set<string> } = {},
  ) {
    this.token = opts.token ?? 'shpat_fake_token';
    this.refreshToken = opts.refreshToken ?? 'shprt_fake_refresh';
    this.scope = opts.scope ?? 'read_orders,read_products';
    this.codes = opts.codes ?? new Set(['good-code']);
  }

  /** Forgets scripted responses, recorded requests and subscriptions (use in beforeEach). */
  reset(): void {
    this.scripted.length = 0;
    this.requests.length = 0;
    this.subscriptions.clear();
    this.validRefresh.clear();
    this.presentedRefreshTokens.length = 0;
    this.refreshGeneration = 0;
  }

  /** Makes `token` a refresh token Shopify accepts once, as if an earlier exchange had issued it. */
  acceptRefreshToken(token: string): void {
    this.validRefresh.add(token);
  }

  private refresh(form: URLSearchParams): HttpResponse {
    const presented = form.get('refresh_token') ?? '';
    this.presentedRefreshTokens.push(presented);
    // Single use: a token that was already replaced (or never issued) is refused for good.
    if (!this.validRefresh.delete(presented)) {
      return { status: 401, headers: {}, body: '{"error":"invalid_request"}' };
    }
    this.refreshGeneration += 1;
    const n = this.refreshGeneration;
    const nextRefresh = `${this.refreshToken}_${n}`;
    this.validRefresh.add(nextRefresh);
    return {
      status: 200,
      headers: {},
      body: JSON.stringify({
        access_token: `${this.token}_${n}`,
        scope: this.scope,
        expires_in: 3600,
        refresh_token: nextRefresh,
        refresh_token_expires_in: 7_776_000,
      }),
    };
  }

  /** The next request answers with this status and an empty JSON body. */
  failNext(status: number, headers: Record<string, string> = {}): void {
    this.scripted.push({ status, headers, body: '{}' });
  }
  /** The next request answers with exactly this response. */
  respondNext(res: { status: number; body: string; headers?: Record<string, string> }): void {
    this.scripted.push({ status: res.status, headers: res.headers ?? {}, body: res.body });
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    this.requests.push(req);
    const scripted = this.scripted.shift();
    if (scripted) return scripted;
    const url = new URL(req.url);
    if (url.pathname === '/admin/oauth/access_token') {
      const form = new URLSearchParams(req.body ?? '');
      if (form.get('grant_type') === 'refresh_token') return this.refresh(form);
      const code = form.get('code');
      if (!code || !this.codes.has(code)) {
        return { status: 400, headers: {}, body: '{"error":"invalid_request"}' };
      }
      const body: Record<string, unknown> = { access_token: this.token, scope: this.scope };
      // Shopify only issues an expiring token (and a refresh token) when the exchange asks for it.
      if (form.get('expiring') === '1') {
        body.expires_in = 3600;
        body.refresh_token = this.refreshToken;
        body.refresh_token_expires_in = 7_776_000;
        this.validRefresh.add(this.refreshToken);
      }
      return { status: 200, headers: {}, body: JSON.stringify(body) };
    }
    if (/^\/admin\/api\/[^/]+\/graphql\.json$/.test(url.pathname)) {
      const { variables } = JSON.parse(req.body ?? '{}') as {
        variables: { topic: string; url: string };
      };
      const topic = ENUM_TO_TOPIC.get(variables.topic) ?? variables.topic;
      const exists = this.subscriptions.has(topic);
      if (!exists) this.subscriptions.set(topic, variables.url);
      const userErrors = exists
        ? [{ field: ['topic'], message: 'Address for this topic has already been taken' }]
        : [];
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({ data: { webhookSubscriptionCreate: { userErrors } } }),
      };
    }
    return { status: 404, headers: {}, body: '{}' };
  }
}
