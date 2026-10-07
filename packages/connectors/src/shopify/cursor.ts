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
// Inventory cost cap: per level ~1 (level) + 1 (location) + 4 (quantities) = 6 points; per item
// 1 (item) + 1 (variant) + levels * 6. So items * (2 + levels * 6) must stay under 1000:
// 10 * (2 + 10 * 6) = 620. The follow-up ErqInventoryLevels query is one item: 50 * 6 = 300.
// https://shopify.dev/docs/api/usage/limits#cost-calculation
export const INVENTORY_ITEMS_PAGE_SIZE = 10;
export const INVENTORY_LEVELS_INLINE = 10;
export const INVENTORY_LEVELS_EXTRA_PAGE_SIZE = 50;
// Orders cost cap. Requested cost counts every object (a money set is 2: the bag and shopMoney),
// a connection is 2 plus its nodes plus 1 for pageInfo. Per order: 1 + 3 money sets (6) + lines
// (3 + 6 per line: line, variant, 2 money sets) + refunds; per refund: 1 + 2 + refund lines
// (3 + 4 per line: line, lineItem, subtotal) + shipping lines (3 + 3 per line).
// 3 * (7 + 63 + 6 * 35) + 3 = 843, under 1000. Refunds are requested one beyond the supported
// count so an overflow is detected instead of silently truncated. A test guards the arithmetic.
// https://shopify.dev/docs/api/usage/limits#cost-calculation
export const ORDERS_PAGE_SIZE = 3;
export const ORDER_LINES_INLINE = 10;
export const ORDER_LINES_EXTRA_PAGE_SIZE = 100;
export const ORDER_REFUNDS_INLINE = 5;
export const REFUND_LINES_INLINE = 5;
export const REFUND_SHIPPING_INLINE = 2;
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
