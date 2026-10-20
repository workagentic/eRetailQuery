'use client';

import { Bar, BarChart, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { COLORS, dollars, dollarsExact } from '@/lib/chart-colors';

const tooltipStyle = {
  borderRadius: 10,
  border: `1px solid ${COLORS.grid}`,
  boxShadow: '0 6px 20px rgb(15 31 42 / 0.12)',
  fontSize: 13,
};
const shortDate = (d: string) => {
  const [, m, day] = d.split('-');
  return `${Number(m)}/${Number(day)}`;
};

export interface AdsDayPoint {
  date: string;
  spend: number;
  platformSales: number;
}

/** What you spent on ads each day against what the platforms say they sold. Values in cents. */
export function AdsTrendChart({ data }: { data: AdsDayPoint[] }) {
  return (
    <figure
      className="m-0"
      aria-label={`Daily ad spend and platform-reported sales. Spend totals ${dollars(data.reduce((a, d) => a + d.spend, 0))}.`}
    >
      <div className="h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={COLORS.grid} vertical={false} />
            <XAxis dataKey="date" tickFormatter={shortDate} minTickGap={28} stroke={COLORS.axis} fontSize={12} tickLine={false} axisLine={{ stroke: COLORS.grid }} />
            <YAxis tickFormatter={(v: number) => dollars(v)} width={64} stroke={COLORS.axis} fontSize={12} tickLine={false} axisLine={false} />
            <Tooltip formatter={(v: number, name: string) => [dollarsExact(v), name]} contentStyle={tooltipStyle} />
            <Legend iconType="circle" wrapperStyle={{ fontSize: 13, paddingTop: 8 }} />
            <Bar dataKey="spend" name="Ad spend" fill={COLORS.blue} radius={[3, 3, 0, 0]} maxBarSize={14} isAnimationActive={false} />
            <Line type="monotone" dataKey="platformSales" name="Sales the platforms claim" stroke={COLORS.amber} strokeWidth={2} dot={false} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

export interface PlatformPoint {
  name: string;
  spend: number;
  platformSales: number;
}

/** Spend and claimed sales for each ad platform, side by side. Values in cents. */
export function PlatformBars({ data }: { data: PlatformPoint[] }) {
  return (
    <figure className="m-0" aria-label={data.map((d) => `${d.name}: spend ${dollars(d.spend)}, claimed sales ${dollars(d.platformSales)}`).join('. ')}>
      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barGap={4} barCategoryGap="28%">
            <CartesianGrid stroke={COLORS.grid} vertical={false} />
            <XAxis dataKey="name" stroke={COLORS.axis} fontSize={13} tickLine={false} axisLine={{ stroke: COLORS.grid }} />
            <YAxis tickFormatter={(v: number) => dollars(v)} width={64} stroke={COLORS.axis} fontSize={12} tickLine={false} axisLine={false} />
            <Tooltip formatter={(v: number, name: string) => [dollarsExact(v), name]} cursor={{ fill: 'rgb(15 31 42 / 0.04)' }} contentStyle={tooltipStyle} />
            <Legend iconType="circle" wrapperStyle={{ fontSize: 13, paddingTop: 8 }} />
            <Bar dataKey="spend" name="Ad spend" fill={COLORS.blue} radius={[4, 4, 0, 0]} isAnimationActive={false} />
            <Bar dataKey="platformSales" name="Sales the platforms claim" fill={COLORS.amber} radius={[4, 4, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
