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
