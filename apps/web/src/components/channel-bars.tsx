'use client';

import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { COLORS, dollars, dollarsExact } from '@/lib/chart-colors';

export interface ChannelPoint {
  name: string;
  revenue: number;
  profit: number;
}

/** Revenue next to money left after ads, one group per sales channel. Values in cents. */
export function ChannelBars({ data }: { data: ChannelPoint[] }) {
  return (
    <figure className="m-0" aria-label={data.map((d) => `${d.name}: revenue ${dollars(d.revenue)}, money left ${dollars(d.profit)}`).join('. ')}>
      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barGap={4} barCategoryGap="28%">
            <CartesianGrid stroke={COLORS.grid} vertical={false} />
            <XAxis dataKey="name" stroke={COLORS.axis} fontSize={13} tickLine={false} axisLine={{ stroke: COLORS.grid }} />
            <YAxis tickFormatter={(v: number) => dollars(v)} width={64} stroke={COLORS.axis} fontSize={12} tickLine={false} axisLine={false} />
            <Tooltip
              formatter={(v: number, name: string) => [dollarsExact(v), name]}
              cursor={{ fill: 'rgb(15 31 42 / 0.04)' }}
              contentStyle={{ borderRadius: 10, border: `1px solid ${COLORS.grid}`, boxShadow: '0 6px 20px rgb(15 31 42 / 0.12)', fontSize: 13 }}
            />
            <Legend iconType="circle" wrapperStyle={{ fontSize: 13, paddingTop: 8 }} />
            <Bar dataKey="revenue" name="Revenue" fill={COLORS.teal} radius={[4, 4, 0, 0]} isAnimationActive={false} />
            <Bar dataKey="profit" name="Money left after ads" fill={COLORS.ink} radius={[4, 4, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
