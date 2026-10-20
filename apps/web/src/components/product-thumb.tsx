import { CookingPot, Dumbbell, Lamp, Package, PawPrint, Shirt, Sparkles, Tent, ToyBrick, type LucideIcon } from 'lucide-react';
import { photoUrl, productArt, productPhoto, type ArtIcon } from '@/lib/product-art';
import { PhotoTile } from './photo-tile';

const ICONS: Record<ArtIcon, LucideIcon> = {
  shirt: Shirt,
  lamp: Lamp,
  sparkles: Sparkles,
  tent: Tent,
  'cooking-pot': CookingPot,
  'paw-print': PawPrint,
  dumbbell: Dumbbell,
  'toy-brick': ToyBrick,
  package: Package,
};
const SIZE = { sm: 'size-9 rounded-lg', md: 'size-12 rounded-xl', lg: 'size-16 rounded-2xl' } as const;
const ICON_SIZE = { sm: 'size-[18px]', md: 'size-6', lg: 'size-8' } as const;
const PIXELS = { sm: 80, md: 112, lg: 160 } as const;

function IconTile({ category, size }: { category: string | null; size: keyof typeof SIZE }) {
  const art = productArt(category);
  const Icon = ICONS[art.icon];
  return (
    <span
      aria-hidden="true"
      className={`relative grid shrink-0 place-items-center overflow-hidden ${SIZE[size]}`}
      style={{ background: `linear-gradient(135deg, ${art.from}, ${art.to})`, color: art.ink }}
    >
      <Icon className={`relative ${ICON_SIZE[size]}`} strokeWidth={1.6} />
    </span>
  );
}

/**
 * A stock photo for the product's category (varied by `seed`, normally the title). If the photo cannot load,
 * or the category is unknown, it falls back to category artwork.
 */
export function ProductThumb({
  category,
  seed = '',
  size = 'md',
}: {
  category: string | null;
  seed?: string;
  size?: keyof typeof SIZE;
}) {
  const id = productPhoto(category, seed);
  const fallback = <IconTile category={category} size={size} />;
  if (id === null) return fallback;
  return (
    <PhotoTile
      src={photoUrl(id, PIXELS[size])}
      className={`${SIZE[size]} bg-muted`}
      fallback={fallback}
    />
  );
}
