import { getProducts, type ProductRow } from '@erq/db';
import { Download } from 'lucide-react';
import { BarList } from '@/components/bar-list';
import { DataTable, type Column } from '@/components/data-table';
import { FilterBar } from '@/components/filter-bar';
import { PageHeader, Panel } from '@/components/page-kit';
import { ProductThumb } from '@/components/product-thumb';
import { SegmentBar } from '@/components/segment-bar';
import { StatusChip } from '@/components/status-chip';
import { TermTip } from '@/components/term-tip';
import { dollars } from '@/lib/chart-colors';
import type { SearchParams } from '@/lib/filters';
import { formatBps, formatCents } from '@/lib/format';
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
const STATUS_COLOR = { underpriced: '#b91c1c', healthy: '#15803d', premium: '#2563eb', no_cost: '#94a3b8' } as const;
const STATUS_LABEL = { underpriced: 'Underpriced', healthy: 'Healthy', premium: 'Premium', no_cost: 'Needs cost' } as const;

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
  const total = Math.max(1, products.length);

  const withProfit = products.filter((p) => p.profitCents !== null && p.unitsSold > 0);
  const best = sortRows(withProfit, (p) => p.profitCents, 'desc').slice(0, 6);
  const worst = sortRows(withProfit, (p) => p.profitCents, 'asc').slice(0, 5);

  const hrefFor = (key: string, dir: string) =>
    `/products?range=${ctx.filters.preset}&channel=${ctx.filters.channel}&sort=${key}&dir=${dir}`;
  const columns: Column<ProductRow>[] = [
    {
      key: 'title',
      label: 'Product',
      sortable: true,
      cell: (r) => (
        <div className="flex items-center gap-3">
          <ProductThumb category={r.category} seed={r.title} size="sm" />
          <div className="min-w-0">
            <div className="truncate font-medium text-foreground">{r.title}</div>
            <div className="text-xs text-muted-foreground">{r.skuCode}</div>
          </div>
        </div>
      ),
    },
    { key: 'price', label: 'Price', align: 'right', sortable: true, cell: (r) => formatCents(r.priceCents) },
    {
      key: 'cost',
      label: <TermTip term="cogs">Cost of goods</TermTip>,
      align: 'right',
      cell: (r) => (r.landedCents === null ? <span className="text-muted-foreground">Add cost</span> : formatCents(r.landedCents)),
    },
    { key: 'markup', label: <TermTip term="markup">Markup</TermTip>, align: 'right', sortable: true, cell: (r) => formatBps(r.markupBps) },
    { key: 'margin', label: <TermTip term="margin">Margin</TermTip>, align: 'right', sortable: true, cell: (r) => formatBps(r.marginBps) },
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
      cell: (r) =>
        r.profitCents === null ? (
          '—'
        ) : (
          <span className={r.profitCents < 0 ? 'font-semibold text-loss' : 'font-semibold text-foreground'}>
            {formatCents(r.profitCents)}
          </span>
        ),
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

  const lead = (r: ProductRow) => <ProductThumb category={r.category} seed={r.title} size="sm" />;
  return (
    <>
      <PageHeader
        title="Products and pricing"
        description="Is every product priced to make money? Prices are compared with what each unit costs to get to your customer."
        actions={<FilterBar path="/products" filters={ctx.filters} />}
      />

      <div className="grid gap-6 xl:grid-cols-3">
        <Panel
          className="xl:col-span-3"
          title={`Price health across ${products.length} products`}
          description={
            losing > 0
              ? `${losing} lose money on each sale after fees and shipping, even when the markup looks fine.`
              : 'No product loses money on each sale after fees and shipping.'
          }
        >
          <SegmentBar
            segments={(['underpriced', 'healthy', 'premium', 'no_cost'] as const).map((s) => ({
              key: s,
              label: STATUS_LABEL[s],
              color: STATUS_COLOR[s],
              widthPct: (count(s) / total) * 100,
              valueLabel: `${count(s)} products`,
            }))}
          />
        </Panel>
        <Panel className="xl:col-span-2" title="Top earners" description="Profit after cost of goods and fees in the selected period.">
          <BarList
            empty="No sales in this period."
            items={best.map((p) => ({
              key: p.skuId,
              lead: lead(p),
              label: p.title,
              sublabel: `${p.skuCode} · ${p.unitsSold} sold`,
              value: p.profitCents ?? 0,
              valueLabel: dollars(p.profitCents ?? 0),
            }))}
          />
        </Panel>
        <Panel title="Earning the least" description="Lowest profit among products that sold.">
          <BarList
            empty="No sales in this period."
            items={worst.map((p) => ({
              key: p.skuId,
              lead: lead(p),
              label: p.title,
              sublabel: p.skuCode,
              value: p.profitCents ?? 0,
              valueLabel: dollars(p.profitCents ?? 0),
              color: '#d97706',
            }))}
          />
        </Panel>
      </div>

      <Panel
        title="All products"
        description={`Profit is sales minus cost of goods and fees for ${ctx.range.from} to ${ctx.range.to}. Refunds are not netted out.`}
        action={
          <a
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[13px] font-medium text-foreground transition-colors hover:bg-muted"
            href={`/products/export?range=${ctx.filters.preset}&channel=${ctx.filters.channel}`}
          >
            <Download aria-hidden="true" className="size-4" />
            Download CSV
          </a>
        }
      >
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
      </Panel>
    </>
  );
}
