const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A run of only lowercase letters is prose, not an opaque token.
const WORD = /^[a-z]+$/;

/**
 * Makes error text safe to store or return: strips tokens, secrets and query strings, caps the length.
 * Connector errors may embed URLs or response fragments, so everything stored in last_error or event errors goes through here.
 */
export function sanitizeMessage(input: unknown, max = 500): string {
  let text: string;
  try {
    text = input instanceof Error ? input.message : String(input);
  } catch {
    text = 'unprintable error';
  }
  text = text
    .replace(/\bshp(?:at|ca|ss|pa)_[A-Za-z0-9]+/g, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(
      /\b(access_token|client_secret|api_secret|secret|token|password|hmac|code)\s*[=:]\s*[^\s&,;]+/gi,
      '$1=[redacted]',
    )
    .replace(/\?[^\s#]*(#\S*)?/g, '?[redacted]')
    .replace(/[A-Za-z0-9_+/=-]{32,}/g, (m) => (UUID.test(m) || WORD.test(m) ? m : '[redacted]'));
  return text.slice(0, max);
}
