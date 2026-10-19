import { getInventory, type StockRow } from '@erq/db';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@erq/ui';
import { DataTable, type Column } from '@/components/data-table';
import { StatusChip } from '@/components/status-chip';
import { TermTip } from '@/components/term-tip';
import { formatCents } from '@/lib/format';
import type { SearchParams } from '@/lib/filters';
import { loadReportContext } from '@/lib/report-context';

const columns: Column<StockRow>[] = [
  {
    key: 'title',
    label: 'Product',
    cell: (r) => (
      <div>
        <div className="font-medium">{r.title}</div>
        <div className="text-xs text-muted-foreground">{r.skuCode}</div>
      </div>
    ),
  },
  { key: 'available', label: 'In stock', align: 'right', cell: (r) => r.available },
  {
    key: 'pace',
    label: 'Sells per day',
    align: 'right',
    cell: (r) => r.velocityPerDay.toFixed(1),
  },
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
        <span className="text-xs font-medium">{r.action}</span>
      </div>
    ),
  },
];

export default async function InventoryPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const ctx = await loadReportContext(await searchParams);
  const inv = await ctx.db.withTenant(ctx.orgId, (tx) => getInventory(tx, { asOf: ctx.asOf }));
  const sections: { title: string; description: string; rows: StockRow[]; empty: string }[] = [
    {
      title: `Running low (${inv.lowStock.length})`,
      description: 'Will run out before a restock can arrive at the current sales pace.',
      rows: inv.lowStock,
      empty: 'Nothing is about to run out.',
    },
    {
      title: `Overstocked (${inv.overstock.length})`,
      description: 'More than 180 days of stock on hand. Cash is tied up on the shelf.',
      rows: inv.overstock,
      empty: 'Nothing is overstocked.',
    },
    {
      title: `Dead stock (${inv.dead.length})`,
      description: 'In stock with no sales in 90 days.',
      rows: inv.dead,
      empty: 'No dead stock.',
    },
  ];
  const totalUnits = inv.byLocation.reduce((a, l) => a + l.units, 0);
  const totalValue = inv.byLocation.reduce((a, l) => a + l.valueCents, 0);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Inventory</h1>
        <p className="text-sm text-muted-foreground">What is about to run out, and what is sitting too long. Data as of {ctx.asOf}.</p>
      </div>
      {sections.map((s) => (
        <Card key={s.title}>
          <CardHeader>
            <CardTitle>{s.title}</CardTitle>
            <CardDescription>{s.description}</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable
              caption={s.title}
              columns={columns}
              rows={s.rows.slice(0, 25)}
              rowKey={(r) => r.skuId}
              empty={s.empty}
            />
            {s.rows.length > 25 && (
              <p className="pt-3 text-xs text-muted-foreground">Showing the first 25 of {s.rows.length}.</p>
            )}
          </CardContent>
        </Card>
      ))}
      <Card>
        <CardHeader>
          <CardTitle>Stock by location</CardTitle>
          <CardDescription>
            {totalUnits} units on hand, worth {formatCents(totalValue)} at cost.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DataTable
            caption="Stock by location"
            columns={[
              { key: 'location', label: 'Location', cell: (l: (typeof inv.byLocation)[number]) => l.location },
              { key: 'units', label: 'Units', align: 'right', cell: (l) => l.units },
              { key: 'value', label: 'Value at cost', align: 'right', cell: (l) => formatCents(l.valueCents) },
            ]}
            rows={inv.byLocation}
            rowKey={(l) => l.location}
            empty="No stock counted yet. Sync a store or enter a manual count."
          />
        </CardContent>
      </Card>
    </div>
  );
}
