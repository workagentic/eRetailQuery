import type { ConnectionDto, ConnectionResourceDto, ConnectionSyncDto } from '@erq/shared';

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

export interface ResourceLine {
  resource: string;
  label: string;
  hint: string;
  text: string;
  tone: 'ok' | 'warn' | 'muted';
}

const RESOURCE_LABELS_SHORT: Record<string, string> = {
  locations: 'Locations',
  products: 'Products',
  inventory: 'Stock',
  orders: 'Orders',
};
const RESOURCE_HINTS: Record<string, string> = {
  locations: 'Your warehouses and stores in Shopify.',
  products: 'Your products, prices and the cost per item you entered in Shopify.',
  inventory: 'How many units you have at each location.',
  orders: 'Your sales. Orders refresh about every 15 minutes.',
};

/** The oldest completion time, only when EVERY resource has finished at least once. */
export function oldestCompletedAt(resources: ConnectionResourceDto[]): string | null {
  if (resources.length === 0) return null;
  let oldest: number | null = null;
  for (const r of resources) {
    const t = r.lastCompletedAt ? new Date(r.lastCompletedAt).getTime() : Number.NaN;
    if (Number.isNaN(t)) return null;
    oldest = oldest === null ? t : Math.min(oldest, t);
  }
  return oldest === null ? null : new Date(oldest).toISOString();
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

/** An import older than this is shown as a warning, not as fresh. */
export const STALE_AFTER_MS = 2 * 24 * 60 * 60 * 1000;

const sentence = (text: string): string =>
  /[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`;

const join = (...parts: (string | null)[]): string | null => {
  const kept = parts.filter((p): p is string => p !== null && p.trim() !== '');
  return kept.length > 0 ? kept.map(sentence).join(' ') : null;
};

function neverDetail(canSync: boolean, status: ConnectionDto['status'], canStart: boolean): string {
  if (canSync) return 'Press Sync now to start.';
  if (status === 'pending') return 'Waiting for the connection to finish setting up.';
  if (status === 'demo') return 'This is sample data, so there is nothing to import.';
  return canStart
    ? 'Importing is not available for this connection.'
    : 'Importing is not available on this server yet.';
}

const stripEnd = (text: string): string => text.trim().replace(/[.!?]+$/, '');

export function describeResources(sync: ConnectionSyncDto, now: Date): ResourceLine[] {
  return sync.resources.map((r): ResourceLine => {
    const label = Object.hasOwn(RESOURCE_LABELS_SHORT, r.resource)
      ? (RESOURCE_LABELS_SHORT[r.resource] as string)
      : 'Data';
    const hint = Object.hasOwn(RESOURCE_HINTS, r.resource)
      ? (RESOURCE_HINTS[r.resource] as string)
      : '';
    const base = { resource: r.resource, label, hint };
    if (r.state === 'running') return { ...base, text: `${label}: importing now`, tone: 'muted' };
    if (r.state === 'never') return { ...base, text: `${label}: not imported yet`, tone: 'muted' };
    if (r.state === 'failed') {
      const good = r.lastCompletedAt
        ? ` Last good import ${relativeTime(r.lastCompletedAt, now)}.`
        : '';
      return {
        ...base,
        text: `${label}: failed, ${stripEnd(r.error ?? 'try Sync now')}.${good}`,
        tone: 'warn',
      };
    }
    const at = r.lastCompletedAt ? new Date(r.lastCompletedAt).getTime() : Number.NaN;
    const stale = !Number.isNaN(at) && now.getTime() - at > STALE_AFTER_MS;
    return {
      ...base,
      text: `${label}: last import ${relativeTime(r.lastCompletedAt, now)}`,
      tone: stale ? 'warn' : 'ok',
    };
  });
}

export const REFRESH_NOTE =
  'Orders refresh about every 15 minutes. Products and stock levels refresh sooner when Shopify tells us about a change.';

export function describeUnlinked(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  if (count === 1) {
    return '1 order line is waiting for its product to be imported, so its cost is not counted yet.';
  }
  return `${count.toLocaleString('en-US')} order lines are waiting for their products to be imported, so their cost is not counted yet.`;
}

/**
 * Plain-English sync status for one connection. It combines the import state with the
 * connection's own status and error so a broken connection is never shown as up to date.
 */
export function describeSync(
  sync: ConnectionSyncDto,
  lastSyncedAt: string | null,
  now: Date,
  connection: Pick<ConnectionDto, 'status' | 'lastError'>,
): SyncView {
  const coverage = coverageText(sync);
  const usable = connection.status === 'active' || connection.status === 'error';
  const canSync = sync.canStart && usable;
  // With per-resource times, "last import" is the OLDEST resource: the headline never claims more than that.
  const freshness = sync.resources.length > 0 ? oldestCompletedAt(sync.resources) : lastSyncedAt;
  const syncedMs = freshness ? new Date(freshness).getTime() : Number.NaN;
  const hasSynced = !Number.isNaN(syncedMs);
  const synced = hasSynced ? `Last synced ${relativeTime(freshness, now)}` : 'Not synced yet';

  if (connection.status === 'disconnected') {
    return {
      headline: 'Not connected',
      detail: join('Reconnect this store to import your data', coverage),
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
    const lastGood = hasSynced ? `Last successful sync ${relativeTime(freshness, now)}` : null;
    return {
      headline: 'Import stopped',
      detail: join(
        `Stopped while importing ${resourceLabel(sync.resource)}`,
        sync.error ?? 'Try Sync now',
        lastGood,
        coverage,
      ),
      tone: 'warn',
      canSync,
    };
  }
  const neverImported = sync.state === 'never' || !hasSynced;
  if (connection.status === 'error') {
    const why = connection.lastError ?? 'Something went wrong with this connection';
    return {
      headline: neverImported ? 'Not imported yet' : 'Not up to date',
      detail: join(why, synced, coverage),
      tone: 'warn',
      canSync,
    };
  }
  if (neverImported) {
    return {
      headline: 'Not imported yet',
      detail: neverDetail(canSync, connection.status, sync.canStart),
      tone: 'muted',
      canSync,
    };
  }
  const stale = now.getTime() - syncedMs > STALE_AFTER_MS;
  return {
    headline: `Last import finished ${relativeTime(freshness, now)}`,
    detail: join(stale ? 'This may be out of date. Try Sync now' : null, coverage),
    tone: stale ? 'warn' : 'ok',
    canSync,
  };
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
