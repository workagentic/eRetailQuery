import type { ReactNode } from 'react';

export interface BarItem {
  key: string;
  label: ReactNode;
  sublabel?: ReactNode;
  /** Artwork shown before the label (a product thumbnail or platform badge). */
  lead?: ReactNode;
  value: number;
  valueLabel: string;
  color?: string;
  /** A tick on the same scale as `value`, for example the break-even ROAS. */
  marker?: number | null;
  markerLabel?: string;
}

/** Horizontal bars, one row each. Negative values grow in red. Server-rendered, no chart library. */
export function BarList({
  items,
  positiveColor = '#0d9488',
  empty,
}: {
  items: BarItem[];
  positiveColor?: string;
  empty: ReactNode;
}) {
  if (items.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  const max = Math.max(
    1e-9,
    ...items.flatMap((i) => [Math.abs(i.value), i.marker ?? 0]),
  );
  return (
    <ul className="flex flex-col gap-3.5">
      {items.map((i) => {
        const width = Math.max(i.value === 0 ? 0 : 2, (Math.abs(i.value) / max) * 100);
        const color = i.value < 0 ? '#b91c1c' : (i.color ?? positiveColor);
        return (
          <li key={i.key} className="flex items-center gap-3">
            {i.lead}
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-foreground">{i.label}</div>
                  {i.sublabel && <div className="truncate text-xs text-muted-foreground">{i.sublabel}</div>}
                </div>
                <div className="shrink-0 text-sm font-semibold tabular">{i.valueLabel}</div>
              </div>
              <div className="relative h-2 rounded-full bg-muted" role="img" aria-label={`${i.valueLabel}`}>
                <div className="h-2 rounded-full" style={{ width: `${width}%`, background: color }} />
                {i.marker != null && i.marker > 0 && (
                  <span
                    title={i.markerLabel}
                    className="absolute -top-1 h-4 w-0.5 rounded bg-foreground/70"
                    style={{ left: `${Math.min(100, (i.marker / max) * 100)}%` }}
                  />
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
