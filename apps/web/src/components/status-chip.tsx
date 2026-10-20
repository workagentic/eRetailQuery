export type StatusCode =
  | 'underpriced'
  | 'healthy'
  | 'premium'
  | 'no_cost'
  | 'losing'
  | 'watch'
  | 'winning'
  | 'learning'
  | 'low'
  | 'overstock'
  | 'dead';

type Tone = 'bad' | 'good' | 'warn' | 'info' | 'neutral';
const TONE: Record<Tone, string> = {
  bad: 'bg-loss-soft text-loss',
  good: 'bg-profit-soft text-profit',
  warn: 'bg-warn-soft text-warn',
  info: 'bg-[#e0e9ff] text-[#1d4ed8]',
  neutral: 'bg-muted text-muted-foreground',
};

const CHIP: Record<StatusCode, { label: string; icon: string; tone: Tone }> = {
  underpriced: { label: 'Underpriced', icon: '▼', tone: 'bad' },
  healthy: { label: 'Healthy', icon: '✓', tone: 'good' },
  premium: { label: 'Premium', icon: '▲', tone: 'info' },
  no_cost: { label: 'Needs cost', icon: '?', tone: 'neutral' },
  losing: { label: 'Losing money', icon: '▼', tone: 'bad' },
  watch: { label: 'Watch', icon: '!', tone: 'warn' },
  winning: { label: 'Winning', icon: '▲', tone: 'good' },
  learning: { label: 'Learning', icon: '…', tone: 'neutral' },
  low: { label: 'Running low', icon: '!', tone: 'bad' },
  overstock: { label: 'Overstocked', icon: '!', tone: 'warn' },
  dead: { label: 'Dead stock', icon: '○', tone: 'neutral' },
};

/** A status in words plus an icon, so it never depends on colour alone. */
export function StatusChip({ status }: { status: StatusCode }) {
  const c = CHIP[status];
  return (
    <span
      className={`inline-flex w-fit items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ${TONE[c.tone]}`}
    >
      <span aria-hidden="true">{c.icon}</span>
      {c.label}
    </span>
  );
}
