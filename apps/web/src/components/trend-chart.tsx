'use client';

import { Area, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { COLORS, dollars, dollarsExact } from '@/lib/chart-colors';

export interface TrendPoint {
  date: string;
  revenue: number;
  profit: number;
}

const shortDate = (d: string) => {
  const [, m, day] = d.split('-');
  return `${Number(m)}/${Number(day)}`;
};

/** Daily revenue (area) and money left after ads (line). Values arrive in cents. */
export function TrendChart({ data }: { data: TrendPoint[] }) {
  const totalRevenue = data.reduce((a, d) => a + d.revenue, 0);
  const totalProfit = data.reduce((a, d) => a + d.profit, 0);
  return (
    <figure
      className="m-0"
      aria-label={`Daily revenue and money left after ads. Revenue totals ${dollars(totalRevenue)}, money left totals ${dollars(totalProfit)}.`}
    >
      <div className="h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="revFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={COLORS.teal} stopOpacity={0.28} />
                <stop offset="100%" stopColor={COLORS.teal} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={COLORS.grid} vertical={false} />
            <XAxis dataKey="date" tickFormatter={shortDate} minTickGap={28} stroke={COLORS.axis} fontSize={12} tickLine={false} axisLine={{ stroke: COLORS.grid }} />
            <YAxis tickFormatter={(v: number) => dollars(v)} width={64} stroke={COLORS.axis} fontSize={12} tickLine={false} axisLine={false} />
            <Tooltip
              labelFormatter={(d: string) => d}
              formatter={(v: number, name: string) => [dollarsExact(v), name]}
              contentStyle={{ borderRadius: 10, border: `1px solid ${COLORS.grid}`, boxShadow: '0 6px 20px rgb(15 31 42 / 0.12)', fontSize: 13 }}
            />
            <Legend iconType="circle" wrapperStyle={{ fontSize: 13, paddingTop: 8 }} />
            <Area type="monotone" dataKey="revenue" name="Revenue" stroke={COLORS.teal} strokeWidth={2} fill="url(#revFill)" isAnimationActive={false} />
            <Line type="monotone" dataKey="profit" name="Money left after ads" stroke={COLORS.ink} strokeWidth={2} dot={false} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
