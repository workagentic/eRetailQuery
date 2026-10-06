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
