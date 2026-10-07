export const ORDERS_HISTORY_DAYS = { full: 365, limited: 60 } as const;

const DAY_MS = 86_400_000;

/**
 * How far back the orders backfill reaches. Shopify serves only the last 60 days of orders unless
 * the `read_all_orders` scope was granted: https://shopify.dev/docs/api/usage/access-scopes
 * Scopes match exactly; anything else (absent, malformed) degrades to the limited window.
 * Pass the stored scopes array, not the raw scope string: `includes` on a string would match a
 * substring (for example "read_all_orders_x") and widen the window.
 */
export function ordersBackfillSince(grantedScopes: readonly string[], now: Date): Date {
  const days = grantedScopes.includes('read_all_orders')
    ? ORDERS_HISTORY_DAYS.full
    : ORDERS_HISTORY_DAYS.limited;
  return new Date(now.getTime() - days * DAY_MS);
}
