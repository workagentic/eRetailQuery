// Doc check 2026-10-07: extensions.cost / throttleStatus field names confirmed at
// https://shopify.dev/docs/apps/build/apis/graphql-admin/rate-limits ; the THROTTLED error code is not stated on that page.
// packages/connectors/src/shopify/graphql.ts
// https://shopify.dev/docs/api/admin-graphql  (request shape)
// https://shopify.dev/docs/api/usage/rate-limits#graphql-admin-api-rate-limits  (cost, THROTTLED, throttleStatus)
import { z } from 'zod';
import { AuthError, PermanentError, RateLimitedError, TransientError } from '../errors';
import { SHOPIFY_API_VERSION } from './config';
import { isValidShopDomain } from './domain';
import type { HttpClient } from './http';

export interface GraphqlOperation<T> {
  name: string;
  document: string;
  schema: z.ZodType<T>;
}
export interface GraphqlContext {
  externalAccountId: string;
  /** Decrypted credentials. Never log this. */
  credentials: unknown;
}

const credentialsSchema = z.object({ accessToken: z.string().min(1) });
const envelope = z.object({
  data: z.unknown().optional(),
  errors: z
    .array(
      z
        .object({
          message: z.string().optional(),
          // Tolerant: null or non-object extensions just mean "no code".
          extensions: z.unknown().optional(),
        })
        .passthrough(),
    )
    .optional(),
  extensions: z
    .object({
      cost: z
        .object({
          requestedQueryCost: z.number().optional(),
          actualQueryCost: z.number().nullable().optional(),
          throttleStatus: z
            .object({
              maximumAvailable: z.number().optional(),
              currentlyAvailable: z.number().optional(),
              restoreRate: z.number().optional(),
            })
            .partial()
            .optional(),
        })
        .optional(),
    })
    .passthrough()
    .optional(),
});

const UNEXPECTED = 'Shopify returned an unexpected response.';

function throttleWaitMs(cost: z.infer<typeof envelope>['extensions']): number {
  const c = cost?.cost;
  const requested = c?.requestedQueryCost;
  const available = c?.throttleStatus?.currentlyAvailable;
  const rate = c?.throttleStatus?.restoreRate;
  if (requested === undefined || available === undefined || rate === undefined || rate <= 0)
    return 2000;
  return Math.min(60_000, Math.max(500, Math.ceil(((requested - available) / rate) * 1000)));
}

/** In-place retries of one THROTTLED query before the page is handed back to the queue. */
export const THROTTLE_MAX_RETRIES = 5;
/** Most time one query may spend waiting out throttles in place. */
export const THROTTLE_MAX_WAIT_MS = 60_000;

/** Internal marker for a THROTTLED GraphQL response; never escapes `query()`. */
class ThrottledError extends Error {
  constructor(readonly retryAfterMs: number) {
    super('Throttled');
  }
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export interface ShopifyGraphqlClientOptions {
  http: HttpClient;
  apiVersion?: string;
  /** Waits out a THROTTLED response before retrying in place. Injectable for tests; defaults to a timer. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * A THROTTLED response is retried in place: the client waits the time the throttle status says the
 * bucket needs and sends the same query again, at most THROTTLE_MAX_RETRIES times and
 * THROTTLE_MAX_WAIT_MS in total, before throwing RateLimitedError. Retrying the single query (not
 * the whole page) matters: a page with many follow-up queries can drain the bucket mid-page, and
 * re-running the page from its first query against an empty bucket could repeat forever.
 * No pacing from throttleStatus.currentlyAvailable is done before a query (UNVERIFIED costs; the
 * sync limiter paces pages). An HTTP 429 is not retried in place.
 */
export function createShopifyGraphqlClient(opts: ShopifyGraphqlClientOptions) {
  const apiVersion = opts.apiVersion ?? SHOPIFY_API_VERSION;
  const sleep = opts.sleep ?? realSleep;
  return {
    async query<T>(
      ctx: GraphqlContext,
      op: GraphqlOperation<T>,
      variables: Record<string, unknown>,
    ): Promise<{ data: T; cost: number }> {
      let retries = 0;
      let waited = 0;
      for (;;) {
        try {
          return await attempt(ctx, op, variables);
        } catch (error) {
          if (!(error instanceof ThrottledError)) throw error;
          const wait = error.retryAfterMs;
          if (retries >= THROTTLE_MAX_RETRIES || waited + wait > THROTTLE_MAX_WAIT_MS) {
            throw new RateLimitedError(wait);
          }
          retries += 1;
          waited += wait;
          await sleep(wait);
        }
      }
    },
  };

  async function attempt<T>(
    ctx: GraphqlContext,
    op: GraphqlOperation<T>,
    variables: Record<string, unknown>,
  ): Promise<{ data: T; cost: number }> {
    if (!isValidShopDomain(ctx.externalAccountId)) throw new PermanentError('Invalid shop domain');
    const creds = credentialsSchema.safeParse(ctx.credentials);
    if (!creds.success)
      throw new AuthError('Stored credentials are unusable. Reconnect the store.');
    const res = await opts.http.request({
      method: 'POST',
      url: `https://${ctx.externalAccountId}/admin/api/${apiVersion}/graphql.json`,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'X-Shopify-Access-Token': creds.data.accessToken,
      },
      body: JSON.stringify({ query: op.document, variables, operationName: op.name }),
    });
    if (res.status === 401 || res.status === 403)
      throw new AuthError('Shopify rejected the access token.');
    if (res.status === 429) {
      const raw = (res.headers['retry-after'] ?? '').trim();
      const seconds = raw === '' ? Number.NaN : Number(raw);
      throw new RateLimitedError(
        // Same window as the throttle path so a huge Retry-After cannot park a sync.
        Number.isFinite(seconds) && seconds >= 0
          ? Math.min(60_000, Math.max(500, seconds * 1000))
          : 2000,
      );
    }
    if (res.status >= 500) throw new TransientError('Shopify is temporarily unavailable');
    if (res.status !== 200) throw new PermanentError(UNEXPECTED);
    let parsed: z.infer<typeof envelope>;
    try {
      parsed = envelope.parse(JSON.parse(res.body));
    } catch {
      throw new PermanentError(UNEXPECTED);
    }
    if (parsed.errors && parsed.errors.length > 0) {
      // Any GraphQL errors entry fails the whole page, even when data is present: a tolerated
      // field-level ACCESS_DENIED could silently null unit costs and corrupt profit numbers.
      const codes = parsed.errors.map((e) => {
        const ext = e.extensions;
        return ext !== null && typeof ext === 'object'
          ? (ext as { code?: unknown }).code
          : undefined;
      });
      if (codes.includes('THROTTLED')) throw new ThrottledError(throttleWaitMs(parsed.extensions));
      if (codes.includes('ACCESS_DENIED')) {
        throw new PermanentError(
          "Shopify did not allow this request. Check the app's permissions.",
        );
      }
      throw new PermanentError(UNEXPECTED);
    }
    const data = op.schema.safeParse(parsed.data);
    if (!data.success) throw new PermanentError(UNEXPECTED);
    const cost = parsed.extensions?.cost;
    return { data: data.data, cost: cost?.actualQueryCost ?? cost?.requestedQueryCost ?? 0 };
  }
}
export type ShopifyGraphqlClient = ReturnType<typeof createShopifyGraphqlClient>;
