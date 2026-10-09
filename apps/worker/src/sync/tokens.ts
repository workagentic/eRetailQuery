import { createFetchHttpClient, refreshAccessToken, type HttpClient } from '@erq/connectors';
import type { TenantDb } from '@erq/db';
import type { KeyProvider } from '@erq/shared';
import { createTokenService, type RefreshFn, type TokenService } from '@erq/sync';

/** The refresh function, or undefined when the app key and secret are not configured on this worker. */
export function workerRefreshFn(
  env: NodeJS.ProcessEnv,
  http: HttpClient = createFetchHttpClient(),
): RefreshFn | undefined {
  const apiKey = (env.SHOPIFY_API_KEY ?? '').trim();
  const apiSecret = (env.SHOPIFY_API_SECRET ?? '').trim();
  if (apiKey === '' || apiSecret === '') return undefined;
  return ({ shop, refreshToken }) =>
    refreshAccessToken(http, { shop, apiKey, apiSecret, refreshToken });
}

export function createWorkerTokenService(
  env: NodeJS.ProcessEnv,
  db: TenantDb,
  keyProvider: KeyProvider,
  http: HttpClient = createFetchHttpClient(),
): TokenService {
  return createTokenService({ db, keyProvider, refresh: workerRefreshFn(env, http) });
}
