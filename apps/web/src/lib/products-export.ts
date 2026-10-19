import type { ProductRow } from '@erq/db';

const HEADER = [
  'SKU',
  'Product',
  'Category',
  'Price',
  'Cost of goods',
  'Markup %',
  'Margin %',
  'Ideal price low',
  'Ideal price high',
  'Status',
  'Units sold',
  'Revenue',
  'Profit',
  'Note',
];

const money = (cents: number | null): string => (cents === null ? '' : (cents / 100).toFixed(2));
const pct = (bps: number | null): string => (bps === null ? '' : (bps / 100).toFixed(1));

/** Text cells: neutralise spreadsheet formulas, then quote when needed. */
function text(value: string | null): string {
  if (value === null) return '';
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(rows: ProductRow[]): string {
  const lines = [HEADER.join(',')];
  for (const r of rows) {
    lines.push(
      [
        text(r.skuCode),
        text(r.title),
        text(r.category),
        money(r.priceCents),
        money(r.landedCents),
        pct(r.markupBps),
        pct(r.marginBps),
        money(r.idealLowCents),
        money(r.idealHighCents),
        text(r.pricingStatus),
        String(r.unitsSold),
        money(r.revenueCents),
        money(r.profitCents),
        text(r.message),
      ].join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}

export async function productsCsvResponse(deps: {
  isSignedIn(): Promise<boolean>;
  loadRows(): Promise<ProductRow[]>;
}): Promise<Response> {
  if (!(await deps.isSignedIn())) {
    return Response.json(
      { error: { code: 'unauthenticated', message: 'Not signed in' } },
      { status: 401 },
    );
  }
  return new Response(toCsv(await deps.loadRows()), {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="products.csv"',
      'cache-control': 'no-store',
    },
  });
}
