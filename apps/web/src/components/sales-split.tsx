import type { Overview } from '@erq/db';
import { dollarsExact } from '@/lib/chart-colors';
import { splitOfSales } from '@/lib/chart-data';
import { SegmentBar } from './segment-bar';

/** The hero of the dashboard: where every $100 of sales goes, and what is left. */
export function SalesSplit({ breakdown }: { breakdown: Overview['breakdown'] }) {
  const split = splitOfSales(breakdown);
  if (split.segments.length === 0) return null;
  const profit = split.segments.find((s) => s.key === 'profit');
  return (
    <section className="overflow-hidden rounded-[14px] bg-ink p-6 text-white shadow-[var(--shadow-card)] sm:p-8">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium text-ink-muted">Where every $100 of sales goes</h2>
        {split.loss ? (
          <p className="text-3xl font-semibold tracking-tight sm:text-4xl">
            You lose <span className="text-[#fca5a5]">{dollarsExact(split.lossPer100Cents)}</span> on every $100
          </p>
        ) : (
          <p className="text-3xl font-semibold tracking-tight sm:text-4xl">
            You keep <span className="text-[#5eead4]">{dollarsExact(profit?.per100Cents ?? 0)}</span> of every $100
          </p>
        )}
        <p className="max-w-2xl pt-1 text-sm text-ink-muted">
          {split.loss
            ? 'Costs and ads add up to more than you sold. The bar shows how the spending is split.'
            : 'The rest goes to the cost of goods, shipping, fees and ads. This is the money left after ads.'}
        </p>
      </div>
      <div className="mt-6 rounded-xl bg-white p-5 text-foreground">
        <SegmentBar
          segments={split.segments.map((s) => ({
            key: s.key,
            label: s.label,
            color: s.color,
            widthPct: s.widthPct,
            valueLabel: `${dollarsExact(s.per100Cents)} per $100`,
          }))}
        />
      </div>
    </section>
  );
}
