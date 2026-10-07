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
          extensions: z.object({ code: z.string().optional() }).passthrough().optional(),
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

export function createShopifyGraphqlClient(opts: { http: HttpClient; apiVersion?: string }) {
  const apiVersion = opts.apiVersion ?? SHOPIFY_API_VERSION;
  return {
    async query<T>(
      ctx: GraphqlContext,
      op: GraphqlOperation<T>,
      variables: Record<string, unknown>,
    ): Promise<{ data: T; cost: number }> {
      if (!isValidShopDomain(ctx.externalAccountId))
        throw new PermanentError('Invalid shop domain');
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
          Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 2000,
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
        const codes = parsed.errors.map((e) => e.extensions?.code);
        if (codes.includes('THROTTLED'))
          throw new RateLimitedError(throttleWaitMs(parsed.extensions));
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
    },
  };
}
export type ShopifyGraphqlClient = ReturnType<typeof createShopifyGraphqlClient>;
