import { CookingPot, Dumbbell, Lamp, Package, PawPrint, Shirt, Sparkles, Tent, ToyBrick, type LucideIcon } from 'lucide-react';
import { productArt, type ArtIcon } from '@/lib/product-art';

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

/** Category artwork standing in for a product photo (real photos arrive with the store sync). */
export function ProductThumb({
  category,
  size = 'md',
}: {
  category: string | null;
  size?: keyof typeof SIZE;
}) {
  const art = productArt(category);
  const Icon = ICONS[art.icon];
  return (
    <span
      aria-hidden="true"
      className={`relative grid shrink-0 place-items-center overflow-hidden ${SIZE[size]}`}
      style={{ background: `linear-gradient(135deg, ${art.from}, ${art.to})`, color: art.ink }}
    >
      <span
        className="absolute -right-2 -top-2 size-1/2 rounded-full opacity-40"
        style={{ background: art.to }}
      />
      <Icon className={`relative ${ICON_SIZE[size]}`} strokeWidth={1.6} />
    </span>
  );
}
