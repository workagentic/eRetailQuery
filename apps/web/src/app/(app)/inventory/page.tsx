import { getInventory, type StockRow } from '@erq/db';
import { BarList } from '@/components/bar-list';
import { DataTable, type Column } from '@/components/data-table';
import { PageHeader, Panel } from '@/components/page-kit';
import { ProductThumb } from '@/components/product-thumb';
import { SegmentBar } from '@/components/segment-bar';
import { StatusChip } from '@/components/status-chip';
import { TermTip } from '@/components/term-tip';
import { dollars } from '@/lib/chart-colors';
import type { SearchParams } from '@/lib/filters';
import { formatCents } from '@/lib/format';
import { loadReportContext } from '@/lib/report-context';

const LOCATION_COLORS = ['#0d9488', '#d97706', '#2563eb', '#7c3aed'];

const columns: Column<StockRow>[] = [
  {
    key: 'title',
    label: 'Product',
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
  { key: 'available', label: 'In stock', align: 'right', cell: (r) => r.available },
  { key: 'pace', label: 'Sells per day', align: 'right', cell: (r) => r.velocityPerDay.toFixed(1) },
  {
    key: 'cover',
    label: <TermTip term="daysOfCover">Days left</TermTip>,
    align: 'right',
    cell: (r) => (r.daysOfCover === null ? '—' : Math.floor(r.daysOfCover)),
  },
  {
    key: 'why',
    label: 'Why and what to do',
    cell: (r) => (
      <div className="flex max-w-md flex-col gap-1">
        <StatusChip status={r.flag} />
        <span className="text-xs text-muted-foreground">{r.reason}</span>
        <span className="text-xs font-semibold text-foreground">{r.action}</span>
      </div>
    ),
  },
];

function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-[14px] border border-border/70 bg-surface p-4 shadow-[var(--shadow-card)]">
      <div className="text-[13px] text-muted-foreground">{label}</div>
      <div className="text-[26px] font-semibold leading-none tracking-tight tabular">{value}</div>
      <div className="pt-1 text-xs text-muted-foreground">{note}</div>
    </div>
  );
}

export default async function InventoryPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const ctx = await loadReportContext(await searchParams);
  const inv = await ctx.db.withTenant(ctx.orgId, (tx) => getInventory(tx, { asOf: ctx.asOf }));
  const sections: { title: string; description: string; rows: StockRow[]; empty: string }[] = [
    { title: `Running low (${inv.lowStock.length})`, description: 'Will run out before a restock can arrive at the current sales pace.', rows: inv.lowStock, empty: 'Nothing is about to run out.' },
    { title: `Overstocked (${inv.overstock.length})`, description: 'More than 180 days of stock on hand. Cash is tied up on the shelf.', rows: inv.overstock, empty: 'Nothing is overstocked.' },
    { title: `Dead stock (${inv.dead.length})`, description: 'In stock with no sales in 90 days.', rows: inv.dead, empty: 'No dead stock.' },
  ];
  const totalUnits = inv.byLocation.reduce((a, l) => a + l.units, 0);
  const totalValue = inv.byLocation.reduce((a, l) => a + l.valueCents, 0);
  const deadValue = inv.dead.reduce((a, s) => a + s.available, 0);

  return (
    <>
      <PageHeader
        title="Inventory"
        description={`What is about to run out, and what is sitting too long. Data as of ${ctx.asOf}.`}
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Units on hand" value={String(totalUnits)} note="Across every location." />
        <Stat label="Stock value at cost" value={formatCents(totalValue)} note="Units times landed cost." />
        <Stat label="Running low" value={String(inv.lowStock.length)} note="Products to reorder now." />
        <Stat label="Dead stock units" value={String(deadValue)} note={`${inv.dead.length} products with no sales in 90 days.`} />
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        <Panel className="xl:col-span-2" title="Closest to running out" description="Days of stock left at the current pace. The tick marks the 14 days you need to restock safely.">
          <BarList
            empty="Nothing is about to run out."
            items={inv.lowStock.slice(0, 8).map((s) => ({
              key: s.skuId,
              lead: <ProductThumb category={s.category} seed={s.title} size="sm" />,
              label: s.title,
              sublabel: `${s.skuCode} · ${s.available} in stock`,
              value: s.daysOfCover ?? 0,
              valueLabel: `${Math.floor(s.daysOfCover ?? 0)} days`,
              color: '#b91c1c',
              marker: 14,
              markerLabel: '14 days to restock',
            }))}
          />
        </Panel>
        <Panel title="Stock by location" description={`${totalUnits} units, worth ${dollars(totalValue)} at cost.`}>
          <SegmentBar
            segments={inv.byLocation.map((l, i) => ({
              key: l.location,
              label: l.location,
              color: LOCATION_COLORS[i % LOCATION_COLORS.length]!,
              widthPct: totalValue > 0 ? (l.valueCents / totalValue) * 100 : 0,
              valueLabel: `${l.units} units · ${dollars(l.valueCents)}`,
            }))}
          />
        </Panel>
      </div>

      {sections.map((s) => (
        <Panel key={s.title} title={s.title} description={s.description}>
          <DataTable caption={s.title} columns={columns} rows={s.rows.slice(0, 25)} rowKey={(r) => r.skuId} empty={s.empty} />
          {s.rows.length > 25 && <p className="pt-3 text-xs text-muted-foreground">Showing the first 25 of {s.rows.length}.</p>}
        </Panel>
      ))}
    </>
  );
}
