// Shop domains: https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant
const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export const normalizeShopInput = (input: string): string => input.trim().toLowerCase();

/** Strict: one lowercase label under myshopify.com, nothing else. Validate before building any URL. */
export function isValidShopDomain(shop: string): boolean {
  return shop.length <= 255 && SHOP_RE.test(shop);
}
