import type { Overview } from '@erq/db';
import { Card, CardContent } from '@erq/ui';
import { formatBps, formatCents, formatChange, formatRoas } from '@/lib/format';
import { TermTip } from './term-tip';

const ARROW = { up: '▲', down: '▼', flat: '▬' } as const;

function Kpi({
  label,
  value,
  sub,
  change,
}: {
  label: React.ReactNode;
  value: string;
  sub?: string;
  change: ReturnType<typeof formatChange>;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1 p-4">
        <div className="text-sm text-muted-foreground">{label}</div>
        <div className="text-2xl font-semibold tabular-nums">{value}</div>
        {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
        <div className="text-xs text-muted-foreground">
          <span aria-hidden="true">{ARROW[change.direction]} </span>
          {change.text} vs previous period
        </div>
      </CardContent>
    </Card>
  );
}

/** The "today strip": revenue, orders, ad spend, blended ROAS and estimated profit. */
export function KpiStrip({ kpis }: { kpis: Overview['kpis'] }) {
  const roasChange =
    kpis.blendedRoas.value === null || kpis.blendedRoas.previous === null
      ? ({ text: '—', direction: 'flat' } as const)
      : formatChange(kpis.blendedRoas.value, kpis.blendedRoas.previous);
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
      <Kpi
        label="Revenue"
        value={formatCents(kpis.revenue.value.cents)}
        sub="after discounts and refunds"
        change={formatChange(kpis.revenue.value.cents, kpis.revenue.previous.cents)}
      />
      <Kpi
        label="Orders"
        value={String(kpis.orders.value)}
        change={formatChange(kpis.orders.value, kpis.orders.previous)}
      />
      <Kpi
        label="Ad spend"
        value={formatCents(kpis.adSpend.value.cents)}
        change={formatChange(kpis.adSpend.value.cents, kpis.adSpend.previous.cents)}
      />
      <Kpi
        label={<TermTip term="blendedRoas">Blended ROAS</TermTip>}
        value={formatRoas(kpis.blendedRoas.value)}
        sub="all sales / all ad spend"
        change={roasChange}
      />
      <Kpi
        label={<TermTip term="afterAds">Money left after ads</TermTip>}
        value={formatCents(kpis.estimatedProfit.value.cents)}
        sub={`${formatBps(kpis.marginBps.value)} of sales`}
        change={formatChange(kpis.estimatedProfit.value.cents, kpis.estimatedProfit.previous.cents)}
      />
    </div>
  );
}
