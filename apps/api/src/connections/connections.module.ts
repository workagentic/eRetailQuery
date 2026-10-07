import { Inject, Injectable, Module, OnApplicationShutdown, type Provider } from '@nestjs/common';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import type { Logger } from 'pino';
import {
  createFetchHttpClient,
  sanitizeMessage,
  shopifyConfigSchema,
  type ShopifyConfig,
} from '@erq/connectors';
import { createConnectionsApi, type TenantDb } from '@erq/db';
import { EnvKeyProvider, WEBHOOK_QUEUE } from '@erq/shared';
import { APP_CONFIG, LOGGER } from '../config/config.module';
import type { Env } from '../config/env';
import { TENANT_DB } from '../db/db.module';
import { ConnectionsController } from './connections.controller';
import { ConnectionsService } from './connections.service';
import { ShopifyCallbackController } from './shopify-callback.controller';
import { ShopifyPublicController } from './shopify-public.controller';
import {
  CONNECTIONS_API,
  HTTP_CLIENT,
  KEY_PROVIDER,
  SHOPIFY_CONFIG,
  SYNC_QUEUE_PORT,
  WEBHOOK_QUEUE_PORT,
} from './tokens';
import { BullMqSyncQueue, NoopSyncQueue, SYNC_QUEUE_NAME, type SyncQueuePort } from './sync-queue';
import { SyncStarter } from './sync-starter';
import { BullMqWebhookQueue, NoopWebhookQueue, type WebhookQueue } from './webhook-queue';

const REDIS_RESOURCES = Symbol('REDIS_RESOURCES');
interface RedisResources {
  connection: IORedis;
  queue: Queue;
  syncQueue: Queue;
}

@Injectable()
class RedisLifecycle implements OnApplicationShutdown {
  constructor(@Inject(REDIS_RESOURCES) private readonly res: RedisResources | null) {}
  async onApplicationShutdown(): Promise<void> {
    if (!this.res) return;
    await this.res.queue.close();
    await this.res.syncQueue.close();
    await this.res.connection.quit();
  }
}

const providers: Provider[] = [
  ConnectionsService,
  SyncStarter,
  RedisLifecycle,
  {
    provide: SHOPIFY_CONFIG,
    inject: [APP_CONFIG],
    useFactory: (env: Env): ShopifyConfig | null => {
      if (!env.SHOPIFY_API_KEY || !env.SHOPIFY_API_SECRET || !env.API_PUBLIC_URL) return null;
      const base = env.API_PUBLIC_URL.replace(/\/+$/, '');
      // Shopify redirects the browser to the web app, which forwards the query to the authenticated API callback.
      const web = env.WEB_PUBLIC_URL.replace(/\/+$/, '');
      return shopifyConfigSchema.parse({
        apiKey: env.SHOPIFY_API_KEY,
        apiSecret: env.SHOPIFY_API_SECRET,
        scopes: env.SHOPIFY_SCOPES.split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        redirectUri: `${web}/connections/shopify/callback`,
        webhookUrl: `${base}/webhooks/shopify`,
      });
    },
  },
  { provide: HTTP_CLIENT, useFactory: () => createFetchHttpClient() },
  {
    provide: KEY_PROVIDER,
    inject: [APP_CONFIG],
    useFactory: (env: Env): EnvKeyProvider | null =>
      env.ENCRYPTION_KEY_ID && env.ENCRYPTION_KEY
        ? EnvKeyProvider.fromEnv({
            ENCRYPTION_KEY_ID: env.ENCRYPTION_KEY_ID,
            ENCRYPTION_KEY: env.ENCRYPTION_KEY,
            ENCRYPTION_OLD_KEYS: env.ENCRYPTION_OLD_KEYS,
          })
        : null,
  },
  {
    provide: CONNECTIONS_API,
    inject: [TENANT_DB],
    useFactory: (db: TenantDb) => createConnectionsApi(db.pool),
  },
  {
    provide: REDIS_RESOURCES,
    inject: [APP_CONFIG, LOGGER],
    useFactory: (env: Env, logger: Logger): RedisResources | null => {
      if (!env.REDIS_URL) return null;
      // Producer settings: fail fast while Redis is down instead of queueing commands forever, so the webhook
      // receiver can still answer Shopify (the event row stays 'received' and the worker sweep recovers it).
      const connection = new IORedis(env.REDIS_URL, {
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
      });
      connection.on('error', (err) => logger.warn({ err: sanitizeMessage(err) }, 'redis error'));
      return {
        connection,
        queue: new Queue(WEBHOOK_QUEUE, { connection }),
        syncQueue: new Queue(SYNC_QUEUE_NAME, { connection }),
      };
    },
  },
  {
    provide: WEBHOOK_QUEUE_PORT,
    inject: [REDIS_RESOURCES],
    useFactory: (res: RedisResources | null): WebhookQueue =>
      res ? new BullMqWebhookQueue(res.queue) : new NoopWebhookQueue(),
  },
  {
    provide: SYNC_QUEUE_PORT,
    inject: [REDIS_RESOURCES],
    useFactory: (res: RedisResources | null): SyncQueuePort =>
      res ? new BullMqSyncQueue(res.syncQueue) : new NoopSyncQueue(),
  },
];

@Module({
  controllers: [ConnectionsController, ShopifyCallbackController, ShopifyPublicController],
  providers,
  exports: [
    SHOPIFY_CONFIG,
    HTTP_CLIENT,
    KEY_PROVIDER,
    CONNECTIONS_API,
    WEBHOOK_QUEUE_PORT,
    ConnectionsService,
  ],
})
export class ConnectionsModule {}
