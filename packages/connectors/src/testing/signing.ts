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
