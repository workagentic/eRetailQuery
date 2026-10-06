// Shop domains: https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant
// One DNS label (1 to 63 characters, no leading or trailing hyphen). Keep identical to SHOP_RE in
// apps/web/src/lib/connections.ts.
const SHOP_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/;

export const normalizeShopInput = (input: string): string => input.trim().toLowerCase();

/** Strict: one lowercase label under myshopify.com, nothing else. Validate before building any URL. */
export function isValidShopDomain(shop: string): boolean {
  return shop.length <= 255 && SHOP_RE.test(shop);
}
