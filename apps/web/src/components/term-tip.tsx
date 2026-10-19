import type { ReactNode } from 'react';

/** Plain-English definitions for financial terms (CLAUDE.md principle 3). */
export const TERMS = {
  cogs: 'Cost of goods (COGS): what it cost to get the units you sold into sellable shape, including product, freight, duties and packaging.',
  contribution:
    'Money left after fees (contribution margin): sales minus cost of goods, shipping and payment or marketplace fees, before ad spend.',
  afterAds:
    'Money left after ads (net contribution after marketing): contribution margin minus ad spend.',
  roas: 'ROAS (return on ad spend): sales an ad platform says an ad produced, divided by what you spent on it. Platforms can overlap and over-claim.',
  blendedRoas:
    'Blended ROAS (MER): all your sales divided by all your ad spend across platforms. It is not reported by the ad platforms, so it is the honest overall number.',
  breakEvenRoas:
    'Break-even ROAS: the return an ad needs just to pay for itself, 1 divided by your contribution margin before ads. Below this an ad loses money.',
  markup: 'Markup: (price - cost) / cost. A 50% markup is a 33.3% margin.',
  margin: 'Margin: (price - cost) / price. A 33.3% margin is a 50% markup.',
  daysOfCover: 'Days of cover: how many days your stock lasts at the current sales pace.',
} as const;
export type TermKey = keyof typeof TERMS;

export function TermTip({ term, children }: { term: TermKey; children: ReactNode }) {
  return (
    <span
      title={TERMS[term]}
      tabIndex={0}
      className="cursor-help underline decoration-dotted underline-offset-4"
    >
      {children}
    </span>
  );
}
