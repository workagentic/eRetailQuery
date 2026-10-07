import { createHmac } from 'node:crypto';

export const signWebhook = (body: string | Buffer, secret: string): string =>
  createHmac('sha256', secret).update(body).digest('base64');

export function signOAuthQuery(
  params: Record<string, string>,
  secret: string,
): Record<string, string> {
  const message = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return { ...params, hmac: createHmac('sha256', secret).update(message).digest('hex') };
}

/** Returns a query string (no leading `?`) with `hmac` appended, signed over the encoded or decoded values. */
export function signOAuthRawQuery(
  params: Record<string, string>,
  secret: string,
  mode: 'encoded' | 'decoded' = 'encoded',
): string {
  const keys = Object.keys(params).sort();
  const enc = (s: string) => encodeURIComponent(s);
  const message = keys
    .map((k) => (mode === 'encoded' ? `${enc(k)}=${enc(params[k]!)}` : `${k}=${params[k]}`))
    .join('&');
  const hmac = createHmac('sha256', secret).update(message).digest('hex');
  return [...keys.map((k) => `${enc(k)}=${enc(params[k]!)}`), `hmac=${hmac}`].join('&');
}

const safeDecode = (s: string): string => {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
};

/**
 * Signs an arbitrary list of already-encoded `key=value` pairs (even invalid ones, for negative tests)
 * and returns the query string with `hmac` appended. `encoded` signs the pairs as given, `decoded` the decoded form.
 */
export function signRawPairs(
  pairs: string[],
  secret: string,
  mode: 'encoded' | 'decoded' = 'encoded',
): string {
  const parsed = pairs.map((pair) => {
    const eq = pair.indexOf('=');
    const key = safeDecode(eq < 0 ? pair : pair.slice(0, eq));
    const value = eq < 0 ? '' : safeDecode(pair.slice(eq + 1));
    return { pair, key, decoded: `${key}=${value}` };
  });
  parsed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const message = parsed.map((p) => (mode === 'encoded' ? p.pair : p.decoded)).join('&');
  const hmac = createHmac('sha256', secret).update(message).digest('hex');
  return [...pairs, `hmac=${hmac}`].join('&');
}
