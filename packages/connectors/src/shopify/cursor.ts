// packages/connectors/src/shopify/cursor.ts
// Sync cursors are opaque to callers: base64url of {"v":1,"after":<Shopify endCursor|null>}.
// Shopify GraphQL connections paginate with pageInfo { hasNextPage endCursor }:
// https://shopify.dev/docs/api/usage/pagination-graphql
import { z } from 'zod';
import { PermanentError } from '../errors';

export const LOCATIONS_PAGE_SIZE = 100;
// Cost cap: Shopify rejects a query whose requested cost exceeds 1000 points, and any GraphQL error
// fails the page. A connection costs about 1 point per object plus 2 per nested object here
// (variant + inventoryItem/unitCost), so products * (1 + variants * 2) must stay under 1000:
// 8 * (1 + 50 * 2) = 808. Raising either size can break every real import; a test guards this.
// https://shopify.dev/docs/api/usage/limits#cost-calculation
export const PRODUCTS_PAGE_SIZE = 8;
export const VARIANTS_PAGE_SIZE = 50;
/**
 * Extra variant pages fetched for one product before the import fails loudly. Per-job ceiling:
 * one products page can issue up to PRODUCTS_PAGE_SIZE * MAX_EXTRA_PAGES extra variant queries.
 */
export const MAX_EXTRA_PAGES = 20;

const UNEXPECTED = 'Shopify returned an unexpected response.';
const INVALID = 'Invalid sync cursor.';

export const pageInfoSchema = z.object({
  hasNextPage: z.boolean(),
  endCursor: z.string().nullable(),
});
export type PageInfo = z.infer<typeof pageInfoSchema>;

const cursorSchema = z.object({ v: z.literal(1), after: z.string().min(1).nullable() }).strict();

export function encodeCursor(after: string | null): string {
  return Buffer.from(JSON.stringify({ v: 1, after }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | null): string | null {
  if (cursor === null) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new PermanentError(INVALID);
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new PermanentError(INVALID);
  }
  const parsed = cursorSchema.safeParse(json);
  if (!parsed.success || encodeCursor(parsed.data.after) !== cursor)
    throw new PermanentError(INVALID);
  return parsed.data.after;
}

/** hasNextPage with no endCursor would loop forever, so it is treated as a bad response. */
export function nextCursorOf(pageInfo: PageInfo): string | null {
  if (!pageInfo.hasNextPage) return null;
  if (!pageInfo.endCursor) throw new PermanentError(UNEXPECTED);
  return encodeCursor(pageInfo.endCursor);
}
