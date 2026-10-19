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

const CHIP: Record<StatusCode, { label: string; icon: string; bad?: boolean }> = {
  underpriced: { label: 'Underpriced', icon: '▼', bad: true },
  healthy: { label: 'Healthy', icon: '✓' },
  premium: { label: 'Premium', icon: '▲' },
  no_cost: { label: 'Needs cost', icon: '?' },
  losing: { label: 'Losing money', icon: '▼', bad: true },
  watch: { label: 'Watch', icon: '!' },
  winning: { label: 'Winning', icon: '▲' },
  learning: { label: 'Learning', icon: '…' },
  low: { label: 'Running low', icon: '!', bad: true },
  overstock: { label: 'Overstocked', icon: '!' },
  dead: { label: 'Dead stock', icon: '○' },
};

/** A status in words plus an icon, so it never depends on colour alone. */
export function StatusChip({ status }: { status: StatusCode }) {
  const c = CHIP[status];
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 py-0.5 text-xs font-medium ${c.bad ? 'border-destructive text-destructive' : 'border-border'}`}
    >
      <span aria-hidden="true">{c.icon}</span>
      {c.label}
    </span>
  );
}
