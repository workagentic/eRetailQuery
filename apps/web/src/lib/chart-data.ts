/** Pure data shaping for the charts, so the numbers behind a picture are tested without drawing anything. */

export interface Breakdown {
  netSalesCents: number;
  cogsCents: number;
  fulfillmentCents: number;
  feesCents: number;
  adSpendCents: number;
  profitCents: number;
}

export type SegmentKey = 'cogs' | 'fulfillment' | 'fees' | 'ads' | 'profit';

export interface Segment {
  key: SegmentKey;
  label: string;
  color: string;
  cents: number;
  /** Cents out of every $100 of sales (10,000 cents). */
  per100Cents: number;
  /** Width of this part of the bar, in percent. The widths add up to 100. */
  widthPct: number;
}

const PARTS: { key: SegmentKey; label: string; color: string }[] = [
  { key: 'cogs', label: 'Cost of goods', color: '#334155' },
  { key: 'fulfillment', label: 'Shipping and fulfillment', color: '#64748b' },
  { key: 'fees', label: 'Payment and marketplace fees', color: '#94a3b8' },
  { key: 'ads', label: 'Ads', color: '#2563eb' },
  { key: 'profit', label: 'Money left', color: '#15803d' },
];
const VALUE: Record<SegmentKey, (b: Breakdown) => number> = {
  cogs: (b) => b.cogsCents,
  fulfillment: (b) => b.fulfillmentCents,
  fees: (b) => b.feesCents,
  ads: (b) => b.adSpendCents,
  profit: (b) => b.profitCents,
};

/** Splits integers so they add up exactly to `total` (largest remainder). */
function apportion(values: number[], total: number): number[] {
  const sum = values.reduce((a, v) => a + v, 0);
  if (sum <= 0) return values.map(() => 0);
  const raw = values.map((v) => (v * total) / sum);
  const out = raw.map(Math.floor);
  let left = total - out.reduce((a, v) => a + v, 0);
  const order = raw.map((r, i) => ({ i, r: r - Math.floor(r) })).sort((a, b) => b.r - a.r);
  for (const { i } of order) {
    if (left <= 0) break;
    out[i]! += 1;
    left -= 1;
  }
  return out;
}

/** "Where every $100 of sales goes": costs and, when there is one, the money left. */
export function splitOfSales(b: Breakdown): { segments: Segment[]; loss: boolean; lossPer100Cents: number } {
  if (b.netSalesCents <= 0) return { segments: [], loss: false, lossPer100Cents: 0 };
  const loss = b.profitCents < 0;
  const parts = PARTS.filter((p) => p.key !== 'profit' || !loss);
  const cents = parts.map((p) => VALUE[p.key](b));
  const per100 = loss
    ? cents.map((c) => Math.round((c * 10_000) / b.netSalesCents))
    : apportion(cents, 10_000);
  const widths = apportion(cents, 10_000).map((w) => w / 100);
  return {
    segments: parts.map((p, i) => ({
      key: p.key,
      label: p.label,
      color: p.color,
      cents: cents[i]!,
      per100Cents: per100[i]!,
      widthPct: widths[i]!,
    })),
    loss,
    lossPer100Cents: loss ? Math.round((-b.profitCents * 10_000) / b.netSalesCents) : 0,
  };
}

export interface WaterfallStep {
  label: string;
  kind: 'total' | 'cost' | 'result';
  /** [low, high] of the floating bar, in cents. */
  range: [number, number];
}

/** Net sales stepping down through each cost to the money left; a loss is drawn below zero. */
export function waterfallSteps(b: Breakdown): WaterfallStep[] {
  const steps: WaterfallStep[] = [{ label: 'Net sales', kind: 'total', range: [0, b.netSalesCents] }];
  let running = b.netSalesCents;
  for (const [label, cents] of [
    ['Cost of goods', b.cogsCents],
    ['Fulfillment', b.fulfillmentCents],
    ['Fees', b.feesCents],
    ['Ads', b.adSpendCents],
  ] as const) {
    const after = running - cents;
    steps.push({ label, kind: 'cost', range: [Math.min(running, after), Math.max(running, after)] });
    running = after;
  }
  steps.push({
    label: 'Money left',
    kind: 'result',
    range: [Math.min(0, b.profitCents), Math.max(0, b.profitCents)],
  });
  return steps;
}

/** Bar widths against the largest absolute value, with a floor so a small value is still visible. */
export function barScale(values: number[]): { widthPct: number; negative: boolean }[] {
  const max = Math.max(0, ...values.map((v) => Math.abs(v)));
  return values.map((v) => ({
    widthPct: max === 0 || v === 0 ? 0 : Math.max(2, (Math.abs(v) / max) * 100),
    negative: v < 0,
  }));
}
