export type ArtIcon =
  | 'shirt'
  | 'lamp'
  | 'sparkles'
  | 'tent'
  | 'cooking-pot'
  | 'paw-print'
  | 'dumbbell'
  | 'toy-brick'
  | 'package';

export interface ProductArt {
  icon: ArtIcon;
  /** Gradient start and end (light tints) and the ink colour for the icon. */
  from: string;
  to: string;
  ink: string;
}

const ART: Record<string, ProductArt> = {
  apparel: { icon: 'shirt', from: '#e0f2fe', to: '#bae6fd', ink: '#0369a1' },
  home: { icon: 'lamp', from: '#fef3c7', to: '#fde68a', ink: '#b45309' },
  beauty: { icon: 'sparkles', from: '#fce7f3', to: '#fbcfe8', ink: '#be185d' },
  outdoor: { icon: 'tent', from: '#dcfce7', to: '#bbf7d0', ink: '#15803d' },
  kitchen: { icon: 'cooking-pot', from: '#ffedd5', to: '#fed7aa', ink: '#c2410c' },
  pets: { icon: 'paw-print', from: '#ede9fe', to: '#ddd6fe', ink: '#6d28d9' },
  fitness: { icon: 'dumbbell', from: '#ccfbf1', to: '#99f6e4', ink: '#0f766e' },
  toys: { icon: 'toy-brick', from: '#fee2e2', to: '#fecaca', ink: '#b91c1c' },
};
const FALLBACK: ProductArt = { icon: 'package', from: '#e2e8f0', to: '#cbd5e1', ink: '#475569' };

/** Stand-in artwork per product category, until real product photos are synced from a store. */
export function productArt(category: string | null): ProductArt {
  return (category && ART[category.trim().toLowerCase()]) || FALLBACK;
}

/**
 * Stock photos (Pexels, free to use, no attribution required: https://www.pexels.com/license/), keyed by
 * product category. Each id was checked to resolve as a JPEG. Real product photos replace these once images
 * are synced from a store.
 */
const PHOTOS: Record<string, number[]> = {
  apparel: [8408556, 3998648, 8159428],
  home: [2082092, 3852632, 17994860],
  beauty: [16008945, 39392892, 7691161],
  outdoor: [31443014, 6271630, 6324492],
  kitchen: [12156176, 29462835, 18789103],
  pets: [7282664, 3981763, 8434633],
  fitness: [8032748, 6740821],
  toys: [7269694, 3975598],
};

export function photoUrl(id: number, size: number): string {
  return `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?auto=compress&cs=tinysrgb&w=${size}&h=${size}&fit=crop`;
}

function hash(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h;
}

/** A stable stock photo id for a product, varied by `seed` (its title) within the category. Null when unknown. */
export function productPhoto(category: string | null, seed: string): number | null {
  const list = category ? PHOTOS[category.trim().toLowerCase()] : undefined;
  return list ? list[hash(seed) % list.length]! : null;
}
