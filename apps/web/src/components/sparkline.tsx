'use client';

import { Area, AreaChart } from 'recharts';

/** A tiny trend line for a KPI card. Fixed size, so it also renders on the server. */
export function Sparkline({
  values,
  color,
  id,
}: {
  values: number[];
  color: string;
  id: string;
}) {
  const data = values.map((v, i) => ({ i, v }));
  return (
    <AreaChart width={112} height={36} data={data} margin={{ top: 3, right: 0, bottom: 3, left: 0 }} aria-hidden="true">
      <defs>
        <linearGradient id={`spark-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.3} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <Area type="monotone" dataKey="v" stroke={color} strokeWidth={1.75} fill={`url(#spark-${id})`} isAnimationActive={false} dot={false} />
    </AreaChart>
  );
}
