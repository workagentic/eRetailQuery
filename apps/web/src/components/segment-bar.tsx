export interface BarSegment {
  key: string;
  label: string;
  color: string;
  widthPct: number;
  valueLabel: string;
}

/**
 * One stacked bar with a legend underneath. Segments are separated by a 2px gap of surface colour,
 * and every segment is named in the legend with its value, so colour is never the only signal.
 */
export function SegmentBar({
  segments,
  height = 18,
}: {
  segments: BarSegment[];
  height?: number;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex w-full gap-0.5 overflow-hidden rounded-full" style={{ height }} role="img"
        aria-label={segments.map((s) => `${s.label} ${s.valueLabel}`).join(', ')}>
        {segments.map((s) => (
          <div key={s.key} style={{ width: `${s.widthPct}%`, background: s.color }} title={`${s.label}: ${s.valueLabel}`} />
        ))}
      </div>
      <ul className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3 lg:grid-cols-5">
        {segments.map((s) => (
          <li key={s.key} className="flex items-start gap-2">
            <span className="mt-1 size-2.5 shrink-0 rounded-sm" style={{ background: s.color }} aria-hidden="true" />
            <span className="flex flex-col">
              <span className="text-[13px] text-muted-foreground">{s.label}</span>
              <span className="text-sm font-semibold tabular">{s.valueLabel}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
