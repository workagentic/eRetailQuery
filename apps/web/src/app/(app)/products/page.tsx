import { getProducts, type ProductRow } from '@erq/db';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@erq/ui';
import { DataTable, type Column } from '@/components/data-table';
import { FilterBar } from '@/components/filter-bar';
import { StatusChip } from '@/components/status-chip';
import { TermTip } from '@/components/term-tip';
import { formatBps, formatCents } from '@/lib/format';
import type { SearchParams } from '@/lib/filters';
import { loadReportContext } from '@/lib/report-context';
import { parseSort, sortRows } from '@/lib/sort';

const SORTS: Record<string, (r: ProductRow) => number | string | null> = {
  profit: (r) => r.profitCents,
  revenue: (r) => r.revenueCents,
  units: (r) => r.unitsSold,
  price: (r) => r.priceCents,
  markup: (r) => r.markupBps,
  margin: (r) => r.marginBps,
  title: (r) => r.title,
};
const MAX_ROWS = 100;

export default async function ProductsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const ctx = await loadReportContext(params);
  const sort = parseSort(params, Object.keys(SORTS), 'profit');
  const products = await ctx.db.withTenant(ctx.orgId, (tx) =>
    getProducts(tx, { range: ctx.range, channel: ctx.filters.channel, asOf: ctx.asOf }),
  );
  const rows = sortRows(products, SORTS[sort.key]!, sort.dir);
  const count = (s: ProductRow['pricingStatus']) => products.filter((p) => p.pricingStatus === s).length;
  const losing = products.filter((p) => p.contributionNegative).length;

  const hrefFor = (key: string, dir: string) =>
    `/products?range=${ctx.filters.preset}&channel=${ctx.filters.channel}&sort=${key}&dir=${dir}`;
  const columns: Column<ProductRow>[] = [
    {
      key: 'title',
      label: 'Product',
      sortable: true,
      cell: (r) => (
        <div>
          <div className="font-medium">{r.title}</div>
          <div className="text-xs text-muted-foreground">{r.skuCode}</div>
        </div>
      ),
    },
    { key: 'price', label: 'Price', align: 'right', sortable: true, cell: (r) => formatCents(r.priceCents) },
    {
      key: 'cost',
      label: <TermTip term="cogs">Cost of goods</TermTip>,
      align: 'right',
      cell: (r) => (r.landedCents === null ? 'Add cost' : formatCents(r.landedCents)),
    },
    {
      key: 'markup',
      label: <TermTip term="markup">Markup</TermTip>,
      align: 'right',
      sortable: true,
      cell: (r) => formatBps(r.markupBps),
    },
    {
      key: 'margin',
      label: <TermTip term="margin">Margin</TermTip>,
      align: 'right',
      sortable: true,
      cell: (r) => formatBps(r.marginBps),
    },
    {
      key: 'ideal',
      label: 'Ideal price',
      align: 'right',
      cell: (r) =>
        r.idealLowCents === null || r.idealHighCents === null
          ? '—'
          : `${formatCents(r.idealLowCents)} to ${formatCents(r.idealHighCents)}`,
    },
    { key: 'units', label: 'Units sold', align: 'right', sortable: true, cell: (r) => r.unitsSold },
    {
      key: 'profit',
      label: 'Profit',
      align: 'right',
      sortable: true,
      cell: (r) => (r.profitCents === null ? '—' : formatCents(r.profitCents)),
    },
    {
      key: 'status',
      label: 'Status',
      cell: (r) => (
        <div className="flex max-w-xs flex-col gap-1">
          <StatusChip status={r.pricingStatus} />
          <span className="text-xs text-muted-foreground">{r.message}</span>
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Products and pricing</h1>
        <p className="text-sm text-muted-foreground">
          Is every product priced to make money? Prices are compared with what each unit costs to get to your
          customer.
        </p>
      </div>
      <FilterBar path="/products" filters={ctx.filters} />
      <Card>
        <CardHeader>
          <CardTitle>
            {products.length} products: {count('underpriced')} underpriced, {count('healthy')} healthy,{' '}
            {count('premium')} premium, {count('no_cost')} need a cost
          </CardTitle>
          <CardDescription>
            {losing > 0
              ? `${losing} lose money on each sale after fees and shipping, even when the markup looks fine.`
              : 'No product loses money on each sale after fees and shipping.'}{' '}
            Profit is sales minus cost of goods and fees for {ctx.range.from} to {ctx.range.to}.{' '}
            <a className="underline" href={`/products/export?range=${ctx.filters.preset}&channel=${ctx.filters.channel}`}>
              Download CSV
            </a>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DataTable
            caption="Products with price, cost, markup, margin, ideal price range, sales and status"
            columns={columns}
            rows={rows.slice(0, MAX_ROWS)}
            rowKey={(r) => r.skuId}
            sort={sort}
            hrefFor={hrefFor}
            empty="No products yet. Connect a store or import a CSV to see your prices."
          />
          {rows.length > MAX_ROWS && (
            <p className="pt-3 text-xs text-muted-foreground">
              Showing the first {MAX_ROWS} of {rows.length}. Download the CSV for all of them.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
