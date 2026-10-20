/**
 * Series colours. Hex values, not CSS variables: they go into SVG props where a missing variable draws nothing.
 * The four categorical colours passed the dataviz palette validator (lightness, chroma, colour-blind separation,
 * contrast), so a series keeps its colour wherever it appears: Meta is always blue, Amazon always amber.
 */
export const COLORS = {
  teal: '#0d9488',
  blue: '#2563eb',
  amber: '#d97706',
  violet: '#7c3aed',
  green: '#15803d',
  red: '#b91c1c',
  grid: '#e6ebf1',
  axis: '#64748b',
  ink: '#0f172a',
} as const;

export const CHANNEL_COLOR: Record<string, string> = {
  shopify_online: COLORS.teal,
  shopify_pos: COLORS.blue,
  amazon: COLORS.amber,
};
export const CHANNEL_NAME: Record<string, string> = {
  shopify_online: 'Shopify',
  shopify_pos: 'Shopify POS',
  amazon: 'Amazon',
};
export const PLATFORM_COLOR: Record<string, string> = {
  meta: COLORS.blue,
  google: COLORS.violet,
  tiktok: COLORS.teal,
  amazon_ads: COLORS.amber,
};
export const PLATFORM_NAME: Record<string, string> = {
  meta: 'Meta',
  google: 'Google',
  tiktok: 'TikTok',
  amazon_ads: 'Amazon Ads',
};

export const dollars = (cents: number): string =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(
    cents / 100,
  );
export const dollarsExact = (cents: number): string =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(
    cents / 100,
  );
