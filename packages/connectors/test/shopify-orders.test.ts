import { describe, expect, it } from 'vitest';
import {
  createShopifyGraphqlClient,
  decodeCursor,
  fetchOrders,
  MAX_EXTRA_PAGES,
  normalizeOrder,
  ORDER_LINES_EXTRA_PAGE_SIZE,
  ORDER_REFUNDS_MAX,
  REFUND_LINES_EXTRA_PAGE_SIZE,
  REFUND_SHIPPING_EXTRA_PAGE_SIZE,
  TransientError,
  ORDER_LINES_INLINE,
  ORDER_REFUNDS_INLINE,
  ORDERS_PAGE_SIZE,
  PermanentError,
  REFUND_LINES_INLINE,
  REFUND_SHIPPING_INLINE,
} from '../src';
import {
  FakeShopifyAdmin,
  gqlOk,
  orderLinesQueryCost,
  orderRefundsQueryCost,
  refundLinesQueryCost,
  refundShippingQueryCost,
  ordersQueryCost,
  paginate,
} from '../src/testing';

const ctx = { externalAccountId: 'a.myshopify.com', credentials: { accessToken: 'shpat_x' } };
const UNEXPECTED = 'Shopify returned an unexpected response.';
const MIXED = 'Shopify returned mixed currencies for one order.';
const money = (amount: string, code = 'USD') => ({ shopMoney: { amount, currencyCode: code } });
const gid = (kind: string, n: number | string) => `gid://shopify/${kind}/${n}`;
const line = (
  n: number,
  qty: number,
  unit: string,
  discount = '0.00',
  variant: number | null = n,
  code = 'USD',
) => ({
  id: gid('LineItem', n),
  title: `Item ${n}`,
  quantity: qty,
  variant: variant === null ? null : { id: gid('ProductVariant', variant) },
  originalUnitPriceSet: money(unit, code),
  totalDiscountSet: money(discount, code),
});
const refundLine = (n: number, qty: number, subtotal: string, restockType = 'RETURN') => ({
  quantity: qty,
  restockType,
  lineItem: { id: gid('LineItem', n) },
  subtotalSet: money(subtotal),
});
const inline = (nodes: unknown[], size: number) => {
  const more = nodes.length > size;
  return {
    nodes: nodes.slice(0, size),
    pageInfo: { hasNextPage: more, endCursor: more ? String(size - 1) : null },
  };
};
const shippingNode = (amount: string) => ({ subtotalAmountSet: money(amount) });
const refund = (
  n: number,
  lines: unknown[],
  total: string,
  shipping: string[] = [],
  over: Record<string, unknown> = {},
) => ({
  id: gid('Refund', n),
  createdAt: '2026-03-03T10:00:00Z',
  totalRefundedSet: money(total),
  refundLineItems: inline(lines, REFUND_LINES_INLINE),
  refundShippingLines: inline(shipping.map(shippingNode), REFUND_SHIPPING_INLINE),
  ...over,
});
/** Follow-up handlers over the complete data; cursors are indexes, matching `inline` above. */
const refundsHandler = (all: unknown[]) => (v: Record<string, unknown>) =>
  gqlOk({ order: { refunds: all.slice(0, v.first as number) } });
const refundConnHandler =
  (field: 'refundLineItems' | 'refundShippingLines', byRefund: Record<string, unknown[]>) =>
  (v: Record<string, unknown>) =>
    gqlOk({
      node: {
        [field]: paginate(
          byRefund[v.id as string]!,
          v.first as number,
          (v.after as string | null) ?? null,
        ),
      },
    });
const connection = (nodes: unknown[]) => {
  const more = nodes.length > ORDER_LINES_INLINE;
  return {
    nodes: nodes.slice(0, ORDER_LINES_INLINE),
    pageInfo: { hasNextPage: more, endCursor: more ? String(ORDER_LINES_INLINE - 1) : null },
  };
};
const order = (n: number, over: Record<string, unknown> = {}) => {
  const lines = (over.lines as unknown[] | undefined) ?? [line(1, 1, '10.00')];
  const rest = Object.fromEntries(Object.entries(over).filter(([k]) => k !== 'lines'));
  const hour = String(10 + (n % 10)).padStart(2, '0');
  return {
    id: gid('Order', n),
    createdAt: `2026-03-01T${hour}:00:00Z`,
    updatedAt: `2026-03-02T${hour}:00:00Z`,
    cancelledAt: null as string | null,
    closedAt: null as string | null,
    test: false,
    taxesIncluded: false,
    sourceName: 'web' as string | null,
    totalDiscountsSet: money('0.00'),
    totalTaxSet: money('0.00'),
    totalShippingPriceSet: money('0.00'),
    lineItems: connection(lines),
    refunds: [] as unknown[],
    ...rest,
  };
};

type OrderNode = ReturnType<typeof order>;
const ordersHandler =
  (items: OrderNode[], seen: Record<string, unknown>[] = []) =>
  (v: Record<string, unknown>) => {
    seen.push(v);
    let list = items;
    const q = v.query as string | null;
    const m = q ? /^(created|updated)_at:>='(.+)'$/.exec(q) : null;
    if (m) {
      const key = m[1] === 'created' ? 'createdAt' : 'updatedAt';
      const since = new Date(m[2]!).getTime();
      list = items.filter((o) => new Date(o[key]).getTime() >= since);
    }
    return gqlOk(
      { orders: paginate(list, v.first as number, (v.after as string | null) ?? null) },
      {
        requested: ordersQueryCost(
          v.first as number,
          ORDER_LINES_INLINE,
          ORDER_REFUNDS_INLINE + 1,
          REFUND_LINES_INLINE,
          REFUND_SHIPPING_INLINE,
        ),
      },
    );
  };
const linesHandler = (all: unknown[]) => (v: Record<string, unknown>) =>
  gqlOk({
    order: { lineItems: paginate(all, v.first as number, (v.after as string | null) ?? null) },
  });
const gqlOf = (admin: FakeShopifyAdmin) => createShopifyGraphqlClient({ http: admin });
const fetchOne = (node: unknown) => {
  const admin = new FakeShopifyAdmin().on('ErqOrders', ordersHandler([node as OrderNode]));
  return fetchOrders(gqlOf(admin), ctx, null, {});
};
const failureOf = async (p: Promise<unknown>): Promise<string> => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PermanentError);
  return (err as PermanentError).message;
};

const transientOf = async (p: Promise<unknown>): Promise<string> => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(TransientError);
  return (err as TransientError).message;
};
const sentBody = (admin: FakeShopifyAdmin, name: string) => {
  const req = admin.requests.find((r) => JSON.parse(r.body!).operationName === name);
  if (!req) throw new Error(`no ${name} request`);
  return JSON.parse(req.body!) as { query: string; variables: { first: number } };
};
const sizeIn = (query: string, field: string): number => {
  const m = new RegExp(`${field}\\(first: (\\d+)`).exec(query);
  if (!m) throw new Error(`no first on ${field}`);
  return Number(m[1]);
};

describe('orders', () => {
  it('maps a plain online order with exact cents and no protected data', async () => {
    const page = await fetchOne(
      order(1, {
        lines: [line(1, 2, '19.99', '3.00'), line(2, 1, '5.00', '1.00')],
        totalDiscountsSet: money('4.00'),
        totalShippingPriceSet: money('4.99'),
        totalTaxSet: money('3.20'),
      }),
    );
    expect(page.items).toHaveLength(1);
    const o = page.items[0]!;
    expect(o).toMatchObject({
      externalId: gid('Order', 1),
      channel: 'shopify_online',
      status: 'open',
      currency: 'USD',
      grossCents: 4498, // 2 x 19.99 + 1 x 5.00 (the brief's 4998 was an arithmetic slip)
      discountCents: 400,
      shippingChargedCents: 499,
      taxCents: 320,
      isTest: false,
      cancelledAt: null,
      customerExternalId: null,
      utmSource: null,
      utmMedium: null,
      utmCampaign: null,
      landingSite: null,
      refunds: [],
    });
    expect(o.placedAt).toEqual(new Date('2026-03-01T11:00:00Z'));
    expect(o.updatedAt).toEqual(new Date('2026-03-02T11:00:00Z'));
    expect(o.lines).toEqual([
      {
        externalLineId: gid('LineItem', 1),
        externalVariantId: gid('ProductVariant', 1),
        title: 'Item 1',
        quantity: 2,
        unitPriceCents: 1999,
        discountCents: 300,
      },
      {
        externalLineId: gid('LineItem', 2),
        externalVariantId: gid('ProductVariant', 2),
        title: 'Item 2',
        quantity: 1,
        unitPriceCents: 500,
        discountCents: 100,
      },
    ]);
  });

  it('maps POS, test, cancelled and closed orders', async () => {
    const admin = new FakeShopifyAdmin().on(
      'ErqOrders',
      ordersHandler([
        order(1, { sourceName: 'pos' }),
        order(2, { test: true }),
        order(3, { cancelledAt: '2026-03-05T00:00:00Z', closedAt: '2026-03-06T00:00:00Z' }),
        order(4, { closedAt: '2026-03-06T00:00:00Z' }),
      ]),
    );
    const first = await fetchOrders(gqlOf(admin), ctx, null, {});
    const second = await fetchOrders(gqlOf(admin), ctx, first.nextCursor, {});
    const [pos, test, cancelled, closed] = [...first.items, ...second.items];
    expect([pos!.channel, pos!.status]).toEqual(['shopify_pos', 'open']);
    expect([test!.isTest, test!.channel]).toEqual([true, 'shopify_online']);
    expect(cancelled!.status).toBe('cancelled');
    expect(cancelled!.cancelledAt).toEqual(new Date('2026-03-05T00:00:00Z'));
    expect(closed!.status).toBe('closed');
    expect(closed!.cancelledAt).toBeNull();
  });

  it('degrades unknown or missing source names and restock types instead of throwing', async () => {
    const odd = await fetchOne(
      order(1, {
        sourceName: 'some_future_channel',
        refunds: [refund(1, [refundLine(1, 1, '5.00', 'SOME_NEW_TYPE')], '5.00')],
      }),
    );
    expect(odd.items[0]!.channel).toBe('shopify_online');
    // An unrecognised restock type counts as a restock; it must never be an error.
    expect(odd.items[0]!.refunds[0]!.restock).toBe(true);
    const none = await fetchOne(order(2, { sourceName: null }));
    expect(none.items[0]!.channel).toBe('shopify_online');
  });

  it('maps partial refunds: line sums, shipping and restock flag', async () => {
    const page = await fetchOne(
      order(1, {
        lines: [line(1, 3, '19.99'), line(2, 3, '5.00')],
        refunds: [
          refund(1, [refundLine(1, 1, '19.99'), refundLine(2, 2, '10.00')], '40.00', ['4.99']),
          refund(2, [refundLine(1, 1, '19.99', 'NO_RESTOCK')], '19.99'),
          refund(3, [], '10.00', ['2.00']),
          refund(4, [refundLine(1, 0, '9.99'), refundLine(2, 1, '5.00')], '5.00'),
        ],
      }),
    );
    const [a, b, c, d] = page.items[0]!.refunds;
    expect(a).toEqual({
      externalId: gid('Refund', 1),
      refundedAt: new Date('2026-03-03T10:00:00Z'),
      amountCents: 2999,
      shippingRefundCents: 499,
      restock: true,
      lines: [
        { externalLineId: gid('LineItem', 1), quantity: 1, amountCents: 1999 },
        { externalLineId: gid('LineItem', 2), quantity: 2, amountCents: 1000 },
      ],
    });
    expect(b!.restock).toBe(false);
    expect(c).toMatchObject({ amountCents: 800, shippingRefundCents: 200, lines: [] });
    expect(d!.lines).toEqual([
      { externalLineId: gid('LineItem', 2), quantity: 1, amountCents: 500 },
    ]);
    expect(d!.amountCents).toBe(500);
  });

  it('never lets a refund without lines go negative', () => {
    const node = order(1, { refunds: [refund(1, [], '1.00', ['2.00'])] });
    const o = normalizeOrder(node as never, node.lineItems.nodes as never);
    expect(o.refunds[0]!.amountCents).toBe(0);
  });

  it('keeps exact minor units for zero and three decimal currencies', async () => {
    const jpy = await fetchOne(
      order(1, {
        lines: [line(1, 2, '1500', '0', 1, 'JPY')],
        totalTaxSet: money('273', 'JPY'),
        totalShippingPriceSet: money('0', 'JPY'),
        totalDiscountsSet: money('0', 'JPY'),
      }),
    );
    expect(jpy.items[0]).toMatchObject({
      currency: 'JPY',
      grossCents: 3000,
      taxCents: 273,
      shippingChargedCents: 0,
    });
    const kwd = await fetchOne(
      order(2, {
        lines: [line(1, 3, '12.345', '0.500', 1, 'KWD')],
        totalTaxSet: money('1.234', 'KWD'),
        totalShippingPriceSet: money('2.500', 'KWD'),
        totalDiscountsSet: money('0.500', 'KWD'),
      }),
    );
    expect(kwd.items[0]).toMatchObject({
      currency: 'KWD',
      grossCents: 37035,
      taxCents: 1234,
      shippingChargedCents: 2500,
      discountCents: 500,
    });
    expect(kwd.items[0]!.lines[0]!.discountCents).toBe(500);
  });

  it('fails on mixed currencies inside one order', async () => {
    const shipping = order(1, { totalShippingPriceSet: money('1.00', 'CAD') });
    expect(await failureOf(fetchOne(shipping))).toBe(MIXED);
    const lineMix = order(2, { lines: [line(1, 1, '1.00', '0', 1, 'EUR')] });
    expect(await failureOf(fetchOne(lineMix))).toBe(MIXED);
    const refundMix = order(3, {
      refunds: [{ ...refund(1, [], '1.00'), totalRefundedSet: money('1.00', 'GBP') }],
    });
    expect(await failureOf(fetchOne(refundMix))).toBe(MIXED);
  });

  it('clamps a negative order amount to 0 without failing', async () => {
    const page = await fetchOne(
      order(1, { totalDiscountsSet: money('-2.00'), totalShippingPriceSet: money('-1.00') }),
    );
    expect(page.items[0]).toMatchObject({ discountCents: 0, shippingChargedCents: 0 });
  });

  it('clamps a line discount to the line total and drops zero quantity lines', async () => {
    const page = await fetchOne(
      order(1, {
        lines: [line(1, 2, '5.00', '99.00'), line(2, 0, '9.00'), line(3, 1, '1.00', '-1')],
      }),
    );
    const lines = page.items[0]!.lines;
    expect(lines.map((l) => [l.externalLineId, l.discountCents])).toEqual([
      [gid('LineItem', 1), 1000],
      [gid('LineItem', 3), 0],
    ]);
    expect(page.items[0]!.grossCents).toBe(1100);
  });

  it('rejects an invalid line quantity', async () => {
    expect(await failureOf(fetchOne(order(1, { lines: [line(1, -1, '1.00')] })))).toBe(UNEXPECTED);
    expect(await failureOf(fetchOne(order(2, { lines: [line(1, 1.5, '1.00')] })))).toBe(UNEXPECTED);
  });

  it('pages by the orders page size and round-trips the cursor', async () => {
    const total = ORDERS_PAGE_SIZE * 20 + 1;
    const items = Array.from({ length: total }, (_, i) => order(i + 1));
    const admin = new FakeShopifyAdmin().on('ErqOrders', ordersHandler(items));
    let cursor: string | null = null;
    const sizes: number[] = [];
    let firstCursor: string | null = null;
    do {
      const page: Awaited<ReturnType<typeof fetchOrders>> = await fetchOrders(
        gqlOf(admin),
        ctx,
        cursor,
        {},
      );
      if (cursor === null) firstCursor = page.nextCursor;
      sizes.push(page.items.length);
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(decodeCursor(firstCursor)).toBe(String(ORDERS_PAGE_SIZE - 1));
    expect(sizes).toHaveLength(21);
    expect(sizes.slice(0, -1).every((s) => s === ORDERS_PAGE_SIZE)).toBe(true);
    expect(sizes[sizes.length - 1]).toBe(1);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(total);
  });

  it('sends created_at for backfill, updated_at for incremental, no filter otherwise', async () => {
    const seen: Record<string, unknown>[] = [];
    const admin = new FakeShopifyAdmin().on('ErqOrders', ordersHandler([], seen));
    await fetchOrders(gqlOf(admin), ctx, null, { since: new Date('2026-01-01T00:00:00Z') });
    await fetchOrders(gqlOf(admin), ctx, null, {
      updatedSince: new Date('2026-02-03T04:05:06.000Z'),
    });
    await fetchOrders(gqlOf(admin), ctx, null, {});
    expect(seen.map((v) => [v.sortKey, v.query])).toEqual([
      ['CREATED_AT', "created_at:>='2026-01-01T00:00:00.000Z'"],
      ['UPDATED_AT', "updated_at:>='2026-02-03T04:05:06.000Z'"],
      ['CREATED_AT', null],
    ]);
  });

  it('returns only orders matching the incremental filter', async () => {
    const items = [order(1, { updatedAt: '2026-01-01T00:00:00Z' }), order(2), order(3)];
    const admin = new FakeShopifyAdmin().on('ErqOrders', ordersHandler(items));
    const page = await fetchOrders(gqlOf(admin), ctx, null, {
      updatedSince: new Date('2026-02-01T00:00:00Z'),
    });
    expect(page.items.map((o) => o.externalId)).toEqual([gid('Order', 2), gid('Order', 3)]);
  });

  it('fetches the remaining lines of a large order and keeps ids unique', async () => {
    const total = ORDER_LINES_INLINE + 2 * ORDER_LINES_EXTRA_PAGE_SIZE;
    const all = Array.from({ length: total }, (_, i) => line(i + 1, 1, '1.00'));
    const admin = new FakeShopifyAdmin()
      .on('ErqOrders', ordersHandler([order(1, { lines: all })]))
      .on('ErqOrderLines', linesHandler(all));
    const page = await fetchOrders(gqlOf(admin), ctx, null, {});
    const lines = page.items[0]!.lines;
    expect(lines).toHaveLength(total);
    expect(new Set(lines.map((l) => l.externalLineId)).size).toBe(total);
    expect(admin.callsOf('ErqOrderLines')).toBe(2);
    expect(page.items[0]!.grossCents).toBe(total * 100);
  });

  it('fails with the fixed message when an order has absurdly many lines', async () => {
    const total = ORDER_LINES_INLINE + (MAX_EXTRA_PAGES + 1) * ORDER_LINES_EXTRA_PAGE_SIZE;
    const all = Array.from({ length: total }, (_, i) => line(i + 1, 1, '1.00'));
    const admin = new FakeShopifyAdmin()
      .on('ErqOrders', ordersHandler([order(1, { lines: all })]))
      .on('ErqOrderLines', linesHandler(all));
    expect(await failureOf(fetchOrders(gqlOf(admin), ctx, null, {}))).toBe(
      'An order has too many lines to import.',
    );
    expect(admin.callsOf('ErqOrderLines')).toBe(MAX_EXTRA_PAGES);
  });

  it('fails on a duplicate line id', async () => {
    const dup = order(1, { lines: [line(1, 1, '1.00'), line(1, 1, '1.00')] });
    expect(await failureOf(fetchOne(dup))).toBe(UNEXPECTED);
  });

  it('fetches the rest of an order with more refunds than fit inline', async () => {
    const all = Array.from({ length: ORDER_REFUNDS_INLINE + 3 }, (_, i) =>
      refund(i + 1, [refundLine(1, 1, '1.00')], '1.00'),
    );
    const admin = new FakeShopifyAdmin()
      .on(
        'ErqOrders',
        ordersHandler([order(1, { refunds: all.slice(0, ORDER_REFUNDS_INLINE + 1) })]),
      )
      .on('ErqOrderRefunds', refundsHandler(all));
    const page = await fetchOrders(gqlOf(admin), ctx, null, {});
    expect(page.items[0]!.refunds.map((r) => r.externalId)).toEqual(all.map((r) => r.id));
    expect(admin.callsOf('ErqOrderRefunds')).toBe(1);
  });

  it('fails clearly beyond the refunds ceiling', async () => {
    const all = Array.from({ length: ORDER_REFUNDS_MAX + 5 }, (_, i) => refund(i + 1, [], '1.00'));
    const admin = new FakeShopifyAdmin()
      .on(
        'ErqOrders',
        ordersHandler([order(1, { refunds: all.slice(0, ORDER_REFUNDS_INLINE + 1) })]),
      )
      .on('ErqOrderRefunds', refundsHandler(all));
    expect(await failureOf(fetchOrders(gqlOf(admin), ctx, null, {}))).toBe(
      'An order has too many refunds to import.',
    );
  });

  it('fetches the remaining lines of a refund that restocks a big order', async () => {
    const total = REFUND_LINES_INLINE + REFUND_LINES_EXTRA_PAGE_SIZE + 5;
    const lines = Array.from({ length: total }, (_, i) => refundLine(i + 1, 1, '2.00'));
    const r = refund(1, lines, '999.00');
    const admin = new FakeShopifyAdmin()
      .on('ErqOrders', ordersHandler([order(1, { refunds: [r] })]))
      .on('ErqRefundLines', refundConnHandler('refundLineItems', { [r.id]: lines }));
    const page = await fetchOrders(gqlOf(admin), ctx, null, {});
    const out = page.items[0]!.refunds[0]!;
    expect(out.lines).toHaveLength(total);
    expect(out.amountCents).toBe(total * 200);
    expect(admin.callsOf('ErqRefundLines')).toBe(2);
  });

  it('fetches shipping refund lines beyond the inline size and sums them', async () => {
    const shipping = Array.from({ length: REFUND_SHIPPING_INLINE + 3 }, () => '1.00');
    const r = refund(1, [], '100.00', shipping);
    const admin = new FakeShopifyAdmin()
      .on('ErqOrders', ordersHandler([order(1, { refunds: [r] })]))
      .on(
        'ErqRefundShipping',
        refundConnHandler('refundShippingLines', { [r.id]: shipping.map(shippingNode) }),
      );
    const page = await fetchOrders(gqlOf(admin), ctx, null, {});
    expect(page.items[0]!.refunds[0]!.shippingRefundCents).toBe(shipping.length * 100);
    expect(admin.callsOf('ErqRefundShipping')).toBe(1);
  });

  it('fails clearly past the extra page ceiling for refund lines', async () => {
    const total = REFUND_LINES_INLINE + (MAX_EXTRA_PAGES + 1) * REFUND_LINES_EXTRA_PAGE_SIZE;
    const lines = Array.from({ length: total }, (_, i) => refundLine(i + 1, 1, '1.00'));
    const r = refund(1, lines, '1.00');
    const admin = new FakeShopifyAdmin()
      .on('ErqOrders', ordersHandler([order(1, { refunds: [r] })]))
      .on('ErqRefundLines', refundConnHandler('refundLineItems', { [r.id]: lines }));
    expect(await failureOf(fetchOrders(gqlOf(admin), ctx, null, {}))).toBe(
      'An order has too many refund lines to import.',
    );
    expect(admin.callsOf('ErqRefundLines')).toBe(MAX_EXTRA_PAGES);
  });

  it('fails instead of looping when refund connections lose their cursor', async () => {
    const noCursor = { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } };
    const inlineLines = refund(1, [], '1.00', [], { refundLineItems: noCursor });
    const inlineShip = refund(2, [], '1.00', [], { refundShippingLines: noCursor });
    for (const r of [inlineLines, inlineShip]) {
      const admin = new FakeShopifyAdmin().on(
        'ErqOrders',
        ordersHandler([order(1, { refunds: [r] })]),
      );
      expect(await failureOf(fetchOrders(gqlOf(admin), ctx, null, {}))).toBe(UNEXPECTED);
      expect(admin.requests).toHaveLength(1);
    }
    // A follow-up page that says hasNextPage without a cursor must also stop.
    const lines = Array.from({ length: REFUND_LINES_INLINE + 1 }, (_, i) =>
      refundLine(i + 1, 1, '1.00'),
    );
    const r = refund(3, lines, '1.00');
    const admin = new FakeShopifyAdmin()
      .on('ErqOrders', ordersHandler([order(1, { refunds: [r] })]))
      .on('ErqRefundLines', () => gqlOk({ node: { refundLineItems: noCursor } }));
    expect(await failureOf(fetchOrders(gqlOf(admin), ctx, null, {}))).toBe(UNEXPECTED);
    expect(admin.callsOf('ErqRefundLines')).toBe(1);
    const ship = Array.from({ length: REFUND_SHIPPING_INLINE + 1 }, () => '1.00');
    const r2 = refund(4, [], '1.00', ship);
    const admin2 = new FakeShopifyAdmin()
      .on('ErqOrders', ordersHandler([order(1, { refunds: [r2] })]))
      .on('ErqRefundShipping', () => gqlOk({ node: { refundShippingLines: noCursor } }));
    expect(await failureOf(fetchOrders(gqlOf(admin2), ctx, null, {}))).toBe(UNEXPECTED);
    expect(admin2.callsOf('ErqRefundShipping')).toBe(1);
  });

  it('retries (transient) when a refund or its order vanishes between queries', async () => {
    const all = Array.from({ length: ORDER_REFUNDS_INLINE + 1 }, (_, i) =>
      refund(i + 1, [], '1.00'),
    );
    const admin = new FakeShopifyAdmin()
      .on('ErqOrders', ordersHandler([order(1, { refunds: all })]))
      .on('ErqOrderRefunds', () => gqlOk({ order: null }));
    await transientOf(fetchOrders(gqlOf(admin), ctx, null, {}));
    const lines = Array.from({ length: REFUND_LINES_INLINE + 1 }, (_, i) =>
      refundLine(i + 1, 1, '1.00'),
    );
    const admin2 = new FakeShopifyAdmin()
      .on('ErqOrders', ordersHandler([order(1, { refunds: [refund(1, lines, '1.00')] })]))
      .on('ErqRefundLines', () => gqlOk({ node: null }));
    await transientOf(fetchOrders(gqlOf(admin2), ctx, null, {}));
    const ship = Array.from({ length: REFUND_SHIPPING_INLINE + 1 }, () => '1.00');
    const admin3 = new FakeShopifyAdmin()
      .on('ErqOrders', ordersHandler([order(1, { refunds: [refund(1, [], '1.00', ship)] })]))
      .on('ErqRefundShipping', () => gqlOk({ node: null }));
    await transientOf(fetchOrders(gqlOf(admin3), ctx, null, {}));
  });

  it('keeps every follow-up query under the 1000 point cost cap', async () => {
    const refunds = Array.from({ length: ORDER_REFUNDS_INLINE + 1 }, (_, i) =>
      refund(
        i + 1,
        Array.from({ length: REFUND_LINES_INLINE + 1 }, (_, j) => refundLine(j + 1, 1, '1.00')),
        '1.00',
        ['1.00', '1.00', '1.00'],
      ),
    );
    const lineMap = Object.fromEntries(
      refunds.map((r) => [
        r.id,
        Array.from({ length: REFUND_LINES_INLINE + 1 }, (_, j) => refundLine(j + 1, 1, '1.00')),
      ]),
    );
    const shipMap = Object.fromEntries(
      refunds.map((r) => [r.id, ['1.00', '1.00', '1.00'].map(shippingNode)]),
    );
    const admin = new FakeShopifyAdmin()
      .on('ErqOrders', ordersHandler([order(1, { refunds })]))
      .on('ErqOrderRefunds', refundsHandler(refunds))
      .on('ErqRefundLines', refundConnHandler('refundLineItems', lineMap))
      .on('ErqRefundShipping', refundConnHandler('refundShippingLines', shipMap));
    await fetchOrders(gqlOf(admin), ctx, null, {});
    // Sizes come from what was actually sent. https://shopify.dev/docs/api/usage/limits#cost-calculation
    const refundsBody = sentBody(admin, 'ErqOrderRefunds');
    expect(
      orderRefundsQueryCost(
        refundsBody.variables.first,
        sizeIn(refundsBody.query, 'refundLineItems'),
        sizeIn(refundsBody.query, 'refundShippingLines'),
      ),
    ).toBeLessThan(1000);
    expect(refundLinesQueryCost(sentBody(admin, 'ErqRefundLines').variables.first)).toBeLessThan(
      1000,
    );
    expect(
      refundShippingQueryCost(sentBody(admin, 'ErqRefundShipping').variables.first),
    ).toBeLessThan(1000);
    expect(sentBody(admin, 'ErqRefundLines').variables.first).toBe(REFUND_LINES_EXTRA_PAGE_SIZE);
    expect(sentBody(admin, 'ErqRefundShipping').variables.first).toBe(
      REFUND_SHIPPING_EXTRA_PAGE_SIZE,
    );
  });

  it('requests taxesIncluded and still parses a tax-inclusive order unchanged', async () => {
    const admin = new FakeShopifyAdmin().on(
      'ErqOrders',
      ordersHandler([order(1, { taxesIncluded: true, totalTaxSet: money('3.20') })]),
    );
    const page = await fetchOrders(gqlOf(admin), ctx, null, {});
    expect(sentBody(admin, 'ErqOrders').query).toContain('taxesIncluded');
    // Documented limitation: the maths is not adjusted, tax is reported as sent.
    expect(page.items[0]).toMatchObject({ taxCents: 320, grossCents: 1000 });
  });

  it('keeps a null variant as a null external variant id', async () => {
    const page = await fetchOne(order(1, { lines: [line(1, 1, '1.00', '0', null)] }));
    expect(page.items[0]!.lines[0]!.externalVariantId).toBeNull();
  });

  it('fails without echoing the value when money is unreadable or missing', async () => {
    const message = await failureOf(fetchOne(order(1, { totalTaxSet: money('SECRET-12x') })));
    expect(message).toBe('Shopify returned an unreadable amount.');
    expect(message).not.toContain('SECRET');
    // A missing money set fails response validation; the message must not echo the payload.
    const missing = await failureOf(fetchOne(order(2, { totalShippingPriceSet: undefined })));
    expect(missing).not.toContain('totalShippingPriceSet');
  });

  it('keeps the orders query under the 1000 point cost cap with the real constants', async () => {
    const admin = new FakeShopifyAdmin().on('ErqOrders', ordersHandler([order(1)]));
    await fetchOrders(gqlOf(admin), ctx, null, {});
    const body = JSON.parse(admin.requests[0]!.body!) as {
      query: string;
      variables: { first: number };
    };
    // Every size is read from what was actually sent, so a changed constant cannot dodge the guard.
    // Shopify rejects queries whose requested cost exceeds 1000 points:
    // https://shopify.dev/docs/api/usage/limits#cost-calculation
    const sizeOf = (field: string): number => {
      const m = new RegExp(`${field}\\(first: (\\d+)`).exec(body.query);
      if (!m) throw new Error(`no first on ${field}`);
      return Number(m[1]);
    };
    const requested = ordersQueryCost(
      body.variables.first,
      sizeOf('lineItems'),
      sizeOf('refunds'),
      sizeOf('refundLineItems'),
      sizeOf('refundShippingLines'),
    );
    expect(requested).toBeLessThan(1000);
    expect(orderLinesQueryCost(ORDER_LINES_EXTRA_PAGE_SIZE)).toBeLessThan(1000);
  });

  it('fails instead of looping when nested lines say hasNextPage without a cursor', async () => {
    const o = order(1);
    o.lineItems = { nodes: o.lineItems.nodes, pageInfo: { hasNextPage: true, endCursor: null } };
    const admin = new FakeShopifyAdmin().on('ErqOrders', ordersHandler([o]));
    expect(await failureOf(fetchOrders(gqlOf(admin), ctx, null, {}))).toBe(UNEXPECTED);
    expect(admin.callsOf('ErqOrderLines')).toBe(0);
  });

  it('fails instead of looping when an extra lines page loses its cursor', async () => {
    const all = Array.from({ length: ORDER_LINES_INLINE + 5 }, (_, i) => line(i + 1, 1, '1.00'));
    const admin = new FakeShopifyAdmin()
      .on('ErqOrders', ordersHandler([order(1, { lines: all })]))
      .on('ErqOrderLines', () =>
        gqlOk({
          order: {
            lineItems: {
              nodes: [line(99, 1, '1.00')],
              pageInfo: { hasNextPage: true, endCursor: null },
            },
          },
        }),
      );
    expect(await failureOf(fetchOrders(gqlOf(admin), ctx, null, {}))).toBe(UNEXPECTED);
    expect(admin.callsOf('ErqOrderLines')).toBe(1);
  });

  it('fails instead of looping when the page says hasNextPage without a cursor', async () => {
    const admin = new FakeShopifyAdmin().on('ErqOrders', () =>
      gqlOk({ orders: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } }),
    );
    expect(await failureOf(fetchOrders(gqlOf(admin), ctx, null, {}))).toBe(UNEXPECTED);
  });

  it('retries (transient) when the order disappears while its lines are fetched', async () => {
    const all = Array.from({ length: ORDER_LINES_INLINE + 1 }, (_, i) => line(i + 1, 1, '1.00'));
    const admin = new FakeShopifyAdmin()
      .on('ErqOrders', ordersHandler([order(1, { lines: all })]))
      .on('ErqOrderLines', () => gqlOk({ order: null }));
    await transientOf(fetchOrders(gqlOf(admin), ctx, null, {}));
  });

  it('retries (transient) when a line repeats across line pages', async () => {
    const all = Array.from({ length: ORDER_LINES_INLINE + 1 }, (_, i) => line(i + 1, 1, '1.00'));
    const admin = new FakeShopifyAdmin()
      .on('ErqOrders', ordersHandler([order(1, { lines: all })]))
      .on('ErqOrderLines', () =>
        gqlOk({
          order: {
            lineItems: {
              nodes: [line(1, 1, '1.00')],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
      );
    await transientOf(fetchOrders(gqlOf(admin), ctx, null, {}));
  });

  it('rejects a tampered cursor before calling Shopify', async () => {
    const admin = new FakeShopifyAdmin().on('ErqOrders', ordersHandler([]));
    expect(await failureOf(fetchOrders(gqlOf(admin), ctx, 'not*a*cursor', {}))).toBe(
      'Invalid sync cursor.',
    );
    expect(admin.requests).toHaveLength(0);
  });
});
