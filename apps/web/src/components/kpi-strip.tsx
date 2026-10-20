import type { Overview } from '@erq/db';
import { ArrowDownRight, ArrowUpRight, Megaphone, Minus, Percent, PiggyBank, ReceiptText, ShoppingBag, type LucideIcon } from 'lucide-react';
import { COLORS } from '@/lib/chart-colors';
import { formatBps, formatCents, formatChange, formatRoas } from '@/lib/format';
import { Sparkline } from './sparkline';
import { TermTip } from './term-tip';

type Change = ReturnType<typeof formatChange>;

function ChangePill({ change, neutral }: { change: Change; neutral?: boolean }) {
  const Icon = change.direction === 'up' ? ArrowUpRight : change.direction === 'down' ? ArrowDownRight : Minus;
  const tone = neutral || change.direction === 'flat'
    ? 'bg-muted text-muted-foreground'
    : change.direction === 'up'
      ? 'bg-profit-soft text-profit'
      : 'bg-loss-soft text-loss';
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 font-semibold ${tone}`}>
        <Icon aria-hidden="true" className="size-3" strokeWidth={2.25} />
        {change.text}
      </span>
      vs previous period
    </span>
  );
}

function Kpi({
  icon: Icon,
  label,
  value,
  sub,
  change,
  neutral,
  spark,
  accent,
}: {
  icon: LucideIcon;
  label: React.ReactNode;
  value: string;
  sub?: string;
  change: Change;
  neutral?: boolean;
  spark?: { values: number[]; id: string };
  accent: string;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-[14px] border border-border/70 bg-surface p-4 shadow-[var(--shadow-card)]">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <span className="grid size-7 place-items-center rounded-lg" style={{ background: `${accent}1a`, color: accent }}>
            <Icon aria-hidden="true" className="size-4" strokeWidth={1.9} />
          </span>
          {label}
        </div>
      </div>
      <div className="flex items-end justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[26px] font-semibold leading-none tracking-tight tabular">{value}</div>
          {sub && <div className="pt-1.5 text-xs text-muted-foreground">{sub}</div>}
        </div>
        {spark && spark.values.length > 1 && <Sparkline values={spark.values} color={accent} id={spark.id} />}
      </div>
      <ChangePill change={change} neutral={neutral} />
    </div>
  );
}

/** The "today strip": revenue, orders, ad spend, blended ROAS and estimated profit, each with a trend line. */
export function KpiStrip({ kpis, daily }: { kpis: Overview['kpis']; daily?: Overview['daily'] }) {
  const roasChange: Change =
    kpis.blendedRoas.value === null || kpis.blendedRoas.previous === null
      ? { text: '—', direction: 'flat' }
      : formatChange(kpis.blendedRoas.value, kpis.blendedRoas.previous);
  const series = (pick: (d: Overview['daily'][number]) => number) => daily?.map(pick) ?? [];
  const roasSeries = daily?.map((d) => (d.adSpend > 0 ? d.revenue / d.adSpend : 0)) ?? [];
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
      <Kpi
        icon={ShoppingBag}
        accent={COLORS.teal}
        label="Revenue"
        value={formatCents(kpis.revenue.value.cents)}
        sub="after discounts and refunds"
        change={formatChange(kpis.revenue.value.cents, kpis.revenue.previous.cents)}
        spark={{ values: series((d) => d.revenue), id: 'rev' }}
      />
      <Kpi
        icon={ReceiptText}
        accent={COLORS.violet}
        label="Orders"
        value={String(kpis.orders.value)}
        change={formatChange(kpis.orders.value, kpis.orders.previous)}
        spark={{ values: series((d) => d.orders), id: 'ord' }}
      />
      <Kpi
        icon={Megaphone}
        accent={COLORS.blue}
        label="Ad spend"
        value={formatCents(kpis.adSpend.value.cents)}
        change={formatChange(kpis.adSpend.value.cents, kpis.adSpend.previous.cents)}
        neutral
        spark={{ values: series((d) => d.adSpend), id: 'ads' }}
      />
      <Kpi
        icon={Percent}
        accent={COLORS.amber}
        label={<TermTip term="blendedRoas">Blended ROAS</TermTip>}
        value={formatRoas(kpis.blendedRoas.value)}
        sub="all sales / all ad spend"
        change={roasChange}
        spark={{ values: roasSeries, id: 'roas' }}
      />
      <Kpi
        icon={PiggyBank}
        accent={COLORS.green}
        label={<TermTip term="afterAds">Money left after ads</TermTip>}
        value={formatCents(kpis.estimatedProfit.value.cents)}
        sub={`${formatBps(kpis.marginBps.value)} of sales`}
        change={formatChange(kpis.estimatedProfit.value.cents, kpis.estimatedProfit.previous.cents)}
        spark={{ values: series((d) => d.profit), id: 'profit' }}
      />
    </div>
  );
}
