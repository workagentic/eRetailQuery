// packages/connectors/src/testing/fake-shopify-admin.ts
import type { HttpClient, HttpRequest, HttpResponse } from '../shopify/http';

type Handler = (variables: Record<string, unknown>, callIndex: number) => unknown;
interface CostOpts {
  requested?: number;
  actual?: number;
  available?: number;
  max?: number;
  restoreRate?: number;
}

const costExtension = (c: CostOpts) => ({
  cost: {
    requestedQueryCost: c.requested ?? 100,
    actualQueryCost: c.actual ?? 40,
    throttleStatus: {
      maximumAvailable: c.max ?? 1000,
      currentlyAvailable: c.available ?? 960,
      restoreRate: c.restoreRate ?? 50,
    },
  },
});

/** Requested cost of a products query: each product costs 1 plus 2 per inline variant (variant + inventoryItem). */
export const productsQueryCost = (productsFirst: number, variantsFirst: number): number =>
  productsFirst * (1 + variantsFirst * 2);

/** Requested cost of an inventory query: per item 2 (item + variant) plus 6 per level (level, location, 4 quantities). */
export const inventoryQueryCost = (itemsFirst: number, levelsFirst: number): number =>
  itemsFirst * (2 + levelsFirst * 6);

export const gqlOk = (data: unknown, cost: CostOpts = {}): unknown => ({
  data,
  extensions: costExtension(cost),
});
export const gqlThrottled = (cost: CostOpts = {}): unknown => ({
  errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }],
  extensions: costExtension({ available: 0, ...cost }),
});

/** Cursor = index of the last returned item; `after` resumes after that index. */
export function paginate<T>(items: T[], first: number, after: string | null) {
  if (after !== null && !/^\d+$/.test(after)) throw new Error(`paginate: invalid cursor ${after}`);
  const start = after === null ? 0 : Number(after) + 1;
  const nodes = items.slice(start, start + first);
  const last = start + nodes.length - 1;
  return {
    nodes,
    pageInfo: {
      hasNextPage: start + nodes.length < items.length,
      endCursor: nodes.length > 0 ? String(last) : null,
    },
  };
}

/** In-memory Shopify Admin GraphQL endpoint for tests. Dispatches on `operationName`; records every request. */
export class FakeShopifyAdmin implements HttpClient {
  readonly requests: HttpRequest[] = [];
  private readonly handlers = new Map<string, Handler>();
  private readonly counts = new Map<string, number>();
  private readonly scripted: HttpResponse[] = [];

  on(operationName: string, handler: Handler): this {
    this.handlers.set(operationName, handler);
    return this;
  }
  failNext(status: number, headers: Record<string, string> = {}): void {
    this.scripted.push({ status, headers, body: '{}' });
  }
  respondNext(res: { status: number; body: string; headers?: Record<string, string> }): void {
    this.scripted.push({ status: res.status, headers: res.headers ?? {}, body: res.body });
  }
  callsOf(operationName: string): number {
    return this.counts.get(operationName) ?? 0;
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    this.requests.push(req);
    const scripted = this.scripted.shift();
    if (scripted) return scripted;
    let body: { operationName?: string; variables?: Record<string, unknown> };
    try {
      body = JSON.parse(req.body ?? '{}');
    } catch {
      return { status: 400, headers: {}, body: '{}' };
    }
    const name = body.operationName ?? '';
    const handler = this.handlers.get(name);
    if (!handler) return { status: 404, headers: {}, body: '{}' };
    const index = this.counts.get(name) ?? 0;
    this.counts.set(name, index + 1);
    const out = handler(body.variables ?? {}, index);
    if (out === undefined) {
      throw new Error(`FakeShopifyAdmin handler for ${name} returned undefined`);
    }
    return { status: 200, headers: {}, body: JSON.stringify(out) };
  }
}
