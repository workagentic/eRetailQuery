import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTenantDb, type TenantDb } from '../src';
import { startTestDatabase, type TestDatabase } from '../src/testing';
import { fixtures } from './fixtures';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
let tdb: TestDatabase;
let owner: Pool;
let db: TenantDb;

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new Pool({ connectionString: tdb.ownerUrl });
  for (const org of [A, B]) for (const f of Object.values(fixtures)) await f(owner, org);
  db = createTenantDb(tdb.appUrl);
});
afterAll(async () => {
  await db?.close();
  await owner?.end();
  await tdb?.stop();
});

const fk = { cause: { message: expect.stringMatching(/foreign key constraint/) } };
const asB = (text: string) => db.withTenant(B, (tx) => tx.execute(sql.raw(text)));
const orderInsert = (id: string, ext: string, extra = '') =>
  `insert into orders (org_id, store_connection_id, external_order_id, channel, status, placed_at, currency, gross_cents, discount_cents,
     shipping_charged_cents, tax_cents, refund_cents, net_cents, external_updated_at ${extra ? ',' + extra.split('=')[0] : ''})
   values ('${id}', '${id}', '${ext}', 'shopify_pos', 'open', now(), 'USD', 100, 0, 0, 0, 0, 100, now() ${extra ? ',' + extra.split('=')[1] : ''})`;

describe('orders', () => {
  it('stores the POS channel, allows negative net sales, rejects negative money fields', async () => {
    await owner.query(orderInsert(A, 'pos-1'));
    await owner.query(
      `insert into orders (org_id, store_connection_id, external_order_id, channel, status, placed_at, currency, gross_cents,
      discount_cents, shipping_charged_cents, tax_cents, refund_cents, net_cents, external_updated_at)
      values ($1, $1, 'neg-net', 'shopify_online', 'closed', now(), 'USD', 100, 0, 0, 0, 500, -400, now())`,
      [A],
    );
    await expect(
      owner.query(
        `insert into orders (org_id, store_connection_id, external_order_id, channel, status, placed_at, currency, gross_cents,
      discount_cents, shipping_charged_cents, tax_cents, refund_cents, net_cents, external_updated_at)
      values ($1, $1, 'neg-money', 'shopify_online', 'open', now(), 'USD', 100, -1, 0, 0, 0, 100, now())`,
        [A],
      ),
    ).rejects.toThrow(/orders_money_nonneg/);
  });
  it('is unique per connection and external order id', async () => {
    await expect(owner.query(orderInsert(A, 'pos-1'))).rejects.toThrow(
      /orders_external_uq|duplicate key/,
    );
  });
  it('rejects unknown channels and statuses', async () => {
    await expect(
      owner.query(orderInsert(A, 'x').replace('shopify_pos', 'carrier_pigeon')),
    ).rejects.toThrow(/invalid input value for enum/);
  });
  it("a tenant-B order cannot use tenant A's store connection", async () => {
    await expect(
      asB(orderInsert(B, 'ok').replace(`'${B}', 'ok'`, `'${A}', 'ok'`)),
    ).rejects.toMatchObject(fk);
  });
});

describe('order_lines', () => {
  it('requires a positive quantity and refunded_quantity within quantity', async () => {
    await expect(
      owner.query(
        `insert into order_lines (org_id, order_id, sku_id, external_line_id, title, quantity, unit_price_cents) values ($1, $1, $1, 'q0', 'x', 0, 1)`,
        [A],
      ),
    ).rejects.toThrow(/order_lines_quantity_positive/);
    await expect(
      owner.query(
        `insert into order_lines (org_id, order_id, sku_id, external_line_id, title, quantity, unit_price_cents, refunded_quantity) values ($1, $1, $1, 'q1', 'x', 1, 1, 2)`,
        [A],
      ),
    ).rejects.toThrow(/order_lines_refunded_within_quantity/);
  });
  it('allows an unmapped (null) sku and rejects negative money', async () => {
    await owner.query(
      `insert into order_lines (org_id, order_id, sku_id, external_line_id, title, quantity, unit_price_cents) values ($1, $1, null, 'unmapped', 'x', 1, 1)`,
      [A],
    );
    await expect(
      owner.query(
        `insert into order_lines (org_id, order_id, external_line_id, title, quantity, unit_price_cents, unit_cogs_cents_snapshot) values ($1, $1, 'negc', 'x', 1, 1, -1)`,
        [A],
      ),
    ).rejects.toThrow(/check/);
  });
  it('is unique per order and external line id', async () => {
    await expect(
      owner.query(
        `insert into order_lines (org_id, order_id, external_line_id, title, quantity, unit_price_cents) values ($1, $1, 'line-1', 'x', 1, 1)`,
        [A],
      ),
    ).rejects.toThrow(/order_lines_external_uq|duplicate key/);
  });
  it("a tenant-B line cannot use tenant A's order or sku", async () => {
    await expect(
      asB(
        `insert into order_lines (org_id, order_id, sku_id, external_line_id, title, quantity, unit_price_cents) values ('${B}', '${A}', '${B}', 'zz', 'x', 1, 1)`,
      ),
    ).rejects.toMatchObject(fk);
    await expect(
      asB(
        `insert into order_lines (org_id, order_id, sku_id, external_line_id, title, quantity, unit_price_cents) values ('${B}', '${B}', '${A}', 'zy', 'x', 1, 1)`,
      ),
    ).rejects.toMatchObject(fk);
  });
});

describe('refunds and refund_lines', () => {
  it('are unique per order/refund and per refund/line, with positive quantities', async () => {
    await expect(
      owner.query(
        `insert into refunds (org_id, order_id, external_refund_id, refunded_at, amount_cents) values ($1, $1, 'r-1', now(), 1)`,
        [A],
      ),
    ).rejects.toThrow(/refunds_external_uq|duplicate key/);
    await expect(
      owner.query(
        `insert into refund_lines (org_id, refund_id, order_line_id, quantity, amount_cents) values ($1, $1, $1, 1, 1)`,
        [A],
      ),
    ).rejects.toThrow(/refund_lines_uq|duplicate key/);
    await expect(
      owner.query(
        `insert into refund_lines (org_id, refund_id, order_line_id, quantity, amount_cents) values ($1, $1, $1, 0, 1)`,
        [B],
      ),
    ).rejects.toThrow(/duplicate key|refund_lines_quantity_positive/);
  });
  it("a tenant-B refund cannot reference tenant A's order", async () => {
    await expect(
      asB(
        `insert into refunds (org_id, order_id, external_refund_id, refunded_at, amount_cents) values ('${B}', '${A}', 'rx', now(), 1)`,
      ),
    ).rejects.toMatchObject(fk);
  });
});

describe('sync_cursors', () => {
  it('is unique per connection and resource and rejects unknown resources', async () => {
    await expect(
      owner.query(
        `insert into sync_cursors (org_id, store_connection_id, resource, status) values ($1, $1, 'orders', 'idle')`,
        [A],
      ),
    ).rejects.toThrow(/sync_cursors_uq|duplicate key/);
    await expect(
      owner.query(
        `insert into sync_cursors (org_id, store_connection_id, resource, status) values ($1, $1, 'customers', 'idle')`,
        [A],
      ),
    ).rejects.toThrow(/invalid input value for enum/);
    await owner.query(
      `insert into sync_cursors (org_id, store_connection_id, resource, status) values ($1, $1, 'products', 'idle')`,
      [A],
    );
  });
});

describe('app_list_stalled_sync_cursors (the only cross-tenant read)', () => {
  beforeAll(async () => {
    // Backdate with INSERT: the updated_at trigger overwrites updated_at on UPDATE.
    for (const org of [A, B]) {
      await owner.query(
        `insert into sync_cursors (org_id, store_connection_id, resource, status, current_sync_run_id, updated_at)
         values ($1, $1, 'locations', 'running', gen_random_uuid(), now() - interval '2 hours')`,
        [org],
      );
    }
    await owner.query(
      `insert into sync_cursors (org_id, store_connection_id, resource, status, updated_at) values ($1, $1, 'inventory', 'idle', now() - interval '2 hours')`,
      [A],
    );
  });
  it('lists running cursors older than the threshold across tenants, for app_user', async () => {
    const app = new Pool({ connectionString: tdb.appUrl });
    try {
      const { rows } = await app.query(
        `select * from app_list_stalled_sync_cursors(now() - interval '1 hour')`,
      );
      expect(rows.map((r) => r.o_org_id).sort()).toEqual([A, B].sort());
      expect(rows.every((r) => r.o_resource === 'locations' && r.o_sync_run_id)).toBe(true);
      const none = await app.query(
        `select * from app_list_stalled_sync_cursors(now() - interval '3 hours')`,
      );
      expect(none.rows).toEqual([]);
    } finally {
      await app.end();
    }
  });
  it('is not executable by PUBLIC', async () => {
    const { rows } = await owner.query(
      `select has_function_privilege('public', 'app_list_stalled_sync_cursors(timestamptz)', 'execute') as ok`,
    );
    expect(rows[0].ok).toBe(false);
  });
});
