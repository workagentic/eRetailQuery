/**
 * Stock photos standing in for ad creatives (Pexels, free to use). The photo follows what the campaign
 * name says; unknown campaigns get one per platform. Real creatives replace these when ad accounts connect.
 */
const BY_KEYWORD: [RegExp, number][] = [
  [/prospect/i, 7625042],
  [/retarget/i, 6567541],
  [/lookalike/i, 5868127],
  [/shopping/i, 6956903],
  [/performance|pmax/i, 6214472],
  [/brand search/i, 38886679],
  [/sponsored brands/i, 7857532],
  [/sponsored products/i, 4440800],
];
const BY_PLATFORM: Record<string, number> = {
  meta: 5868127,
  google: 6214472,
  amazon_ads: 4440800,
  tiktok: 7625042,
};

export function adPhoto(name: string, platform: string): number {
  return BY_KEYWORD.find(([re]) => re.test(name))?.[1] ?? BY_PLATFORM[platform] ?? 6956903;
}
