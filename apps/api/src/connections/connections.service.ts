import { Inject, Injectable } from '@nestjs/common';
import { and, count, eq, inArray, isNotNull, isNull, lt, min, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import {
  buildAuthorizeUrl,
  credentialExpiry,
  credentialsFromGrant,
  encryptConnectionCredentials,
  exchangeCodeForToken,
  isValidShopDomain,
  normalizeShopInput,
  parseWebhookHeaders,
  registerWebhooks,
  sanitizeMessage,
  verifyOAuthRawQuery,
  verifyWebhookSignature,
  type HttpClient,
  type ShopifyConfig,
  type ShopifyTokenGrant,
} from '@erq/connectors';
import {
  alerts,
  type ConnectionsApi,
  generateOAuthNonce,
  hashOAuthNonce,
  insertAudit,
  oauthStates,
  orderLines,
  orders,
  orgMembers,
  storeConnections,
  syncCursors,
  webhookEvents,
  type TenantDb,
  type Tx,
} from '@erq/db';
import {
  hasRole,
  type ConnectionAlertDto,
  type ConnectionDto,
  type ConnectionResourceDto,
  type ConnectionSyncDto,
  type InstallResponse,
  type KeyProvider,
  type ShopifyErrorCode,
  type SyncNowResponse,
} from '@erq/shared';
import { IMPORT_NOT_STARTED_MESSAGE, WEBHOOK_SETUP_FAILED_MESSAGE } from '@erq/sync';
import { ApiError } from '../common/api-error';
import { APP_CONFIG, LOGGER } from '../config/config.module';
import type { Env } from '../config/env';
import { TENANT_DB } from '../db/db.module';
import {
  CONNECTIONS_API,
  HTTP_CLIENT,
  KEY_PROVIDER,
  SHOPIFY_CONFIG,
  SYNC_QUEUE_PORT,
  WEBHOOK_QUEUE_PORT,
} from './tokens';
import type { SyncQueuePort } from './sync-queue';
import { SyncStarter } from './sync-starter';
import type { WebhookQueue } from './webhook-queue';

/** How long the webhook receiver waits for the queue before answering anyway (the worker sweep recovers). */
export const WEBHOOK_ENQUEUE_TIMEOUT_MS = 2000;

/** How long the OAuth callback waits for the first sync to be queued; mutable only so tests can shorten it. */
export const syncStartTimeout = { ms: 5000 };

/** Order in which a full import runs; the summary reports the first running or failed resource in this order. */
const SYNC_RESOURCE_ORDER = ['locations', 'products', 'inventory', 'orders'] as const;

const ACTIVE_SHOP_INDEX = 'store_connections_active_shop_uq';

/** True for a Postgres unique violation on the one-active-org-per-shop index (raw or wrapped by Drizzle). */
function isActiveShopConflict(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && typeof e === 'object' && depth < 3; depth++) {
    const { code, constraint } = e as { code?: unknown; constraint?: unknown };
    if (code === '23505' && constraint === ACTIVE_SHOP_INDEX) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

@Injectable()
export class ConnectionsService {
  constructor(
    @Inject(TENANT_DB) private readonly db: TenantDb,
    @Inject(SHOPIFY_CONFIG) private readonly config: ShopifyConfig | null,
    @Inject(CONNECTIONS_API) private readonly api: ConnectionsApi,
    @Inject(HTTP_CLIENT) private readonly http: HttpClient,
    @Inject(KEY_PROVIDER) private readonly keyProvider: KeyProvider | null,
    @Inject(APP_CONFIG) private readonly env: Env,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(WEBHOOK_QUEUE_PORT) private readonly webhookQueue: WebhookQueue,
    private readonly syncStarter: SyncStarter,
    @Inject(SYNC_QUEUE_PORT) private readonly syncQueue: SyncQueuePort,
  ) {}

  private redirect(params: Record<string, string>): string {
    const base = this.env.WEB_PUBLIC_URL.replace(/\/+$/, '');
    return `${base}/connections?${new URLSearchParams(params).toString()}`;
  }

  private fail(code: ShopifyErrorCode): string {
    return this.redirect({ shopify_error: code });
  }

  /**
   * Authenticated OAuth callback. The caller must be the user who started the install (the single-use state
   * names them) and still an owner or admin of the state's org; the org never comes from the session.
   * Always returns a redirect URL and never throws. Never log the query, code, state or token.
   */
  async completeInstall(userId: string, rawQuery: string): Promise<string> {
    try {
      const cfg = this.config;
      const keyProvider = this.keyProvider;
      if (!cfg || !keyProvider) return this.fail('not_configured');
      if (!verifyOAuthRawQuery(rawQuery, cfg.apiSecret)) return this.fail('invalid_request');
      const params = new URLSearchParams(rawQuery);
      const code = params.get('code');
      const shop = params.get('shop');
      const state = params.get('state');
      if (!code || !shop || !state) return this.fail('invalid_request');
      if (!isValidShopDomain(shop)) return this.fail('invalid_request');
      // From here on the state is burned, whatever the outcome.
      const consumed = await this.api.consumeOAuthState(hashOAuthNonce(state));
      if (!consumed) return this.fail('state_expired');
      if (consumed.userId !== userId) return this.fail('wrong_account');
      const role = await this.db.withTenant(consumed.orgId, async (tx) => {
        const rows = await tx
          .select({ role: orgMembers.role })
          .from(orgMembers)
          .where(and(eq(orgMembers.orgId, consumed.orgId), eq(orgMembers.userId, userId)));
        return rows[0]?.role;
      });
      if (!role || !hasRole(role, 'admin')) return this.fail('not_allowed');
      if (consumed.shop !== shop) return this.fail('shop_mismatch');
      const existing = await this.api.findStoreConnection('shopify', shop);
      if (existing && existing.orgId !== consumed.orgId && existing.status !== 'disconnected') {
        return this.fail('shop_in_use');
      }
      let token: ShopifyTokenGrant;
      try {
        token = await exchangeCodeForToken(this.http, {
          shop,
          apiKey: cfg.apiKey,
          apiSecret: cfg.apiSecret,
          code,
        });
      } catch {
        return this.fail('exchange_failed');
      }
      const stored = credentialsFromGrant(token, new Date());
      const expiry = credentialExpiry(stored);
      const { orgId } = consumed;
      let connectionId: string;
      try {
        connectionId = await this.db.withTenant(orgId, async (tx) => {
          const [row] = await tx
            .insert(storeConnections)
            .values({
              orgId,
              platform: 'shopify',
              externalAccountId: shop,
              status: 'active',
              scopes: token.scopes,
              lastError: null,
            })
            .onConflictDoUpdate({
              target: [
                storeConnections.orgId,
                storeConnections.platform,
                storeConnections.externalAccountId,
              ],
              set: {
                status: 'active',
                scopes: token.scopes,
                lastError: null,
                updatedAt: new Date(),
              },
            })
            .returning({ id: storeConnections.id });
          if (!row) throw new Error('connection upsert returned no row');
          await tx
            .update(storeConnections)
            .set({
              encryptedCredentials: encryptConnectionCredentials(stored, keyProvider, row.id),
              accessTokenExpiresAt: expiry.accessTokenExpiresAt,
              refreshTokenExpiresAt: expiry.refreshTokenExpiresAt,
            })
            .where(and(eq(storeConnections.orgId, orgId), eq(storeConnections.id, row.id)));
          await resolveAlerts(tx, orgId, row.id);
          await retirePendingUninstalls(tx, orgId, row.id);
          await insertAudit(tx, {
            orgId,
            actorUserId: consumed.userId,
            action: 'connection.connected',
            entityType: 'store_connection',
            entityId: row.id,
            after: { platform: 'shopify', shop },
          });
          return row.id;
        });
      } catch (err) {
        // The partial unique index is the authority when two orgs race for the same shop.
        if (isActiveShopConflict(err)) return this.fail('shop_in_use');
        throw err;
      }
      // Network calls happen outside the transaction.
      let webhooksOk = false;
      try {
        const result = await registerWebhooks(this.http, {
          shop,
          accessToken: token.accessToken,
          callbackUrl: cfg.webhookUrl,
          apiVersion: cfg.apiVersion,
        });
        webhooksOk = result.failed.length === 0;
      } catch (err) {
        this.logger.warn(
          { err: sanitizeMessage(err) },
          'shopify webhook registration threw during connect',
        );
      }
      // Best effort: a queue failure never breaks the connect. The stored (granted) scopes size the window.
      // A reconnect of a finished shop starts a new full backfill, and one while a chain is past locations may
      // overlap it; sinks are idempotent, so this is accepted (docs/sync.md).
      let importFailed = false;
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          this.syncStarter.start({ orgId, connectionId, scopes: token.scopes }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('sync start timed out')),
              syncStartTimeout.ms,
            );
          }),
        ]);
      } catch (err) {
        importFailed = true;
        this.logger.warn({ err: sanitizeMessage(err) }, 'shopify first import could not start');
      } finally {
        clearTimeout(timer);
      }
      if (webhooksOk && !importFailed) return this.redirect({ shopify: 'connected' });
      // One warning fits: a webhook failure wins because a reconnect fixes both (it also restarts
      // the import). The import text is the shared constant the sync engine clears at a chain end.
      const lastError = !webhooksOk ? WEBHOOK_SETUP_FAILED_MESSAGE : IMPORT_NOT_STARTED_MESSAGE;
      try {
        await this.db.withTenant(orgId, (tx) =>
          tx
            .update(storeConnections)
            .set({ lastError })
            .where(and(eq(storeConnections.orgId, orgId), eq(storeConnections.id, connectionId))),
        );
      } catch (err) {
        this.logger.warn({ err: sanitizeMessage(err) }, 'could not store the connection warning');
      }
      return webhooksOk
        ? this.redirect({ shopify: 'connected' })
        : this.redirect({ shopify: 'connected', warning: 'webhooks' });
    } catch (err) {
      this.logger.error({ err: sanitizeMessage(err) }, 'shopify callback failed');
      return this.fail('server_error');
    }
  }

  private requireConfig(): ShopifyConfig {
    if (!this.config) {
      throw new ApiError(503, 'shopify_not_configured', 'Shopify is not configured on this server');
    }
    return this.config;
  }

  async startInstall(orgId: string, userId: string, input: string): Promise<InstallResponse> {
    const cfg = this.requireConfig();
    // Without a key the callback cannot store the token: refuse before the merchant consents on Shopify.
    if (!this.keyProvider) {
      throw new ApiError(503, 'shopify_not_configured', 'Shopify is not configured on this server');
    }
    const shop = normalizeShopInput(input);
    if (!isValidShopDomain(shop)) {
      throw new ApiError(
        400,
        'invalid_shop',
        'Enter your store address like my-store.myshopify.com',
      );
    }
    const nonce = generateOAuthNonce();
    await this.db.withTenant(orgId, async (tx) => {
      await tx.delete(oauthStates).where(lt(oauthStates.expiresAt, new Date())); // lazy cleanup, no scheduler needed
      await tx.insert(oauthStates).values({
        orgId,
        userId,
        platform: 'shopify',
        shop,
        nonceHash: hashOAuthNonce(nonce),
        expiresAt: new Date(Date.now() + 10 * 60_000),
      });
    });
    return {
      authorizeUrl: buildAuthorizeUrl({
        shop,
        apiKey: cfg.apiKey,
        scopes: cfg.scopes,
        redirectUri: cfg.redirectUri,
        state: nonce,
      }),
    };
  }

  list(orgId: string): Promise<ConnectionDto[]> {
    return this.db.withTenant(orgId, async (tx) => {
      // A fixed number of queries for the whole org, grouped in memory: never one per connection.
      const rows = await tx
        .select()
        .from(storeConnections)
        .where(eq(storeConnections.orgId, orgId))
        .orderBy(storeConnections.createdAt, storeConnections.id);
      const cursors = await tx
        .select({
          connectionId: syncCursors.storeConnectionId,
          resource: syncCursors.resource,
          status: syncCursors.status,
          recordsProcessed: syncCursors.recordsProcessed,
          lastError: syncCursors.lastError,
          lastSyncedAt: syncCursors.lastSyncedAt,
        })
        .from(syncCursors)
        .where(eq(syncCursors.orgId, orgId));
      const covered = await tx
        .select({ connectionId: orders.storeConnectionId, from: min(orders.placedAt) })
        .from(orders)
        // Test orders are not real sales history, so they never widen the covered range.
        .where(and(eq(orders.orgId, orgId), eq(orders.isTest, false)))
        .groupBy(orders.storeConnectionId);
      const unlinked = await tx
        .select({ connectionId: orders.storeConnectionId, n: count() })
        .from(orderLines)
        .innerJoin(
          orders,
          and(eq(orders.orgId, orderLines.orgId), eq(orders.id, orderLines.orderId)),
        )
        .where(
          and(
            // RLS already scopes the rows; the explicit org filter is defence in depth.
            eq(orders.orgId, orgId),
            isNull(orderLines.skuId),
            isNotNull(orderLines.externalVariantId),
            eq(orders.isTest, false),
          ),
        )
        .groupBy(orders.storeConnectionId);
      const open = await tx
        .select({
          id: alerts.id,
          connectionId: alerts.storeConnectionId,
          severity: alerts.severity,
          message: alerts.message,
        })
        .from(alerts)
        .where(
          and(
            eq(alerts.orgId, orgId),
            eq(alerts.type, 'webhook_failed'),
            isNull(alerts.resolvedAt),
          ),
        )
        .orderBy(alerts.createdAt, alerts.id);
      const rank = { high: 0, medium: 1, low: 2 } as const;
      const alertsBy = new Map<string, ConnectionAlertDto[]>();
      for (const a of open) {
        if (a.connectionId === null) continue;
        const list = alertsBy.get(a.connectionId) ?? [];
        list.push({ id: a.id, severity: a.severity, message: a.message });
        alertsBy.set(a.connectionId, list);
      }
      const unlinkedBy = new Map(unlinked.map((u) => [u.connectionId, u.n]));
      const byConn = new Map<string, typeof cursors>();
      for (const c of cursors) {
        const list = byConn.get(c.connectionId) ?? [];
        list.push(c);
        byConn.set(c.connectionId, list);
      }
      const coveredBy = new Map(covered.map((c) => [c.connectionId, c.from]));
      return rows.map((r) => ({
        id: r.id,
        platform: r.platform,
        shop: r.externalAccountId,
        status: r.status,
        lastSyncedAt: r.lastSyncedAt?.toISOString() ?? null,
        lastError: r.lastError,
        sync: this.summarize(
          r,
          byConn.get(r.id) ?? [],
          coveredBy.get(r.id) ?? null,
          unlinkedBy.get(r.id) ?? 0,
        ),
        // Array.prototype.sort is stable, so creation order holds within a severity.
        alerts: (alertsBy.get(r.id) ?? []).sort((x, y) => rank[x.severity] - rank[y.severity]),
      }));
    });
  }

  private summarize(
    conn: { status: string; scopes: string[] | null },
    cursors: {
      resource: string;
      status: string;
      recordsProcessed: number;
      lastError: string | null;
      lastSyncedAt: Date | null;
    }[],
    coveredFrom: Date | null,
    unlinkedLines: number,
  ): ConnectionSyncDto {
    const ordered = SYNC_RESOURCE_ORDER.flatMap((r) => cursors.filter((c) => c.resource === r));
    const running = ordered.find((c) => c.status === 'running');
    const failed = ordered.find((c) => c.status === 'failed');
    const allComplete = SYNC_RESOURCE_ORDER.every((r) =>
      cursors.some((c) => c.resource === r && c.status === 'complete'),
    );
    const resources = SYNC_RESOURCE_ORDER.map((resource): ConnectionResourceDto => {
      const c = cursors.find((x) => x.resource === resource);
      const lastCompletedAt = c?.lastSyncedAt?.toISOString() ?? null;
      if (!c) return { resource, state: 'never', lastCompletedAt: null, error: null };
      if (c.status === 'running')
        return { resource, state: 'running', lastCompletedAt, error: null };
      if (c.status === 'failed')
        return { resource, state: 'failed', lastCompletedAt, error: c.lastError };
      return {
        resource,
        state: lastCompletedAt === null ? 'never' : 'idle',
        lastCompletedAt,
        error: null,
      };
    });
    const base = {
      coveredFrom: coveredFrom?.toISOString() ?? null,
      historyLimited: !(conn.scopes ?? []).includes('read_all_orders'),
      canStart:
        this.syncQueue.available &&
        (conn.status === 'active' || conn.status === 'error') &&
        !running,
      resources,
      unlinkedLines,
    };
    if (running) {
      return {
        ...base,
        state: 'running',
        resource: running.resource,
        recordsProcessed: running.recordsProcessed,
        error: null,
      };
    }
    if (failed) {
      return {
        ...base,
        state: 'failed',
        resource: failed.resource,
        recordsProcessed: failed.recordsProcessed,
        error: failed.lastError,
      };
    }
    return {
      ...base,
      state: allComplete ? 'idle' : 'never',
      resource: null,
      recordsProcessed: 0,
      error: null,
    };
  }

  /** Starts a backfill (never fully synced) or an incremental sync. `started: false` means one is already running. */
  async syncNow(orgId: string, userId: string, id: string): Promise<SyncNowResponse> {
    const conn = await this.db.withTenant(orgId, async (tx) => {
      const rows = await tx
        .select({ status: storeConnections.status, scopes: storeConnections.scopes })
        .from(storeConnections)
        .where(and(eq(storeConnections.orgId, orgId), eq(storeConnections.id, id)));
      const row = rows[0];
      if (!row) return null;
      const done = await tx
        .select({ resource: syncCursors.resource, status: syncCursors.status })
        .from(syncCursors)
        .where(
          and(
            eq(syncCursors.orgId, orgId),
            eq(syncCursors.storeConnectionId, id),
            sql`(${syncCursors.lastSyncedAt} is not null or ${syncCursors.status} = 'running')`,
          ),
        );
      const doneSet = new Set(done.filter((d) => d.status !== 'running').map((d) => d.resource));
      return {
        ...row,
        synced: SYNC_RESOURCE_ORDER.every((r) => doneSet.has(r)),
        running: done.some((d) => d.status === 'running'),
      };
    });
    if (!conn) throw new ApiError(404, 'connection_not_found', 'Connection not found');
    if (conn.status !== 'active' && conn.status !== 'error') {
      throw new ApiError(409, 'connection_not_active', 'Reconnect this store first.');
    }
    if (!this.syncQueue.available) {
      throw new ApiError(
        503,
        'sync_not_available',
        'Importing is not available on this server yet.',
      );
    }
    // enqueueSync only guards the first resource's cursor, so a chain past locations is checked here.
    if (conn.running) return { started: false };
    const mode = conn.synced ? 'incremental' : 'backfill';
    let result: Awaited<ReturnType<SyncStarter['start']>>;
    try {
      result = await this.syncStarter.start({
        orgId,
        connectionId: id,
        scopes: conn.scopes ?? [],
        mode,
      });
    } catch (err) {
      // Only the start (queue) failing maps here; enqueueSync already failed the run and freed the cursor.
      this.logger.warn({ err: sanitizeMessage(err) }, 'sync now could not be queued');
      throw new ApiError(
        503,
        'sync_not_available',
        'Could not start the sync. Try again in a moment.',
      );
    }
    if (result === 'unavailable') {
      throw new ApiError(
        503,
        'sync_not_available',
        'Importing is not available on this server yet.',
      );
    }
    if (result === 'already_running') return { started: false };
    await this.db.withTenant(orgId, (tx) =>
      insertAudit(tx, {
        orgId,
        actorUserId: userId,
        action: 'connection.sync_requested',
        entityType: 'store_connection',
        entityId: id,
        after: { mode },
      }),
    );
    return { started: true };
  }

  async disconnect(orgId: string, userId: string, id: string): Promise<void> {
    await this.db.withTenant(orgId, async (tx) => {
      const rows = await tx
        .update(storeConnections)
        .set({ status: 'disconnected', encryptedCredentials: null })
        .where(and(eq(storeConnections.orgId, orgId), eq(storeConnections.id, id)))
        .returning({ id: storeConnections.id });
      if (rows.length === 0) {
        throw new ApiError(404, 'connection_not_found', 'Connection not found');
      }
      await resolveAlerts(tx, orgId, id);
      await insertAudit(tx, {
        orgId,
        actorUserId: userId,
        action: 'connection.disconnected',
        entityType: 'store_connection',
        entityId: id,
      });
    });
  }

  /**
   * Public webhook receiver. Authorized only by the HMAC over the raw body bytes.
   * The body is parsed only to reject non-JSON and is then discarded: it is never persisted
   * (the stored payload is always `{}`) and the worker fetches any data it needs from Shopify.
   * Never log the payload, body or signature header.
   */
  async receiveWebhook(
    rawBody: Buffer | undefined,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<'stored' | 'duplicate' | 'unknown_shop'> {
    const cfg = this.requireConfig();
    const invalid = () => new ApiError(401, 'invalid_signature', 'Invalid signature');
    if (!rawBody) throw invalid();
    const sig = headers['x-shopify-hmac-sha256'];
    if (typeof sig !== 'string' || !verifyWebhookSignature(rawBody, sig, cfg.apiSecret)) {
      throw invalid();
    }
    const parsed = parseWebhookHeaders(headers);
    if (!parsed) throw invalid();
    try {
      JSON.parse(rawBody.toString('utf8')); // validity check only; nothing from the body is retained
    } catch {
      throw new ApiError(400, 'invalid_payload', 'Webhook body is not valid JSON');
    }
    const conn = await this.api.findStoreConnection('shopify', parsed.shop);
    if (!conn) {
      this.logger.info(
        { shop: parsed.shop, topic: parsed.topic },
        'shopify webhook for unknown shop',
      );
      return 'unknown_shop';
    }
    const { orgId } = conn;
    const inserted = await this.db.withTenant(orgId, (tx) =>
      tx
        .insert(webhookEvents)
        .values({
          orgId,
          storeConnectionId: conn.connectionId,
          topic: parsed.topic,
          externalEventId: parsed.webhookId,
          payload: {},
        })
        .onConflictDoNothing({
          target: [
            webhookEvents.orgId,
            webhookEvents.storeConnectionId,
            webhookEvents.externalEventId,
          ],
        })
        .returning({ id: webhookEvents.id }),
    );
    const row = inserted[0];
    if (!row) return 'duplicate';
    // Shopify waits about 5s for the ack; a slow or unreachable Redis must not hold the answer.
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.webhookQueue.enqueue({ orgId, eventId: row.id }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('webhook enqueue timed out')),
            WEBHOOK_ENQUEUE_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (err) {
      // The row stays 'received'; the worker sweep picks it up.
      this.logger.warn({ err: sanitizeMessage(err), eventId: row.id }, 'webhook enqueue failed');
    } finally {
      clearTimeout(timer);
    }
    return 'stored';
  }
}

/** Resolves a connection's open alerts: a reconnect or a disconnect answers them. */
async function resolveAlerts(tx: Tx, orgId: string, connectionId: string): Promise<void> {
  await tx
    .update(alerts)
    .set({ resolvedAt: new Date() })
    .where(
      and(
        eq(alerts.orgId, orgId),
        eq(alerts.storeConnectionId, connectionId),
        isNull(alerts.resolvedAt),
      ),
    );
}

/**
 * A reconnect makes any pending `app/uninstalled` event of the connection stale: retried later, it would
 * disconnect the reinstalled shop and wipe its new tokens. The worker locks the event row and stops unless it is
 * still `processing`, so this update and an in-flight uninstall serialize.
 */
async function retirePendingUninstalls(tx: Tx, orgId: string, connectionId: string): Promise<void> {
  await tx
    .update(webhookEvents)
    .set({ status: 'ignored', updatedAt: new Date() })
    .where(
      and(
        eq(webhookEvents.orgId, orgId),
        eq(webhookEvents.storeConnectionId, connectionId),
        eq(webhookEvents.topic, 'app/uninstalled'),
        inArray(webhookEvents.status, ['received', 'failed', 'processing']),
      ),
    );
}
