import { describe, expect, it } from 'vitest';
import { SYNC_RESOURCES, type SyncResource } from '../normalized';
import type { ConnectionContext, Page, StoreConnector } from '../types';

export interface ContractSubject {
  name: string;
  create(): { connector: StoreConnector; ctx: ConnectionContext };
}

const KEYS = {
  locations: ['externalId', 'name', 'type', 'address', 'isActive'],
  products: ['externalId', 'title', 'brand', 'category', 'status', 'updatedAt', 'variants'],
  variant: [
    'externalId',
    'skuCode',
    'barcode',
    'priceCents',
    'compareAtPriceCents',
    'currency',
    'unitCostCents',
    'updatedAt',
  ],
  inventory: [
    'externalVariantId',
    'locationExternalId',
    'onHand',
    'reserved',
    'incoming',
    'updatedAt',
  ],
  orders: [
    'externalId',
    'channel',
    'status',
    'placedAt',
    'cancelledAt',
    'currency',
    'grossCents',
    'discountCents',
    'shippingChargedCents',
    'taxCents',
    'customerExternalId',
    'utmSource',
    'utmMedium',
    'utmCampaign',
    'landingSite',
    'isTest',
    'updatedAt',
    'lines',
    'refunds',
  ],
  line: [
    'externalLineId',
    'externalVariantId',
    'title',
    'quantity',
    'unitPriceCents',
    'discountCents',
  ],
  refund: ['externalId', 'refundedAt', 'amountCents', 'shippingRefundCents', 'restock', 'lines'],
  refundLine: ['externalLineId', 'quantity', 'amountCents'],
} as const;

const onlyKeys = (obj: object, allowed: readonly string[], label: string) =>
  expect(Object.keys(obj).sort(), `${label} has unexpected or missing fields`).toEqual(
    [...allowed].sort(),
  );
const nonEmpty = (v: unknown, label: string) =>
  expect(typeof v === 'string' && v.length > 0, `${label} must be a non-empty string`).toBe(true);
const date = (v: unknown, label: string) =>
  expect(v instanceof Date && !Number.isNaN(v.getTime()), `${label} must be a valid Date`).toBe(
    true,
  );
const cents = (v: unknown, label: string, min = 0) =>
  expect(
    Number.isSafeInteger(v) && (v as number) >= min,
    `${label} must be an integer >= ${min}`,
  ).toBe(true);

type Item = Record<string, unknown> & { externalId?: string };
const unique = (ids: unknown[], label: string) =>
  expect(new Set(ids).size, `${label} must be unique`).toBe(ids.length);

/** Throws on any violation of the normalized shape. Exported so tests can prove the rules bite. */
export function validateNormalizedItem(resource: SyncResource, item: unknown): void {
  expect(
    item !== null && typeof item === 'object' && !Array.isArray(item),
    'item must be an object',
  ).toBe(true);
  const i = item as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- structural checks on untyped connector output
  if (resource === 'locations') {
    onlyKeys(i, KEYS.locations, 'location');
    nonEmpty(i.externalId, 'location.externalId');
    nonEmpty(i.name, 'location.name');
    expect(['warehouse', 'store', '3pl', 'fba', 'other']).toContain(i.type);
    expect(typeof i.isActive, 'location.isActive must be a boolean').toBe('boolean');
  } else if (resource === 'products') {
    onlyKeys(i, KEYS.products, 'product');
    nonEmpty(i.externalId, 'product.externalId');
    nonEmpty(i.title, 'product.title');
    date(i.updatedAt, 'product.updatedAt');
    expect(['active', 'draft', 'archived']).toContain(i.status);
    expect(Array.isArray(i.variants), 'product.variants must be an array').toBe(true);
    unique(
      i.variants.map((v: { externalId: string }) => v.externalId),
      'variant ids in a product',
    );
    for (const v of i.variants) {
      onlyKeys(v, KEYS.variant, 'variant');
      nonEmpty(v.externalId, 'variant.externalId');
      cents(v.priceCents, 'variant.priceCents');
      date(v.updatedAt, 'variant.updatedAt');
      expect(v.currency).toMatch(/^[A-Z]{3}$/);
      if (v.unitCostCents !== null) cents(v.unitCostCents, 'variant.unitCostCents');
    }
  } else if (resource === 'inventory') {
    onlyKeys(i, KEYS.inventory, 'inventory level');
    nonEmpty(i.externalVariantId, 'level.externalVariantId');
    nonEmpty(i.locationExternalId, 'level.locationExternalId');
    expect(Number.isSafeInteger(i.onHand)).toBe(true);
    cents(i.reserved, 'level.reserved');
    cents(i.incoming, 'level.incoming');
    date(i.updatedAt, 'level.updatedAt');
  } else {
    onlyKeys(i, KEYS.orders, 'order');
    nonEmpty(i.externalId, 'order.externalId');
    date(i.placedAt, 'order.placedAt');
    date(i.updatedAt, 'order.updatedAt');
    expect(['shopify_online', 'shopify_pos']).toContain(i.channel);
    expect(['open', 'closed', 'cancelled']).toContain(i.status);
    expect(i.currency).toMatch(/^[A-Z]{3}$/);
    for (const k of ['grossCents', 'discountCents', 'shippingChargedCents', 'taxCents'])
      cents(i[k], `order.${k}`);
    expect(Array.isArray(i.lines), 'order.lines must be an array').toBe(true);
    expect(Array.isArray(i.refunds), 'order.refunds must be an array').toBe(true);
    unique(
      i.lines.map((l: { externalLineId: string }) => l.externalLineId),
      'line ids in an order',
    );
    unique(
      i.refunds.map((r: { externalId: string }) => r.externalId),
      'refund ids in an order',
    );
    for (const l of i.lines) {
      onlyKeys(l, KEYS.line, 'order line');
      nonEmpty(l.externalLineId, 'line.externalLineId');
      cents(l.quantity, 'line.quantity', 1);
      cents(l.unitPriceCents, 'line.unitPriceCents');
      expect(
        l.title === null || typeof l.title === 'string',
        'line.title must be a string or null',
      ).toBe(true);
      cents(l.discountCents, 'line.discountCents');
      expect(
        l.discountCents <= l.quantity * l.unitPriceCents,
        'line.discountCents must not exceed the line total',
      ).toBe(true);
    }
    for (const r of i.refunds) {
      onlyKeys(r, KEYS.refund, 'refund');
      nonEmpty(r.externalId, 'refund.externalId');
      date(r.refundedAt, 'refund.refundedAt');
      cents(r.amountCents, 'refund.amountCents');
      cents(r.shippingRefundCents, 'refund.shippingRefundCents');
      expect(typeof r.restock, 'refund.restock must be a boolean').toBe('boolean');
      expect(Array.isArray(r.lines), 'refund.lines must be an array').toBe(true);
      for (const rl of r.lines) {
        onlyKeys(rl, KEYS.refundLine, 'refund line');
        nonEmpty(rl.externalLineId, 'refundLine.externalLineId');
        cents(rl.amountCents, 'refundLine.amountCents');
        cents(rl.quantity, 'refundLine.quantity', 1);
      }
    }
  }
}

/** Every store connector (fake now, Shopify in 1b-3) must pass this suite. */
export function runConnectorContract(subject: ContractSubject): void {
  describe(`connector contract: ${subject.name}`, () => {
    for (const resource of SYNC_RESOURCES) {
      it(`${resource}: pages are finite, cursors advance, items are normalized and unique`, async () => {
        const { connector, ctx } = subject.create();
        const seenCursors = new Set<string>();
        const ids = new Set<string>();
        let cursor: string | null = null;
        let pages = 0;
        do {
          const page: Page<unknown> = await connector.fetchPage(ctx, resource, cursor, {});
          expect(Array.isArray(page.items)).toBe(true);
          for (const item of page.items as unknown as Item[]) {
            validateNormalizedItem(resource, item);
            const id =
              resource === 'inventory'
                ? `${(item as { externalVariantId: string }).externalVariantId}@${(item as { locationExternalId: string }).locationExternalId}`
                : (item.externalId as string);
            expect(ids.has(id), `duplicate item ${id}`).toBe(false);
            ids.add(id);
          }
          if (page.nextCursor !== null) {
            nonEmpty(page.nextCursor, 'nextCursor');
            expect(seenCursors.has(page.nextCursor), 'cursor repeated').toBe(false);
            seenCursors.add(page.nextCursor);
          }
          cursor = page.nextCursor;
          pages++;
          expect(pages).toBeLessThan(500);
        } while (cursor !== null);
        expect(ids.size).toBeGreaterThan(0);
      });
    }
    for (const resource of ['products', 'inventory', 'orders'] as const) {
      it(`${resource}: an updatedSince in the future returns nothing`, async () => {
        const { connector, ctx } = subject.create();
        const page = await connector.fetchPage(ctx, resource, null, {
          updatedSince: new Date('2999-01-01T00:00:00Z'),
        });
        expect(page.items).toEqual([]);
        expect(page.nextCursor).toBeNull();
      });
    }
  });
}
