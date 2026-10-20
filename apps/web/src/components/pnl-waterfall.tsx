'use client';

import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { COLORS, dollars, dollarsExact } from '@/lib/chart-colors';
import type { Breakdown } from '@/lib/chart-data';
import { waterfallSteps } from '@/lib/chart-data';

const FILL = { total: COLORS.teal, cost: '#94a3b8', result: COLORS.green } as const;

/** Net sales stepping down through each cost to the money left. Values in cents. */
export function PnlWaterfall({ breakdown }: { breakdown: Breakdown }) {
  const steps = waterfallSteps(breakdown).map((s) => ({
    ...s,
    amount: s.range[1] - s.range[0],
    fill: s.kind === 'result' && breakdown.profitCents < 0 ? COLORS.red : FILL[s.kind],
  }));
  return (
    <figure
      className="m-0"
      aria-label={`From net sales of ${dollars(breakdown.netSalesCents)} to ${dollars(breakdown.profitCents)} left after costs and ads.`}
    >
      <div className="h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={steps} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="22%">
            <CartesianGrid stroke={COLORS.grid} vertical={false} />
            <XAxis dataKey="label" stroke={COLORS.axis} fontSize={12} tickLine={false} axisLine={{ stroke: COLORS.grid }} />
            <YAxis tickFormatter={(v: number) => dollars(v)} width={68} stroke={COLORS.axis} fontSize={12} tickLine={false} axisLine={false} />
            <ReferenceLine y={0} stroke={COLORS.axis} />
            <Tooltip
              cursor={{ fill: 'rgb(15 31 42 / 0.04)' }}
              formatter={(_v: unknown, _n: string, item: { payload?: { amount: number; kind: string } }) => [
                dollarsExact(item.payload?.amount ?? 0),
                item.payload?.kind === 'cost' ? 'Spent' : 'Amount',
              ]}
              contentStyle={{ borderRadius: 10, border: `1px solid ${COLORS.grid}`, boxShadow: '0 6px 20px rgb(15 31 42 / 0.12)', fontSize: 13 }}
            />
            <Bar dataKey="range" radius={[4, 4, 4, 4]} isAnimationActive={false}>
              {steps.map((s) => (
                <Cell key={s.label} fill={s.fill} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
