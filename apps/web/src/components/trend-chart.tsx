'use client';

import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

export interface TrendPoint {
  date: string;
  revenue: number;
  profit: number;
}

const dollars = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(
    cents / 100,
  );

/** Daily revenue (area) and money left after ads (line). Values arrive in cents. */
export function TrendChart({ data }: { data: TrendPoint[] }) {
  const totalRevenue = data.reduce((a, d) => a + d.revenue, 0);
  const totalProfit = data.reduce((a, d) => a + d.profit, 0);
  return (
    <figure
      className="m-0"
      aria-label={`Daily revenue and profit. Revenue totals ${dollars(totalRevenue)}, money left after ads totals ${dollars(totalProfit)}.`}
    >
      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="date"
              tickFormatter={(d: string) => d.slice(5)}
              minTickGap={24}
              stroke="var(--color-muted-foreground)"
              fontSize={12}
            />
            <YAxis
              tickFormatter={(v: number) => dollars(v)}
              width={64}
              stroke="var(--color-muted-foreground)"
              fontSize={12}
            />
            <Tooltip
              formatter={(v: number) => dollars(v)}
              contentStyle={{
                background: 'var(--color-background)',
                border: '1px solid var(--color-border)',
                color: 'var(--color-foreground)',
              }}
            />
            <Legend />
            <Area
              type="monotone"
              dataKey="revenue"
              name="Revenue"
              stroke="var(--color-chart-1)"
              fill="var(--color-chart-1)"
              fillOpacity={0.15}
              strokeWidth={2}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="profit"
              name="Money left after ads"
              stroke="var(--color-chart-2)"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
