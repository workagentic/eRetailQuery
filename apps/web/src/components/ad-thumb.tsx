import { adPhoto } from '@/lib/ad-art';
import { photoUrl } from '@/lib/product-art';
import { PhotoTile } from './photo-tile';
import { PlatformBadge } from './platform-badge';

const SIZE = { sm: 'size-10 rounded-lg', md: 'size-12 rounded-xl' } as const;
const PIXELS = { sm: 88, md: 112 } as const;

/** The campaign's creative (a stock photo for now) with its platform badge in the corner. */
export function AdThumb({
  name,
  platform,
  size = 'md',
}: {
  name: string;
  platform: string;
  size?: keyof typeof SIZE;
}) {
  return (
    <span className="relative inline-block shrink-0">
      <PhotoTile
        src={photoUrl(adPhoto(name, platform), PIXELS[size])}
        className={`${SIZE[size]} bg-muted`}
        fallback={<PlatformBadge platform={platform} size={size === 'sm' ? 'sm' : 'md'} />}
      />
      <span className="absolute -bottom-1 -right-1 rounded-md ring-2 ring-surface">
        <PlatformBadge platform={platform} size="sm" />
      </span>
    </span>
  );
}
