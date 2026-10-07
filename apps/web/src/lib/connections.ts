import type { ConnectionDto, ConnectionSyncDto } from '@erq/shared';

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
  wrong_account:
    'This connection was started from a different account. Sign in with the account that started it, or start again.',
  not_allowed: 'Only an owner or admin can connect a store.',
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

export interface SyncView {
  headline: string;
  detail: string | null;
  tone: 'ok' | 'warn' | 'muted';
  canSync: boolean;
}

const RESOURCE_LABELS: Record<string, string> = {
  locations: 'locations',
  products: 'products',
  inventory: 'stock levels',
  orders: 'orders',
};

function resourceLabel(resource: string | null): string {
  return resource !== null && Object.hasOwn(RESOURCE_LABELS, resource)
    ? (RESOURCE_LABELS[resource] as string)
    : 'your data';
}

function coverageText(sync: ConnectionSyncDto): string | null {
  const parts: string[] = [];
  if (sync.coveredFrom) {
    const t = new Date(sync.coveredFrom);
    if (!Number.isNaN(t.getTime())) {
      const date = t.toLocaleDateString('en-US', {
        timeZone: 'UTC',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
      parts.push(`Showing orders from ${date}.`);
    }
  }
  if (sync.historyLimited) {
    parts.push("Older history needs Shopify's approval to read all orders.");
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

const join = (...parts: (string | null)[]): string | null => {
  const kept = parts.filter((p): p is string => p !== null && p !== '');
  return kept.length > 0 ? kept.join(' ') : null;
};

/**
 * Plain-English sync status for one connection. It combines the import state with the
 * connection's own status and error so a broken connection is never shown as up to date.
 */
export function describeSync(
  sync: ConnectionSyncDto,
  lastSyncedAt: string | null,
  now: Date,
  connection?: Pick<ConnectionDto, 'status' | 'lastError'>,
): SyncView {
  const coverage = coverageText(sync);
  const usable =
    connection === undefined || connection.status === 'active' || connection.status === 'error';
  const canSync = sync.canStart && usable;
  const synced = `Last synced ${relativeTime(lastSyncedAt, now)}`;

  if (connection?.status === 'disconnected') {
    return {
      headline: 'Not connected',
      detail: join('Reconnect this store to import your data.', coverage),
      tone: 'muted',
      canSync: false,
    };
  }
  if (sync.state === 'running') {
    return {
      headline: `Importing ${resourceLabel(sync.resource)}, ${sync.recordsProcessed.toLocaleString('en-US')} so far`,
      detail: coverage,
      tone: 'muted',
      canSync: false,
    };
  }
  if (sync.state === 'failed') {
    const where = `Stopped while importing ${resourceLabel(sync.resource)}.`;
    const lastGood = lastSyncedAt
      ? `Last successful sync ${relativeTime(lastSyncedAt, now)}.`
      : null;
    return {
      headline: 'Import stopped',
      detail: join(where, sync.error ?? 'Try Sync now.', lastGood, coverage),
      tone: 'warn',
      canSync,
    };
  }
  const inError = connection?.status === 'error';
  if (inError) {
    const why = `${connection.lastError ?? 'Something went wrong with this connection.'} ${synced}`;
    return {
      headline: sync.state === 'never' ? 'Not imported yet' : 'Not up to date',
      detail: join(why, coverage),
      tone: 'warn',
      canSync,
    };
  }
  if (sync.state === 'never') {
    return {
      headline: 'Not imported yet',
      detail: sync.canStart
        ? 'Press Sync now to start.'
        : 'Importing is not available on this server yet.',
      tone: 'muted',
      canSync,
    };
  }
  return { headline: 'Up to date', detail: join(synced, coverage), tone: 'ok', canSync };
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
