import type { ChannelFilter, RangePreset } from '@erq/db';
import Link from 'next/link';
import { CHANNEL_LABEL, PRESET_LABEL, type Filters } from '@/lib/filters';

const link = (
  path: string,
  query: Record<string, string>,
  preset: RangePreset,
  channel: ChannelFilter,
) => `${path}?${new URLSearchParams({ ...query, range: preset, channel }).toString()}`;

function Segment({ children }: { children: React.ReactNode }) {
  return <div className="inline-flex flex-wrap gap-1 rounded-xl bg-muted p-1">{children}</div>;
}

function Chip({ href, active, children }: { href: string; active: boolean; children: string }) {
  return (
    <Link
      href={href}
      aria-current={active ? 'true' : undefined}
      className={`rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors ${
        active
          ? 'bg-surface text-foreground shadow-[0_1px_2px_rgb(15_31_42/0.12)]'
          : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      {children}
    </Link>
  );
}

/** Date range and channel filters as plain links, so the state lives in the URL. */
export function FilterBar({
  path,
  query = {},
  filters,
  showRange = true,
  showChannel = true,
}: {
  path: string;
  /** Extra query params to keep on every link, such as the selected month. */
  query?: Record<string, string>;
  filters: Filters;
  showRange?: boolean;
  showChannel?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2" aria-label="Filters" role="group">
      {showRange && (
        <Segment>
          {(Object.keys(PRESET_LABEL) as RangePreset[]).map((p) => (
            <Chip key={p} href={link(path, query, p, filters.channel)} active={p === filters.preset}>
              {PRESET_LABEL[p]}
            </Chip>
          ))}
        </Segment>
      )}
      {showChannel && (
        <Segment>
          {(Object.keys(CHANNEL_LABEL) as ChannelFilter[]).map((c) => (
            <Chip key={c} href={link(path, query, filters.preset, c)} active={c === filters.channel}>
              {CHANNEL_LABEL[c]}
            </Chip>
          ))}
        </Segment>
      )}
    </div>
  );
}
