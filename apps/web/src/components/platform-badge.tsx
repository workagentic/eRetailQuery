import { PLATFORM_COLOR, PLATFORM_NAME } from '@/lib/chart-colors';

/** A coloured initial standing in for the ad platform's logo. Colours match the charts. */
export function PlatformBadge({ platform, size = 'md' }: { platform: string; size?: 'sm' | 'md' }) {
  const color = PLATFORM_COLOR[platform] ?? '#64748b';
  const name = PLATFORM_NAME[platform] ?? platform;
  return (
    <span
      aria-hidden="true"
      title={name}
      className={`grid shrink-0 place-items-center font-semibold text-white ${size === 'sm' ? 'size-7 rounded-lg text-xs' : 'size-9 rounded-xl text-sm'}`}
      style={{ background: color }}
    >
      {name.charAt(0)}
    </span>
  );
}
