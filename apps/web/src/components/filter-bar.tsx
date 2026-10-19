import type { ChannelFilter, RangePreset } from '@erq/db';
import Link from 'next/link';
import { CHANNEL_LABEL, PRESET_LABEL, type Filters } from '@/lib/filters';

const link = (path: string, preset: RangePreset, channel: ChannelFilter) =>
  `${path}?range=${preset}&channel=${channel}`;

function Chip({ href, active, children }: { href: string; active: boolean; children: string }) {
  return (
    <Link
      href={href}
      aria-current={active ? 'true' : undefined}
      className={`rounded-md border px-3 py-1 text-sm ${active ? 'border-foreground bg-foreground text-background' : 'border-border'}`}
    >
      {children}
    </Link>
  );
}

/** Date range and channel filters as plain links, so the state lives in the URL. */
export function FilterBar({
  path,
  filters,
  showRange = true,
}: {
  path: string;
  filters: Filters;
  showRange?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2" aria-label="Filters" role="group">
      {showRange && (
        <div className="flex flex-wrap gap-2">
          {(Object.keys(PRESET_LABEL) as RangePreset[]).map((p) => (
            <Chip key={p} href={link(path, p, filters.channel)} active={p === filters.preset}>
              {PRESET_LABEL[p]}
            </Chip>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {(Object.keys(CHANNEL_LABEL) as ChannelFilter[]).map((c) => (
          <Chip key={c} href={link(path, filters.preset, c)} active={c === filters.channel}>
            {CHANNEL_LABEL[c]}
          </Chip>
        ))}
      </div>
    </div>
  );
}
