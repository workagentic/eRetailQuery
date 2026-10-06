import { isValidShopDomain } from './domain';

export function buildAuthorizeUrl(p: {
  shop: string;
  apiKey: string;
  scopes: string[];
  redirectUri: string;
  state: string;
}): string {
  if (!isValidShopDomain(p.shop)) throw new RangeError('invalid shop domain');
  const url = new URL(`https://${p.shop}/admin/oauth/authorize`);
  url.searchParams.set('client_id', p.apiKey);
  url.searchParams.set('scope', p.scopes.join(','));
  url.searchParams.set('redirect_uri', p.redirectUri);
  url.searchParams.set('state', p.state);
  return url.toString();
}
