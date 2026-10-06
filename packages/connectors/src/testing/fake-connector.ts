import { PermanentError } from '../errors';
import type {
  NormalizedInventoryLevel,
  NormalizedLocation,
  NormalizedOrder,
  NormalizedProduct,
  SyncResource,
} from '../normalized';
import type {
  Connection,
  ConnectionContext,
  FetchOptions,
  Page,
  ResourceItems,
  StoreConnector,
} from '../types';

export interface FakeData {
  locations: NormalizedLocation[];
  products: NormalizedProduct[];
  inventory: NormalizedInventoryLevel[];
  orders: NormalizedOrder[];
}
export interface FakeCall {
  resource: SyncResource;
  cursor: string | null;
  options: FetchOptions;
  credentials: unknown;
}

/** In-memory connector for tests: deterministic pages, scripted failures, call recording. */
export class FakeConnector implements StoreConnector {
  readonly calls: FakeCall[] = [];
  private readonly failures: Error[] = [];

  constructor(
    public data: FakeData,
    private readonly pageSize = 2,
  ) {}

  /** The next `times` fetchPage calls throw `error`. */
  failNext(error: Error, times = 1): void {
    for (let i = 0; i < times; i++) this.failures.push(error);
  }

  async connect(): Promise<Connection> {
    return { id: 'fake', externalAccountId: 'fake-shop' };
  }

  async handleWebhook(): Promise<void> {}

  async fetchPage<R extends SyncResource>(
    ctx: ConnectionContext,
    resource: R,
    cursor: string | null,
    options: FetchOptions,
  ): Promise<Page<ResourceItems[R]>> {
    this.calls.push({ resource, cursor, options, credentials: ctx.credentials });
    const failure = this.failures.shift();
    if (failure) throw failure;

    const start = cursor === null ? 0 : Number(cursor);
    if (!Number.isSafeInteger(start) || start < 0)
      throw new PermanentError(`invalid cursor ${cursor}`);

    let all = this.data[resource] as unknown as Array<{ updatedAt?: Date; placedAt?: Date }>;
    const { updatedSince, since } = options;
    if (updatedSince)
      all = all.filter((i) => i.updatedAt === undefined || i.updatedAt >= updatedSince);
    if (since && resource === 'orders')
      all = all.filter((i) => i.placedAt === undefined || i.placedAt >= since);

    const next = start + this.pageSize;
    return {
      items: all.slice(start, next) as unknown as ResourceItems[R][],
      nextCursor: next < all.length ? String(next) : null,
      cost: 1,
    };
  }
}
