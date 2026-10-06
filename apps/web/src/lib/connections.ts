import type { ConnectionDto } from '@erq/shared';

const GENERIC_ERROR = 'Something went wrong connecting to Shopify. Please try again.';

// Fixed map keyed by the known codes in SHOPIFY_ERROR_CODES. Never echo the incoming code.
const ERROR_MESSAGES: Record<string, string> = {
  invalid_request: GENERIC_ERROR,
  state_expired: 'That connection link expired. Please try connecting again.',
  shop_mismatch: GENERIC_ERROR,
  shop_in_use: 'That store is already connected to another organization.',
  exchange_failed: 'Shopify did not accept the connection. Please try again.',
  not_configured: 'Shopify connections are not set up on this server yet.',
  server_error: GENERIC_ERROR,
};

export function shopifyErrorMessage(code: string | undefined): string | null {
  if (code === undefined) return null;
  return Object.hasOwn(ERROR_MESSAGES, code) ? (ERROR_MESSAGES[code] as string) : GENERIC_ERROR;
}

// Page-owned codes (not part of the API's SHOPIFY_ERROR_CODES).
const PAGE_ERROR_MESSAGES: Record<string, string> = {
  disconnect_failed: 'We could not disconnect that store. Please try again.',
};

export function connectionsErrorMessage(code: string | undefined): string | null {
  if (code !== undefined && Object.hasOwn(PAGE_ERROR_MESSAGES, code)) {
    return PAGE_ERROR_MESSAGES[code] as string;
  }
  return shopifyErrorMessage(code);
}

export function shopifyWarningMessage(code: string | undefined): string | null {
  return code === 'webhooks'
    ? 'Connected, but live updates could not be set up. Reconnect to try again.'
    : null;
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'} ago`;
}

export function relativeTime(iso: string | null, now: Date): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'never';
  const seconds = Math.max(0, Math.floor((now.getTime() - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return plural(minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return plural(hours, 'hour');
  return plural(Math.floor(hours / 24), 'day');
}

export interface ConnectionView {
  label: string;
  tone: 'ok' | 'warn' | 'muted';
  detail: string;
  canReconnect: boolean;
}

export function describeConnection(c: ConnectionDto, now: Date): ConnectionView {
  const synced = `Last synced ${relativeTime(c.lastSyncedAt, now)}`;
  switch (c.status) {
    case 'active':
      return c.lastError
        ? {
            label: 'Needs attention',
            tone: 'warn',
            detail: `${c.lastError} ${synced}`,
            canReconnect: true,
          }
        : { label: 'Connected', tone: 'ok', detail: synced, canReconnect: false };
    case 'error':
      return {
        label: 'Needs attention',
        tone: 'warn',
        detail: `${c.lastError ?? 'Something went wrong with this connection.'} ${synced}`,
        canReconnect: true,
      };
    case 'disconnected':
      return { label: 'Disconnected', tone: 'muted', detail: synced, canReconnect: true };
    case 'pending':
      return { label: 'Setting up', tone: 'muted', detail: synced, canReconnect: false };
    case 'demo':
      return {
        label: 'Demo data',
        tone: 'muted',
        detail: 'Sample data, not a real store.',
        canReconnect: false,
      };
  }
}

// Mirror of SHOP_RE in packages/connectors/src/shopify/domain.ts (one DNS label); keep them identical.
const SHOP_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/;

// UI hint only; the server is authoritative.
export function suggestShopDomain(input: string): { value: string; valid: boolean } {
  let v = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '');
  v = v.split(/[/?#]/)[0] ?? '';
  if (v !== '' && !v.includes('.')) v = `${v}.myshopify.com`;
  return { value: v, valid: SHOP_RE.test(v) };
}

// Defence in depth against an open redirect through a compromised API response.
export function isShopifyAuthorizeUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  try {
    const u = new URL(raw);
    return (
      u.protocol === 'https:' &&
      u.username === '' &&
      u.password === '' &&
      u.port === '' &&
      SHOP_RE.test(u.hostname)
    );
  } catch {
    return false;
  }
}
